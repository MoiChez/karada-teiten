# 時間方向のモデル（クリップの 24 コマ = 2.4 秒をまとめて見る小さな Transformer）を学習する。
# 立っているコマから骨の長さが分かるので、正面・後ろから撮った深いしゃがみの前後の傾きを、短くなった見かけの長さから求めやすくなる。
# 隠れたコマ・点は、前後のコマから埋めるように、学習のときに一部のコマと点をわざと消す。
# 1 コマの入力は点の広がりで大きさをそろえるので、しゃがんで見かけが小さくなったことが消える。そのため、コマの広がり（2D と推定モデルの 3D）の、
# 見ている区間の中央値に対する比（対数）を 2 つ足す
#   python tools/view3d/train_seq.py seq1.npz[,seq2.npz…] 出力フォルダ [回数] [比べる 1 コマのモデルのフォルダ]
# 出力: model.json（アプリで読む重み。float16 を base64 で）、model.pt、report.txt（向きごとの誤差。比べるモデルと同じコマで）
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
from common import FLIP, IDX, IN_FRAME, N, WINDOW, joint_angles  # noqa: E402
from train_net import SeqNet  # noqa: E402

src, out_dir = sys.argv[1], sys.argv[2]
EPOCHS = int(sys.argv[3]) if len(sys.argv) > 3 else 150
BASE = sys.argv[4] if len(sys.argv) > 4 else None
D = int(os.environ.get('SEQ_D', 128))
LAYERS = int(os.environ.get('SEQ_LAYERS', 4))
HEADS = int(os.environ.get('SEQ_HEADS', 4))
FF = int(os.environ.get('SEQ_FF', 256))
T = 24
torch.manual_seed(0)
np.random.seed(0)
torch.set_num_threads(int(os.environ.get('SEQ_THREADS', 8)))
os.makedirs(out_dir, exist_ok=True)

parts = [np.load(p) for p in src.split(',')]
X = np.concatenate([d['X'] for d in parts])
Y = np.concatenate([d['Y'] for d in parts])
OK = np.concatenate([d['ok'] for d in parts])
SC = np.concatenate([d['scale'] for d in parts])
clip = np.concatenate([d['clip'] + 100000 * k for k, d in enumerate(parts)])
meta = np.concatenate([d['meta'] for d in parts])
pitch = np.concatenate([d['pitch'] for d in parts])
val = clip % 10 == 0


def flip_frames(x):
    """1 コマの入力（..., IN_FRAME）を鏡に映す"""
    x = x.copy()
    p = x[..., : N * 2].reshape(*x.shape[:-1], N, 2)[..., FLIP, :]
    p[..., 0] *= -1
    v = x[..., N * 2 : N * 3][..., FLIP]
    w = x[..., N * 3 :].reshape(*x.shape[:-1], N, 3)[..., FLIP, :]
    w[..., 0] *= -1
    return np.concatenate([p.reshape(*x.shape[:-1], N * 2), v, w.reshape(*x.shape[:-1], N * 3)], -1)


def flip_y(y):
    y = y.copy()
    p = y[..., : N * 3].reshape(*y.shape[:-1], N, 3)[..., FLIP, :]
    p[..., 0] *= -1
    up = y[..., N * 3 :].copy()
    up[..., 0] *= -1
    return np.concatenate([p.reshape(*y.shape[:-1], N * 3), up], -1)


Xtr = np.concatenate([X[~val], flip_frames(X[~val])])
Ytr = np.concatenate([Y[~val], flip_y(Y[~val])])
OKtr = np.concatenate([OK[~val], OK[~val]])
SCtr = np.concatenate([SC[~val], SC[~val]])
valid_rows = Xtr[OKtr > 0]
mu = valid_rows.mean(0)
sd = valid_rows.std(0) + 1e-3


def rel_scale(sc, ok):
    """コマの広がりの、区間の中の中央値に対する比の対数（人が見つからなかったコマは 0）。sc: (B, L, 2)、ok: (B, L)"""
    lg = torch.log(sc)
    ref = torch.nanmedian(torch.where(ok[..., None] > 0, lg, torch.full_like(lg, float('nan'))), dim=1, keepdim=True).values
    return torch.where(ok[..., None] > 0, lg - torch.nan_to_num(ref), torch.zeros_like(lg))


