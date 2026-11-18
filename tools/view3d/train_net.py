# 推定の点 → 3D の体と上の向きを出すモデルの形（学習と評価で共通。アプリ側は src/domain/view3d.ts で同じ計算をする）
import os

import numpy as np
import torch
from torch import nn

from common import IN_DIM, OUT_DIM

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


def load_net(model_dir):
    ck = torch.load(os.path.join(model_dir, 'model.pt'), weights_only=False)
    net = Net(ck.get('hidden', 384), ck.get('blocks', 2))
    net.load_state_dict(ck['state'])
    net.eval()
    return net, np.asarray(ck['mu']), np.asarray(ck['sd'])
