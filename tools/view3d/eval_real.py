# 学習したモデルを、実際の人の動画で確かめる（開発用）。動画を 1 秒あたり 10 コマで読み、アプリと同じ推定モデルをかけ、
# モデルの 3D から出した角度と、画面の上の点から出した角度（真横から撮った動画なら、ほぼ正しい）を並べる。
#   python tools/view3d/eval_real.py モデルのフォルダ 動画 [最大の秒数] [RTMPose のモデル（あればアプリと同じく 2D の点を細かくする）]
# 動画は読むだけで、どこにも書き出さない
import json
import os
import sys
import types

for _n in ('matplotlib', 'matplotlib.pyplot'):
    sys.modules.setdefault(_n, types.ModuleType(_n))

import cv2  # noqa: E402
import mediapipe as mp  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from mediapipe.tasks.python import BaseOptions, vision  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import IDX, N, USED, WINDOW, angle, frame_features, joint_angles  # noqa: E402
from rtm_refine import refine, session  # noqa: E402

model_dir, video = sys.argv[1], sys.argv[2]
MAX_SEC = float(sys.argv[3]) if len(sys.argv) > 3 else 20
RTM = sys.argv[4] if len(sys.argv) > 4 else None
rtm_sess = session(RTM) if RTM else None
MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'models', 'pose_landmarker_heavy.task')
lm = vision.PoseLandmarker.create_from_options(
    vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_buffer=open(MODEL, 'rb').read()), running_mode=vision.RunningMode.IMAGE, num_poses=1)
)
cap = cv2.VideoCapture(video)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
step = max(1, int(round(fps / 10)))
feats, raw = [], []
k = 0
while True:
    ok, fr = cap.read()
    if not ok or k / fps > MAX_SEC:
        break
    if k % step == 0:
        h, w = fr.shape[:2]
        s = min(1.0, 720 / max(h, w))
        img = cv2.resize(fr, (int(w * s), int(h * s)))
        r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)))
        if r.pose_landmarks and r.pose_world_landmarks:
            L = r.pose_landmarks[0]
            # 見えている度合いは、学習と同じく visibility と presence の小さい方
            full = [[q.x, q.y, min(q.visibility or 0, q.presence if q.presence is not None else 1)] for q in L]
            if rtm_sess is not None:
                full = refine(rtm_sess, img, full)
            p = np.array([[full[m][0] * img.shape[1], full[m][1] * img.shape[0]] for m in USED])
            vis = np.array([full[m][2] for m in USED])
            world = np.array([[r.pose_world_landmarks[0][m].x, r.pose_world_landmarks[0][m].y, r.pose_world_landmarks[0][m].z] for m in USED])
            feats.append(frame_features(p, vis, world))
            raw.append((p, vis))
        else:
            feats.append(None)
            raw.append(None)
    k += 1
ok_idx = [i for i, f in enumerate(feats) if f is not None]
X = []
for i in ok_idx:
    win = []
    for o in WINDOW:
        j = min(max(i + o, 0), len(feats) - 1)
        if feats[j] is None:
            j = min(ok_idx, key=lambda q: abs(q - j))
        win.append(feats[j])
    X.append(np.concatenate(win))
X = np.stack(X)

# モデル（train.py と同じ形）
from train_net import load_net  # noqa: E402

net, mu, sd = load_net(model_dir)
with torch.no_grad():
    P = net(torch.tensor((X - mu) / sd, dtype=torch.float32)).numpy()
p3 = P[:, : N * 3].reshape(-1, N, 3)
up = P[:, N * 3 :] / np.linalg.norm(P[:, N * 3 :], axis=1, keepdims=True)
A = joint_angles(p3, up)
# 画面の上の点から出した角度（カメラ側の脚と腕）
near_left = np.median([raw[i][1][IDX[25]] - raw[i][1][IDX[26]] for i in ok_idx]) >= 0
s = 'l' if near_left else 'r'
H, K, An, Sh, E, Wr = (23, 25, 27, 11, 13, 15) if near_left else (24, 26, 28, 12, 14, 16)


def a2(i, a, b, c):
    p = raw[i][0]
    return float(angle(np.append(p[IDX[a]], 0), np.append(p[IDX[b]], 0), np.append(p[IDX[c]], 0)))


rows = []
for n, i in enumerate(ok_idx):
    rows.append((a2(i, H, K, An), float(A[f'knee_{s}'][n]), a2(i, Sh, H, K), float(A[f'hip_{s}'][n]), a2(i, Sh, E, Wr), float(A[f'elbow_{s}'][n]), float(A['trunk'][n])))
R = np.array(rows)
for name, c2, c3 in (('knee', 0, 1), ('hip', 2, 3), ('elbow', 4, 5)):
    d = np.abs(R[:, c2] - R[:, c3])
    r = np.corrcoef(R[:, c2], R[:, c3])[0, 1]
    print(f'{name}: 2D range {R[:, c2].min():.0f}-{R[:, c2].max():.0f}  3D range {R[:, c3].min():.0f}-{R[:, c3].max():.0f}  |diff| median {np.median(d):.1f} p90 {np.percentile(d, 90):.1f}  r {r:.2f}')
print(f'trunk from vertical (3D): {R[:, 6].min():.0f}-{R[:, 6].max():.0f}  frames {len(R)}')
json.dump({'rows': R.round(2).tolist()}, open(os.path.join(model_dir, 'real_' + os.path.basename(video) + '.json'), 'w'))
