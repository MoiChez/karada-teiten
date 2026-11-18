# 合成データ（tools/blender/make_view_dataset.py で作ったクリップ）の絵に、アプリと同じ推定モデル（MediaPipe Pose Landmarker heavy）を
# かけて、推定の点をクリップごとに mp.json に書く。アプリと同じく 1 枚ずつ（IMAGE モード）推定する。
#
# 使い方（Python 版の MediaPipe を入れた環境で）:
#   python tools/view3d/detect_dataset.py データのフォルダ
# すでに mp.json があるクリップと、まだ clip.json がない（作っている途中の）クリップは飛ばす
import json
import os
import sys
import types

# 推定には使わない描画の部品が matplotlib を読み込むので、空の部品で置き換える
for _n in ('matplotlib', 'matplotlib.pyplot'):
    sys.modules.setdefault(_n, types.ModuleType(_n))

import mediapipe as mp  # noqa: E402
from mediapipe.tasks.python import BaseOptions, vision  # noqa: E402

ROOT = os.path.abspath(sys.argv[1])
MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'models', 'pose_landmarker_heavy.task')

options = vision.PoseLandmarkerOptions(
    # 中の C の部品は、日本語を含むパスのファイルを開けないので、読み込んだ中身を渡す
    base_options=BaseOptions(model_asset_buffer=open(MODEL, 'rb').read()),
    running_mode=vision.RunningMode.IMAGE,
    num_poses=1,
    min_pose_detection_confidence=0.5,
    min_pose_presence_confidence=0.5,
    min_tracking_confidence=0.5,
)

done = 0
with vision.PoseLandmarker.create_from_options(options) as lm:
    for name in sorted(os.listdir(ROOT)):
        d = os.path.join(ROOT, name)
        if not os.path.isdir(d) or not os.path.exists(os.path.join(d, 'clip.json')) or os.path.exists(os.path.join(d, 'mp.json')):
            continue
        meta = json.load(open(os.path.join(d, 'clip.json'), encoding='utf-8'))
        out = []
        for k in range(len(meta['frames'])):
            img = mp.Image.create_from_file(os.path.join(d, f'{k:04d}.jpg'))
            r = lm.detect(img)
            if not r.pose_landmarks:
                out.append(None)
                continue
            # 見えている度合いは、アプリと同じく visibility と presence の小さい方
            p = [[round(q.x, 5), round(q.y, 5), round(min(q.visibility or 0, q.presence if q.presence is not None else 1), 3)] for q in r.pose_landmarks[0]]
            w = [[round(q.x, 4), round(q.y, 4), round(q.z, 4)] for q in r.pose_world_landmarks[0]] if r.pose_world_landmarks else None
            out.append({'p': p, 'w': w})
        with open(os.path.join(d, 'mp.json'), 'w', encoding='utf-8') as fh:
            json.dump({'width': img.width, 'height': img.height, 'frames': out}, fh)
        done += 1
        if done % 50 == 0:
            print('detected', done, flush=True)
print('done', done)