_r = rel_scale(torch.tensor(SCtr), torch.tensor(OKtr)).numpy()[OKtr > 0]
mu_r = _r.mean(0)
sd_r = _r.std(0) + 1e-3
MU_R = torch.tensor(mu_r, dtype=torch.float32)
SD_R = torch.tensor(sd_r, dtype=torch.float32)
print('scale feature mean', mu_r, 'sd', sd_r)


BONES = [(23, 25), (25, 27), (24, 26), (26, 28), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24)]
BA = torch.tensor([IDX[a] for a, _ in BONES])
BB = torch.tensor([IDX[b] for _, b in BONES])


def loss_fn(pred, y):
    pred = pred.reshape(-1, pred.shape[-1])
    y = y.reshape(-1, y.shape[-1])
    p = (pred[:, : N * 3] - y[:, : N * 3]).abs().mean()
    up = pred[:, N * 3 :]
    u = (up / (up.norm(dim=1, keepdim=True) + 1e-6) - y[:, N * 3 :]).abs().mean()
    pp = pred[:, : N * 3].reshape(-1, N, 3)
    yy = y[:, : N * 3].reshape(-1, N, 3)
    vp = pp[:, BB] - pp[:, BA]
    vy = yy[:, BB] - yy[:, BA]
    cos = (vp * vy).sum(-1) / (vp.norm(dim=-1) * vy.norm(dim=-1) + 1e-6)
    return p + 0.5 * u + 0.5 * (1 - cos).mean()


net = SeqNet(IN_FRAME + 2, D, LAYERS, HEADS, FF, T)
print('params', sum(p.numel() for p in net.parameters()))
opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-4)
BS = 64
steps = EPOCHS * math.ceil(len(Xtr) / BS)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=1e-3, total_steps=steps)
xt = torch.tensor((Xtr - mu) / sd, dtype=torch.float32)
yt = torch.tensor(Ytr, dtype=torch.float32)
okt = torch.tensor(OKtr, dtype=torch.float32)
sct = torch.tensor(SCtr, dtype=torch.float32)
noise = torch.tensor(0.03 / sd, dtype=torch.float32)
# 消した点の入力（正規化の前に 0: 2D は腰の位置、見えている度合い 0、3D は腰の位置）
zero_pt = torch.tensor((0 - mu) / sd, dtype=torch.float32)
P2 = [(2 * j, 2 * j + 1) for j in range(N)]


def augment(x, ok):
    B, L, _ = x.shape
    x = x + torch.randn_like(x) * noise
    # コマを消す（人が見つからなかったコマ）
    ok = ok * (torch.rand(B, L) > 0.1).float()
    # 点を消す（柱・器具・体の陰で隠れた点）: 2D・見えている度合い・3D をまとめて
    drop = torch.rand(B, L, N) < 0.05
    cols = torch.zeros(B, L, IN_FRAME, dtype=torch.bool)
    for j in range(N):
        dj = drop[..., j]
        for c in (2 * j, 2 * j + 1, 2 * N + j, 3 * N + 3 * j, 3 * N + 3 * j + 1, 3 * N + 3 * j + 2):
            cols[..., c] |= dj
    x = torch.where(cols, zero_pt.expand_as(x), x)
    return x, ok


WARP = float(os.environ.get('SEQ_WARP', 0))


def warp_index(L):
    """合成の動きは速さが一定で止まらないので、速さを変え、止まる区間を入れ、ときどき逆向きにした並び（クリップの中のコマの番号）"""
    steps = np.full(L, np.random.uniform(0.4, 1.6))
    for _ in range(np.random.randint(0, 3)):
        a = np.random.randint(0, L)
        steps[a : a + np.random.randint(2, 10)] = 0
    pos = np.cumsum(steps) - steps[0]
    if pos[-1] > T - 1:
        pos = pos * (T - 1) / pos[-1]
    idx = np.clip(np.round(np.random.uniform(0, T - 1 - pos[-1]) + pos), 0, T - 1).astype(int)
    return idx[::-1].copy() if np.random.rand() < 0.3 else idx


