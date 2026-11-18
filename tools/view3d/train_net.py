# 推定の点 → 3D の体と上の向きを出すモデルの形（学習と評価で共通。アプリ側は src/domain/view3d.ts で同じ計算をする）
import os

import numpy as np
import torch
from torch import nn

from common import IN_DIM, IN_FRAME, OUT_DIM

HIDDEN = int(os.environ.get('VIEW3D_HIDDEN', 384))
BLOCKS = int(os.environ.get('VIEW3D_BLOCKS', 2))


class Net(nn.Module):
    def __init__(self, hidden=None, blocks=None):
        super().__init__()
        hidden = hidden or HIDDEN
        blocks = BLOCKS if blocks is None else blocks
        self.inp = nn.Linear(IN_DIM, hidden)
        self.blocks = nn.ModuleList([nn.Sequential(nn.Linear(hidden, hidden), nn.ReLU(), nn.Dropout(0.15), nn.Linear(hidden, hidden)) for _ in range(blocks)])
        self.out = nn.Linear(hidden, OUT_DIM)

    def forward(self, x):
        h = torch.relu(self.inp(x))
        for b in self.blocks:
            h = torch.relu(h + b(h))
        return self.out(h)


class SeqBlock(nn.Module):
    """時間方向のモデルの 1 段（前に LayerNorm を置く注意と、2 層の全結合。src/domain/view3dSeq.ts と同じ計算）"""

    def __init__(self, d, heads, ff):
        super().__init__()
        self.d, self.heads = d, heads
        self.ln1 = nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.proj = nn.Linear(d, d)
        self.ln2 = nn.LayerNorm(d)
        self.ff1 = nn.Linear(d, ff)
        self.ff2 = nn.Linear(ff, d)
        self.drop = nn.Dropout(0.1)

    def forward(self, h):
        B, L, _ = h.shape
        dh = self.d // self.heads
        q, k, v = self.qkv(self.ln1(h)).reshape(B, L, 3, self.heads, dh).permute(2, 0, 3, 1, 4)
        a = torch.softmax(q @ k.transpose(-1, -2) / dh ** 0.5, -1)
        h = h + self.drop(self.proj((a @ v).transpose(1, 2).reshape(B, L, self.d)))
        return h + self.drop(self.ff2(torch.relu(self.ff1(self.ln2(h)))))


class SeqNet(nn.Module):
    """時間方向のモデル（tools/view3d/train_seq.py）。x: (B, L, in_dim)、ok: (B, L) 人が見つかったコマ"""

    def __init__(self, in_dim, d=128, layers=4, heads=4, ff=256, frames=24):
        super().__init__()
        self.inp = nn.Linear(in_dim, d)
        self.pos = nn.Parameter(torch.randn(frames, d) * 0.02)
        self.miss = nn.Parameter(torch.zeros(d))
        self.blocks = nn.ModuleList([SeqBlock(d, heads, ff) for _ in range(layers)])
        self.norm = nn.LayerNorm(d)
        self.out = nn.Linear(d, OUT_DIM)

    def forward(self, x, ok):
        h = self.inp(x)
        h = torch.where(ok[..., None] > 0, h, self.miss)
        h = h + self.pos[: x.shape[1]]
        for b in self.blocks:
            h = b(h)
        return self.out(self.norm(h))


def load_seq(model_dir):
    """時間方向のモデルと、入力の正規化（1 コマの入力と大きさの入力を合わせた mu・sd）"""
    ck = torch.load(os.path.join(model_dir, 'model.pt'), weights_only=False)
    net = SeqNet(IN_FRAME + 2, ck['d'], ck['layers'], ck['heads'], ck['ff'])
    net.load_state_dict(ck['state'])
    net.eval()
    return net, np.concatenate([ck['mu'], ck['mu_r']]), np.concatenate([ck['sd'], ck['sd_r']])


def load_net(model_dir):
    ck = torch.load(os.path.join(model_dir, 'model.pt'), weights_only=False)
    net = Net(ck.get('hidden', 384), ck.get('blocks', 2))
    net.load_state_dict(ck['state'])
    net.eval()
    return net, np.asarray(ck['mu']), np.asarray(ck['sd'])
