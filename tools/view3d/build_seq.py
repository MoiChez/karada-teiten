# 合成データから、クリップごとの並び（時間方向のモデルの学習用）を作って npz に書く。
#   python tools/view3d/build_seq.py データのフォルダ 出力.npz [推定の点のファイル名（既定 mp_rtm.json）]
# 1 コマの入力は build_dataset.py と同じ（common.frame_features。19 点の 2D・見えている度合い・推定モデルの 3D）。
# 人が見つからなかったコマは ok = 0 にする。正解も build_dataset.py と同じ（カメラの向きの座標、体の高さを 1）
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import IDX, IN_FRAME, USED, frame_features, frame_scales  # noqa: E402

root, out = sys.argv[1], sys.argv[2]
DET = sys.argv[3] if len(sys.argv) > 3 else 'mp_rtm.json'
T = 24
X, Y, OK, G, M, P, SC = [], [], [], [], [], [], []
for name in sorted(os.listdir(root)):
    d = os.path.join(root, name)
    if not (os.path.exists(os.path.join(d, 'clip.json')) and os.path.exists(os.path.join(d, DET))):
        continue
    clip = json.load(open(os.path.join(d, 'clip.json'), encoding='utf-8'))
    det = json.load(open(os.path.join(d, DET), encoding='utf-8'))
    W, H = det['width'], det['height']
    cw = np.array(clip['camera']['matrix_world'])
    R = cw[:3, :3].T
    t = cw[:3, 3]
    flip = np.diag([1.0, -1.0, -1.0])
    up = flip @ R @ np.array([0, 0, 1.0])
    x = np.zeros((T, IN_FRAME), np.float32)
    y = np.zeros((T, len(USED) * 3 + 3), np.float32)
    ok = np.zeros(T, np.float32)
    sc = np.ones((T, 2), np.float32)
    n = min(T, len(det['frames']), len(clip['frames']))
    for k in range(n):
        f = det['frames'][k]
        g3 = clip['frames'][k]['p3']
        if any(str(m) not in g3 for m in USED):
            continue
        pw = np.array([g3[str(m)] for m in USED])
        pc = (flip @ (R @ (pw - t).T)).T
        root_c = (pc[IDX[23]] + pc[IDX[24]]) / 2
        y[k] = np.concatenate([((pc - root_c) / clip['body_h']).ravel(), up])
        if f and f.get('w'):
            p = np.array([[f['p'][m][0] * W, f['p'][m][1] * H] for m in USED])
            vis = np.array([f['p'][m][2] for m in USED])
            world = np.array([f['w'][m] for m in USED])
            x[k] = frame_features(p, vis, world)
            sc[k] = frame_scales(p, vis, world)
            ok[k] = 1
    if ok.sum() < 5:
        continue
    X.append(x)
    Y.append(y)
    OK.append(ok)
    SC.append(sc)
    G.append(clip['index'])
    M.append({'squat': 0, 'erg': 1, 'bike': 2}[clip['motion']] * 1000 + int(round(clip['camera']['yaw'])) % 360)
    P.append(clip['camera']['pitch'])
np.savez_compressed(out, X=np.stack(X), Y=np.stack(Y), ok=np.stack(OK), scale=np.stack(SC), clip=np.array(G), meta=np.array(M), pitch=np.array(P, np.float32))
print('clips', len(X), 'frames ok', int(np.stack(OK).sum()))
