# 向きによらない 3D の推定（学習と評価）で共通に使う決まり。アプリ側（src/domain/view3d.ts）と同じ並び・同じ正規化にする
import numpy as np

# 使う点（MediaPipe の点の番号）。顔は鼻と両耳、腕、脚、かかと、つま先
USED = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
IDX = {m: k for k, m in enumerate(USED)}
# 左右を入れ替える対（鏡に映したデータを作るとき）
PAIRS = [(7, 8), (11, 12), (13, 14), (15, 16), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32)]
FLIP = list(range(len(USED)))
for a, b in PAIRS:
    FLIP[IDX[a]], FLIP[IDX[b]] = IDX[b], IDX[a]

WINDOW = [-2, -1, 0, 1, 2]  # 前後のコマ（10 コマ/秒で ±0.2 秒）
N = len(USED)
IN_FRAME = N * 2 + N + N * 3  # 2D（正規化）・見えている度合い・推定モデルの 3D
IN_DIM = IN_FRAME * len(WINDOW)
OUT_DIM = N * 3 + 3  # 3D（体の高さを 1、両股関節の中点を原点、カメラの向きの座標）と、上の向き


def norm2d(p, vis):
    """2D の点（ピクセル、N×2）を、両股関節の中点を原点、点の広がりを 1 にする"""
    hip = (p[IDX[23]] + p[IDX[24]]) / 2
    q = p - hip
    w = np.clip(vis, 0.2, 1.0)[:, None]
    s = np.sqrt((w * (q ** 2)).sum() / w.sum() / 2) + 1e-6
    return q / s


def frame_features(p, vis, world):
    """1 コマの入力。p: ピクセルの 2D（N×2）、vis: 見えている度合い（N）、world: 推定モデルの 3D（N×3、メートル、腰が原点）"""
    q = norm2d(p, vis)
    wv = world - (world[IDX[23]] + world[IDX[24]]) / 2
    ws = np.sqrt((wv ** 2).sum(1).mean()) + 1e-6
    return np.concatenate([q.ravel(), vis, (wv / ws).ravel()]).astype(np.float32)


def flip_features(x):
    """鏡に映した入力（左右を入れ替え、横の座標の符号を変える）。x: (..., IN_DIM)"""
    x = x.reshape(*x.shape[:-1], len(WINDOW), IN_FRAME).copy()
    p = x[..., : N * 2].reshape(*x.shape[:-1], N, 2)[..., FLIP, :]
    p[..., 0] *= -1
    v = x[..., N * 2 : N * 3][..., FLIP]
    w = x[..., N * 3 :].reshape(*x.shape[:-1], N, 3)[..., FLIP, :]
    w[..., 0] *= -1
    x = np.concatenate([p.reshape(*x.shape[:-1], N * 2), v, w.reshape(*x.shape[:-1], N * 3)], -1)
    return x.reshape(*x.shape[:-2], IN_DIM)


def flip_targets(y):
    y = y.copy()
    p = y[..., : N * 3].reshape(*y.shape[:-1], N, 3)[..., FLIP, :]
    p[..., 0] *= -1
    up = y[..., N * 3 :].copy()
    up[..., 0] *= -1
    return np.concatenate([p.reshape(*y.shape[:-1], N * 3), up], -1)


def angle(a, b, c):
    """b での曲がり（180° − 内角、度）。a, b, c: (..., 3)"""
    u = a - b
    v = c - b
    cos = (u * v).sum(-1) / (np.linalg.norm(u, axis=-1) * np.linalg.norm(v, axis=-1) + 1e-9)
    return 180 - np.degrees(np.arccos(np.clip(cos, -1, 1)))


def joint_angles(p3, up):
    """3D の点（..., N, 3）と上の向き（..., 3）から、向きによらない角度（度）"""
    P = lambda m: p3[..., IDX[m], :]  # noqa: E731
    sh = (P(11) + P(12)) / 2
    hip = (P(23) + P(24)) / 2
    trunk = sh - hip
    cos = (trunk * up).sum(-1) / (np.linalg.norm(trunk, axis=-1) * np.linalg.norm(up, axis=-1) + 1e-9)
    return {
        'knee_l': angle(P(23), P(25), P(27)),
        'knee_r': angle(P(24), P(26), P(28)),
        'hip_l': angle(P(11), P(23), P(25)),
        'hip_r': angle(P(12), P(24), P(26)),
        'elbow_l': angle(P(11), P(13), P(15)),
        'elbow_r': angle(P(12), P(14), P(16)),
        'trunk': np.degrees(np.arccos(np.clip(cos, -1, 1))),
    }
