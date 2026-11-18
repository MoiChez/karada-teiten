# 推定の点（どの向きから撮ったものでも）から、3D の体（体の高さを 1、カメラの向きの座標）と上の向きを出す、小さなモデルを学習する。
#   python tools/view3d/train.py 学習データ.npz[,学習データ2.npz…] 出力フォルダ [回数]
# 出力: model.json（アプリで読む重み。float16 を base64 で）、report.txt（向きごとの誤差）
# 検証には、学習に使わないクリップ（番号の 1 の位が 0）を使う。同じクリップのコマは、学習と検証に分けない
import base64
import json
import math
import os
import sys
import time

import numpy as np
import torch
from torch import nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import IDX, N, flip_features, flip_targets, joint_angles  # noqa: E402
from train_net import BLOCKS, HIDDEN, Net  # noqa: E402

src, out_dir = sys.argv[1], sys.argv[2]
EPOCHS = int(sys.argv[3]) if len(sys.argv) > 3 else 60
torch.manual_seed(0)
np.random.seed(0)
os.makedirs(out_dir, exist_ok=True)

# いくつかのデータを合わせて使う（クリップの番号は、データごとにずらして重ならないようにする）
parts = [np.load(p) for p in src.split(',')]
X = np.concatenate([d['X'] for d in parts])
Y = np.concatenate([d['Y'] for d in parts])
clip = np.concatenate([d['clip'] + 100000 * k for k, d in enumerate(parts)])
meta = np.concatenate([d['meta'] for d in parts])
val = clip % 10 == 0
Xtr, Ytr, Xva, Yva = X[~val], Y[~val], X[val], Y[val]
# 鏡に映したものも学習に使う（顔の向きが左右どちらでも同じように出すため）
Xtr = np.concatenate([Xtr, flip_features(Xtr)])
Ytr = np.concatenate([Ytr, flip_targets(Ytr)])
mu = Xtr.mean(0)
sd = Xtr.std(0) + 1e-3


net = Net()
opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-4)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=2e-3, total_steps=EPOCHS * math.ceil(len(Xtr) / 256))
xt = torch.tensor((Xtr - mu) / sd, dtype=torch.float32)
yt = torch.tensor(Ytr, dtype=torch.float32)
xv = torch.tensor((Xva - mu) / sd, dtype=torch.float32)
noise = torch.tensor(0.03 / sd, dtype=torch.float32)


# 骨の向き（太もも・すね・上腕・前腕・胴の左右）。角度は骨の向きで決まるので、点の位置の誤差に加えて向きのずれも小さくする
BONES = [(23, 25), (25, 27), (24, 26), (26, 28), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24)]
BA = torch.tensor([IDX[a] for a, _ in BONES])
BB = torch.tensor([IDX[b] for _, b in BONES])


def loss_fn(pred, y):
    p = (pred[:, : N * 3] - y[:, : N * 3]).abs().mean()
    up = pred[:, N * 3 :]
    u = (up / (up.norm(dim=1, keepdim=True) + 1e-6) - y[:, N * 3 :]).abs().mean()
    pp = pred[:, : N * 3].reshape(-1, N, 3)
    yy = y[:, : N * 3].reshape(-1, N, 3)
    vp = pp[:, BB] - pp[:, BA]
    vy = yy[:, BB] - yy[:, BA]
    cos = (vp * vy).sum(-1) / (vp.norm(dim=-1) * vy.norm(dim=-1) + 1e-6)
    return p + 0.5 * u + 0.5 * (1 - cos).mean()


t0 = time.time()
for ep in range(EPOCHS):
    net.train()
    perm = torch.randperm(len(xt))
    tot = 0.0
    for i in range(0, len(xt), 256):
        b = perm[i : i + 256]
        x = xt[b] + torch.randn_like(xt[b]) * noise
        loss = loss_fn(net(x), yt[b])
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        tot += loss.item() * len(b)
    if ep % 10 == 9 or ep == EPOCHS - 1:
        net.eval()
        with torch.no_grad():
            lv = loss_fn(net(xv), torch.tensor(Yva)).item()
        print(f'epoch {ep + 1} train {tot / len(xt):.4f} val {lv:.4f} ({time.time() - t0:.0f}s)', flush=True)

