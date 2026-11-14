# 焼いた結果（部位ごとの重みつきの和）から、色の絵と凹凸の絵（法線マップ）を作る
#   python zcompose.py bake_2048.npz 出力先のフォルダ [色の大きさ] [凹凸の大きさ]
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

src, out = sys.argv[1], sys.argv[2]
col_size = int(sys.argv[3]) if len(sys.argv) > 3 else 2048
nor_size = int(sys.argv[4]) if len(sys.argv) > 4 else 1024
d = np.load(src)
w = d['w'].astype(np.float64)
hit = w > 1e-4
print('hit', hit.mean(), 'island', (d['cover'] > 0.5).mean())
col = np.where(hit[:, :, None], d['col'] / np.maximum(w, 1e-4)[:, :, None], 0)
nor = np.where(hit[:, :, None], d['nor'], 0)
ao = np.where(hit, d['ao'] / np.maximum(w, 1e-4), 1)
# 当たらなかった所と、UV の島の外は、いちばん近い当たった所の値で埋める（縫い目に色がにじまないように）
idx = ndimage.distance_transform_edt(~hit, return_distances=False, return_indices=True)
col = col[idx[0], idx[1]]
ao = ao[idx[0], idx[1]]
nor = nor[idx[0], idx[1]]
n = np.linalg.norm(nor, axis=2, keepdims=True)
nor = np.where(n > 1e-6, nor / np.maximum(n, 1e-6), np.array([0, 0, 1.0]))
# 陰（筋肉のあいだの溝）を色に混ぜる
shade = 0.5 + 0.5 * np.clip(ao, 0, 1) ** 1.3
lin = np.clip(col * shade[:, :, None], 0, 1)
srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)


def save(arr, size, name, quality):
    im = Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8)[::-1])  # Blender の絵は下の行が先
    if im.size[0] != size:
        im = im.resize((size, size), Image.LANCZOS)
    im.save(f'{out}/{name}.webp', quality=quality, method=6)
    im.save(f'{out}/{name}.png')
    print(name, im.size)


save(srgb, col_size, 'muscle-skin-v1-color', 86)
save(nor * 0.5 + 0.5, nor_size, 'muscle-skin-v1-normal', 92)
