# 合成データの絵に、アプリと同じ点の推定をかける（MediaPipe Pose Landmarker heavy → RTMPose で 2D の点を細かくする）。
# クリップごとに mp_rtm.json を書く（形は detect_dataset.py の mp.json と同じ）。アプリ（src/pose/rtmMerge.ts）と同じ決まりで点を置き換える:
# 切り抜きは MediaPipe の点の範囲を 1.25 倍・縦横比 192:256、点数 0.3 未満の点は置き換えない、Halpe にない点は近くの点と同じだけ動かす。
#
# 使い方（Python 版の MediaPipe と onnxruntime を入れた環境で）:
#   python tools/view3d/detect_dataset_rtm.py データのフォルダ RTMPose のモデル（end2end.onnx）
import json
import os
import sys
import types

for _n in ('matplotlib', 'matplotlib.pyplot'):
    sys.modules.setdefault(_n, types.ModuleType(_n))

import cv2  # noqa: E402
import mediapipe as mp  # noqa: E402
import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from mediapipe.tasks.python import BaseOptions, vision  # noqa: E402

ROOT = os.path.abspath(sys.argv[1])
RTM = sys.argv[2]
MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'models', 'pose_landmarker_heavy.task')
OUT_NAME = 'mp_rtm.json'

W_IN, H_IN = 192, 256
MEAN = np.array([123.675, 116.28, 103.53], np.float32)
STD = np.array([58.395, 57.12, 57.375], np.float32)
MP_FROM_HALPE = [(0, 0), (2, 1), (5, 2), (7, 3), (8, 4), (11, 5), (12, 6), (13, 7), (14, 8), (15, 9), (16, 10), (23, 11), (24, 12), (25, 13), (26, 14), (27, 15), (28, 16), (29, 24), (30, 25), (31, 20), (32, 21)]
FOLLOW = [(1, 2), (3, 2), (4, 5), (6, 5), (9, 0), (10, 0), (17, 15), (19, 15), (21, 15), (18, 16), (20, 16), (22, 16)]
MIN_SCORE = 0.3

sess = ort.InferenceSession(RTM, providers=['CPUExecutionProvider'])
lm = vision.PoseLandmarker.create_from_options(
    vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_buffer=open(MODEL, 'rb').read()),
        running_mode=vision.RunningMode.IMAGE,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
)


def refine(img, pts):
    """pts: 33 × [x(0..1), y(0..1), 見えている度合い]。置き換えた点を返す"""
    h, w = img.shape[:2]
    xs = [pts[m][0] * w for m, _ in MP_FROM_HALPE]
    ys = [pts[m][1] * h for m, _ in MP_FROM_HALPE]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    if not (x1 > x0 and y1 > y0):
        return pts
    cw, ch = (x1 - x0) * 1.25, (y1 - y0) * 1.25
    if cw * H_IN > ch * W_IN:
        ch = cw * H_IN / W_IN
    else:
        cw = ch * W_IN / H_IN
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    src = np.float32([[cx - cw / 2, cy - ch / 2], [cx + cw / 2, cy - ch / 2], [cx - cw / 2, cy + ch / 2]])
    M = cv2.getAffineTransform(src, np.float32([[0, 0], [W_IN, 0], [0, H_IN]]))
    crop = cv2.warpAffine(img, M, (W_IN, H_IN), flags=cv2.INTER_LINEAR)
    x = (cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) - MEAN) / STD
    sx, sy = sess.run(None, {'input': x.transpose(2, 0, 1)[None]})
    px, py = sx[0].argmax(1) / 2.0, sy[0].argmax(1) / 2.0
    score = np.minimum(sx[0].max(1), sy[0].max(1))
    out = [list(p) for p in pts]
    delta = {}
    for m, k in MP_FROM_HALPE:
        if score[k] < MIN_SCORE:
            continue
        nx = (cx - cw / 2 + px[k] * cw / W_IN) / w
        ny = (cy - ch / 2 + py[k] * ch / H_IN) / h
        delta[m] = (nx - out[m][0], ny - out[m][1])
        out[m][0], out[m][1] = nx, ny
    for m, base in FOLLOW:
        if base in delta:
            out[m][0] += delta[base][0]
            out[m][1] += delta[base][1]
    return [[round(p[0], 5), round(p[1], 5), p[2]] for p in out]


done = 0
for name in sorted(os.listdir(ROOT)):
    d = os.path.join(ROOT, name)
    if not os.path.isdir(d) or not os.path.exists(os.path.join(d, 'clip.json')) or os.path.exists(os.path.join(d, OUT_NAME)):
        continue
    meta = json.load(open(os.path.join(d, 'clip.json'), encoding='utf-8'))
    out = []
    width = height = 0
    for k in range(len(meta['frames'])):
        img = cv2.imread(os.path.join(d, f'{k:04d}.jpg'))
        height, width = img.shape[:2]
        r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)))
        if not r.pose_landmarks:
            out.append(None)
            continue
        p = [[q.x, q.y, round(min(q.visibility or 0, q.presence if q.presence is not None else 1), 3)] for q in r.pose_landmarks[0]]
        w = [[round(q.x, 4), round(q.y, 4), round(q.z, 4)] for q in r.pose_world_landmarks[0]] if r.pose_world_landmarks else None
        out.append({'p': refine(img, p), 'w': w})
    with open(os.path.join(d, OUT_NAME), 'w', encoding='utf-8') as fh:
        json.dump({'width': width, 'height': height, 'frames': out}, fh)
    done += 1
    if done % 50 == 0:
        print('detected', done, flush=True)
print('done', done)