# ---------- 評価（検証のクリップ） ----------
net.eval()
with torch.no_grad():
    P = net(xv).numpy()
p3 = P[:, : N * 3].reshape(-1, N, 3)
g3 = Yva[:, : N * 3].reshape(-1, N, 3)
up = P[:, N * 3 :] / np.linalg.norm(P[:, N * 3 :], axis=1, keepdims=True)
gup = Yva[:, N * 3 :]
mpjpe = np.linalg.norm(p3 - g3, axis=2).mean(1)
ap, ag = joint_angles(p3, up), joint_angles(g3, gup)
yaw = meta[val] % 1000
motion = meta[val] // 1000
lines = [f'frames train {len(Xtr)} (with mirror) val {len(Xva)}  hidden {HIDDEN} blocks {BLOCKS} epochs {EPOCHS}']


def summary(mask, label):
    if not mask.any():
        return
    errs = {k: np.abs(ap[k][mask] - ag[k][mask]) for k in ap}
    s = ' '.join(f'{k} {np.median(v):.1f}/{np.percentile(v, 90):.1f}' for k, v in errs.items())
    upe = np.degrees(np.arccos(np.clip((up[mask] * gup[mask]).sum(1), -1, 1)))
    lines.append(f'{label:<14} n={mask.sum():5d} 3D {np.median(mpjpe[mask]) * 100:.1f}%  up {np.median(upe):.1f}°  angles(median/p90) {s}')


summary(np.ones(len(yaw), bool), 'all')
for m, name in enumerate(['squat', 'erg', 'bike']):
    summary(motion == m, name)
# 向き: 横（0°・180° のまわり ±22.5°）・斜め・正面と後ろ（90°・270°）
dist_side = np.minimum(np.abs(((yaw + 90) % 180) - 90), 90)
summary(dist_side < 22.5, 'side ±22')
summary((dist_side >= 22.5) & (dist_side < 67.5), 'oblique')
summary(dist_side >= 67.5, 'front/back')
report = '\n'.join(lines)
print(report)
open(os.path.join(out_dir, 'report.txt'), 'w', encoding='utf-8').write(report + '\n')

# ---------- アプリで読む重み ----------


def pack(t):
    a = t.detach().numpy().astype(np.float16)
    return {'shape': list(a.shape), 'data': base64.b64encode(a.tobytes()).decode('ascii')}


layers = [('inp', net.inp)]
for k, b in enumerate(net.blocks):
    layers += [(f'b{k}a', b[0]), (f'b{k}b', b[3])]
layers.append(('out', net.out))
model = {
    'version': 1,
    'hidden': HIDDEN,
    'blocks': BLOCKS,
    'mu': pack(torch.tensor(mu)),
    'sd': pack(torch.tensor(sd)),
    'layers': {n: {'w': pack(l.weight), 'b': pack(l.bias)} for n, l in layers},
}
# アプリの計算が同じ結果になるかを確かめるための、入力と出力の組（float16 にした重みで計算した値）
with torch.no_grad():
    half = Net()
    half.load_state_dict({k: v.half().float() for k, v in net.state_dict().items()})
    half.eval()
    xs = Xva[:3]
    mu16, sd16 = mu.astype(np.float16).astype(np.float32), sd.astype(np.float16).astype(np.float32)
    ys = half(torch.tensor((xs - mu16) / sd16, dtype=torch.float32)).numpy()
model['test'] = {'x': xs.round(5).tolist(), 'y': ys.round(5).tolist()}
with open(os.path.join(out_dir, 'model.json'), 'w', encoding='utf-8') as fh:
    json.dump(model, fh)
torch.save({'state': net.state_dict(), 'mu': mu, 'sd': sd, 'hidden': HIDDEN, 'blocks': BLOCKS}, os.path.join(out_dir, 'model.pt'))
print('saved', os.path.getsize(os.path.join(out_dir, 'model.json')) // 1024, 'KB')
