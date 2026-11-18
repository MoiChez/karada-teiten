# 合成データ（clip.json の正解と mp.json の推定の点）から、学習用の配列（入力と正解）を作って npz に書く。
#   python tools/view3d/build_dataset.py データのフォルダ 出力.npz [推定の点のファイル名（既定 mp.json。RTMPose で細かくした点は mp_rtm.json）]
# 正解は、カメラの向きの座標（右が +x、下が +y、奥が +z）の 3D の点を、両股関節の中点を原点、体の高さを 1 にしたものと、
# 上の向き（床に垂直、カメラの座標）
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import IDX, N, USED, WINDOW, frame_features  # noqa: E402

root, out = sys.argv[1], sys.argv[2]
DET = sys.argv[3] if len(sys.argv) > 3 else 'mp.json'
X, Y, G, M = [], [], [], []
for name in sorted(os.listdir(root)):
    d = os.path.join(root, name)
    if not (os.path.exists(os.path.join(d, 'clip.json')) and os.path.exists(os.path.join(d, DET))):
        continue
    clip = json.load(open(os.path.join(d, 'clip.json'), encoding='utf-8'))
    det = json.load(open(os.path.join(d, DET), encoding='utf-8'))
    W, H = det['width'], det['height']
    cw = np.array(clip['camera']['matrix_world'])  # カメラ → ワールド（Blender。カメラは -Z を向き +Y が上）
    R = cw[:3, :3].T  # ワールド → カメラ
    t = cw[:3, 3]
    flip = np.diag([1.0, -1.0, -1.0])  # Blender のカメラの座標 → 右 +x・下 +y・奥 +z
    up = flip @ R @ np.array([0, 0, 1.0])
    feats = []
    for f in det['frames']:
        if not f or not f.get('w'):
            feats.append(None)
            continue
        p = np.array([[f['p'][m][0] * W, f['p'][m][1] * H] for m in USED])
        vis = np.array([f['p'][m][2] for m in USED])
        world = np.array([f['w'][m] for m in USED])
        feats.append(frame_features(p, vis, world))
    ok = [k for k, f in enumerate(feats) if f is not None]
    if len(ok) < 5:
        continue
    body_h = clip['body_h']
    for k in ok:
        win = []
        for o in WINDOW:
            j = min(max(k + o, 0), len(feats) - 1)
            if feats[j] is None:
                j = min(ok, key=lambda q: abs(q - j))
            win.append(feats[j])
        g3 = clip['frames'][k]['p3']
        if any(str(m) not in g3 for m in USED):
            continue
        pw = np.array([g3[str(m)] for m in USED])
        pc = (flip @ (R @ (pw - t).T)).T
        root_c = (pc[IDX[23]] + pc[IDX[24]]) / 2
        y = np.concatenate([((pc - root_c) / body_h).ravel(), up]).astype(np.float32)
        X.append(np.concatenate(win))
        Y.append(y)
        G.append(clip['index'])
        M.append({'squat': 0, 'erg': 1, 'bike': 2}[clip['motion']] * 1000 + int(round(clip['camera']['yaw'])) % 360)
X = np.stack(X)
Y = np.stack(Y)
np.savez_compressed(out, X=X, Y=Y, clip=np.array(G), meta=np.array(M))
print('frames', len(X), 'clips', len(set(G)), 'in', X.shape[1], 'out', Y.shape[1], 'N', N)