t0 = time.time()
for ep in range(EPOCHS):
    net.train()
    perm = torch.randperm(len(xt))
    tot = 0.0
    for i in range(0, len(xt), BS):
        b = perm[i : i + BS]
        # 長さ 8〜24 の区間を切り出す（アプリでは 24 コマずつ見るが、短い動画もあるため）
        L = int(np.random.choice([24, 24, 24, 16, 12, 8]))
        if WARP and np.random.rand() < WARP:
            # 速さを変えた並び（サンプルごとに違う）
            ix = torch.tensor(np.stack([warp_index(L) for _ in range(len(b))]))
        else:
            s = np.random.randint(0, T - L + 1)
            ix = torch.arange(s, s + L).expand(len(b), L)
        rows = b[:, None]
        x, ok = augment(xt[rows, ix], okt[rows, ix])
        x = torch.cat([x, (rel_scale(sct[rows, ix], ok) - MU_R) / SD_R], -1)
        y = yt[rows, ix]
        pred = net(x, ok)
        has = y.abs().sum(-1) > 0
        loss = loss_fn(pred[has], y[has])
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
        opt.step()
        sched.step()
        tot += loss.item() * len(b)
    if ep % 10 == 9 or ep == EPOCHS - 1:
        print(f'epoch {ep + 1} train {tot / len(xt):.4f} ({time.time() - t0:.0f}s)', flush=True)

# ---------- 評価（検証のクリップ。人が見つかり、正解のあるコマ） ----------
net.eval()
Xv, Yv, OKv = X[val], Y[val], OK[val]
Rv = rel_scale(torch.tensor(SC[val]), torch.tensor(OKv)).numpy()
with torch.no_grad():
    Pv = net(torch.tensor(np.concatenate([(Xv - mu) / sd, (Rv - mu_r) / sd_r], -1), dtype=torch.float32), torch.tensor(OKv)).numpy()
sel = (OKv > 0) & (np.abs(Yv).sum(-1) > 0)
P = Pv[sel]
G = Yv[sel]
yaw = np.repeat(meta[val] % 1000, T).reshape(-1, T)[sel]
motion = np.repeat(meta[val] // 1000, T).reshape(-1, T)[sel]
pit = np.repeat(pitch[val], T).reshape(-1, T)[sel]
results = {'seq': P}

if BASE:
    # 1 コマのモデル（前後 ±0.2 秒の 5 コマ）を、同じコマにかける
    from train_net import load_net  # noqa: E402

    bnet, bmu, bsd = load_net(BASE)
    rows = []
    for c in range(len(Xv)):
        okk = [k for k in range(T) if OKv[c, k] > 0]
        for k in range(T):
            if not sel[c, k]:
                continue
            win = []
            for o in WINDOW:
                j = min(max(k + o, 0), T - 1)
                if OKv[c, j] == 0:
                    j = min(okk, key=lambda q: abs(q - j))
                win.append(Xv[c, j])
            rows.append(np.concatenate(win))
    with torch.no_grad():
        results['mlp'] = bnet(torch.tensor((np.stack(rows) - bmu) / bsd, dtype=torch.float32)).numpy()

g3 = G[:, : N * 3].reshape(-1, N, 3)
gup = G[:, N * 3 :]
ag = joint_angles(g3, gup)
lines = [f'seq clips train {int((~val).sum())} val {int(val.sum())} frames {len(G)}  d {D} layers {LAYERS} heads {HEADS} ff {FF} epochs {EPOCHS}']
dist_side = np.minimum(np.abs(((yaw + 90) % 180) - 90), 90)
gk = (ag['knee_l'] + ag['knee_r']) / 2
groups = [('all', np.ones(len(G), bool))]
groups += [(m, motion == i) for i, m in enumerate(['squat', 'erg', 'bike'])]
groups += [('side ±22', dist_side < 22.5), ('oblique', (dist_side >= 22.5) & (dist_side < 67.5)), ('front/back', dist_side >= 67.5)]
groups += [('look up <-5', pit < -5), ('squat obl/back up', (motion == 0) & (dist_side >= 22.5) & (pit < -5))]
groups += [('squat f/b knee>100', (motion == 0) & (dist_side >= 67.5) & (gk >= 100)), ('squat f/b 60-100', (motion == 0) & (dist_side >= 67.5) & (gk >= 60) & (gk < 100))]
for name, Pm in results.items():
    p3 = Pm[:, : N * 3].reshape(-1, N, 3)
    up = Pm[:, N * 3 :] / np.linalg.norm(Pm[:, N * 3 :], axis=1, keepdims=True)
    ap = joint_angles(p3, up)
    lines.append(f'== {name}')
    for label, mask in groups:
        if not mask.any():
            continue
        e = {}
        for a in ['knee', 'hip', 'trunk', 'elbow']:
            keys = [a] if a == 'trunk' else [a + '_l', a + '_r']
            err = np.concatenate([np.abs(ap[k][mask] - ag[k][mask]) for k in keys])
            e[a] = f'{np.median(err):4.1f}/{np.percentile(err, 90):4.1f}'
        bias = ((ap['knee_l'] + ap['knee_r']) / 2 - gk)[mask].mean()
        lines.append(f'{label:<20} n={mask.sum():5d}  knee {e["knee"]} (bias {bias:+.1f})  hip {e["hip"]}  trunk {e["trunk"]}  elbow {e["elbow"]}')
report = '\n'.join(lines)
print(report)
open(os.path.join(out_dir, 'report.txt'), 'w', encoding='utf-8').write(report + '\n')

# ---------- アプリで読む重み ----------


def pack(t):
    a = t.detach().numpy().astype(np.float16)
    return {'shape': list(a.shape), 'data': base64.b64encode(a.tobytes()).decode('ascii')}


def lin(l):
    return {'w': pack(l.weight), 'b': pack(l.bias)}


model = {
    'version': 3,
    'type': 'seq',
    'frames': T,
    'stepMs': 100,
    'd': D,
    'layers': LAYERS,
    'heads': HEADS,
    'ff': FF,
    'scaleFeatures': 2,
    'mu': pack(torch.tensor(np.concatenate([mu, mu_r]))),
    'sd': pack(torch.tensor(np.concatenate([sd, sd_r]))),
    'inp': lin(net.inp),
    'pos': pack(net.pos),
    'miss': pack(net.miss),
    'blocks': [{'ln1': lin(b.ln1), 'qkv': lin(b.qkv), 'proj': lin(b.proj), 'ln2': lin(b.ln2), 'ff1': lin(b.ff1), 'ff2': lin(b.ff2)} for b in net.blocks],
    'norm': lin(net.norm),
    'out': lin(net.out),
}
# アプリの計算が同じ結果になるかを確かめるための、入力と出力の組（float16 にした重みで計算した値。1 コマ目は消したコマ）
with torch.no_grad():
    half = SeqNet(IN_FRAME + 2, D, LAYERS, HEADS, FF, T)
    half.load_state_dict({k: v.half().float() for k, v in net.state_dict().items()})
    half.eval()
    mu16 = np.concatenate([mu, mu_r]).astype(np.float16).astype(np.float32)
    sd16 = np.concatenate([sd, sd_r]).astype(np.float16).astype(np.float32)
    oks = OKv[:2].copy()
    oks[:, 0] = 0
    xs = np.concatenate([Xv[:2], rel_scale(torch.tensor(SC[val][:2]), torch.tensor(oks)).numpy()], -1)
    ys = half(torch.tensor((xs - mu16) / sd16, dtype=torch.float32), torch.tensor(oks)).numpy()
model['test'] = {'x': xs.round(5).tolist(), 'ok': oks.tolist(), 'y': ys.round(5).tolist()}
with open(os.path.join(out_dir, 'model.json'), 'w', encoding='utf-8') as fh:
    json.dump(model, fh)
torch.save({'state': net.state_dict(), 'mu': mu, 'sd': sd, 'mu_r': mu_r, 'sd_r': sd_r, 'd': D, 'layers': LAYERS, 'heads': HEADS, 'ff': FF}, os.path.join(out_dir, 'model.pt'))
print('saved', os.path.getsize(os.path.join(out_dir, 'model.json')) // 1024, 'KB')
