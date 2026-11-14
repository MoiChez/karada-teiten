# fit0.blend のアプリの体を、解剖モデルの姿勢へ変形する（自前のスキニング）。確認用の重ね描きを出す
import bpy, sys, math, json
import numpy as np
from mathutils import Vector, Matrix
a = sys.argv[sys.argv.index('--') + 1:]
sys.path.insert(0, a[0])
import zb
OUT = a[1]
TW = json.load(open(a[2])) if len(a) > 2 else {}
RENDER = len(a) <= 3 or a[3] != 'norender'
sc = bpy.context.scene
mesh = bpy.data.objects['mq']
rig = bpy.data.objects['mqrig']
B = rig.data.bones


def H(n):
    return np.array(rig.matrix_world @ B[n].head_local)


def wv(name):
    o = bpy.data.objects[name]
    mw = o.matrix_world
    return np.array([mw @ v.co for v in o.data.vertices])


def ends(name, toward):
    """骨メッシュの両端（toward に近い側が先）"""
    p = wv(name)
    c = p.mean(0)
    _, _, vt = np.linalg.svd(p - c, full_matrices=False)
    t = (p - c) @ vt[0]
    r = t.max() - t.min()
    lo = p[t < t.min() + 0.15 * r].mean(0)
    hi = p[t > t.max() - 0.15 * r].mean(0)
    return (lo, hi) if np.linalg.norm(lo - toward) < np.linalg.norm(hi - toward) else (hi, lo)


J = {k: np.array(v) for k, v in json.load(open(OUT + '/joints.json'))['anat'].items()}


def skew(k):
    return np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])


def rot_between(u, v):
    u = u / np.linalg.norm(u)
    v = v / np.linalg.norm(v)
    c = np.cross(u, v)
    s = np.linalg.norm(c)
    d = float(u @ v)
    if s < 1e-9:
        return np.eye(3)
    K = skew(c / s)
    return np.eye(3) + s * K + (1 - d) * K @ K


def rot_axis(k, ang):
    K = skew(k / np.linalg.norm(k))
    return np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * K @ K


def seg(h, n, Hh, N, twist=0.0, rad=1.0):
    """安静の h→n を、目標の Hh→N へ（長さも合わせる）。rad は軸まわりの太さの倍率"""
    dr = n - h
    dt = N - Hh
    u = dr / np.linalg.norm(dr)
    s = np.linalg.norm(dt) / np.linalg.norm(dr)
    S = rad * np.eye(3) + (s - rad) * np.outer(u, u)
    R = rot_axis(dt, twist) @ rot_between(dr, dt)
    m = np.eye(4)
    m[:3, :3] = R @ S
    m[:3, 3] = Hh - (R @ S) @ h
    return m


def ap(M, p):
    return M[:3, :3] @ p + M[:3, 3]


T = {}
TWIST = {}
mv = np.array([mesh.matrix_world @ v.co for v in mesh.data.vertices])
# 胴: 股関節の中点と肩の中点を合わせる（y は傾き、z は伸縮）
hm = (H('thigh_l') + H('thigh_r')) / 2
sm = (H('upperarm_l') + H('upperarm_r')) / 2
ha = (J['hip_l'] + J['hip_r']) / 2 + np.array([0, TW.get('hip_dy', 0), TW.get('hip_dz', 0)])
sa = (J['sh_l'] + J['sh_r']) / 2 + np.array([0, TW.get('sh_dy', 0), TW.get('sh_dz', 0)])
sz = (sa[2] - ha[2]) / (sm[2] - hm[2])
b = ((sa[1] - ha[1]) - (sm[1] - hm[1])) / (sm[2] - hm[2])
A = np.eye(4)
A[0, 0] = TW.get('torso_sx', 1.0)
A[1, 1] = TW.get('torso_sy', 1.0)
A[1, 2] = b
A[2, 2] = sz
A[:3, 3] = ha - A[:3, :3] @ hm
for n in ['Root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'clavicle_r']:
    T[n] = A
# 首と頭
nk = H('neck_01')
nk_t = ap(A, nk)
szh = (J['top'][2] + TW.get('top_dz', 0) - nk_t[2]) / (mv[:, 2].max() - nk[2])
Ah = np.eye(4)
Ah[0, 0] = TW.get('head_sx', 1.0)
Ah[1, 1] = TW.get('head_sy', 1.0)
Ah[2, 2] = szh
Ah[:3, 3] = nk_t + np.array([0, TW.get('head_dy', 0), 0]) - Ah[:3, :3] @ nk
T['neck_01'] = Ah
T['head'] = Ah
FN = {'thumb': 'first', 'index': 'second', 'middle': 'third', 'ring': 'fourth', 'pinky': 'fifth'}
for s in 'lr':
    sg = 1 if s == 'l' else -1
    sh_t = ap(A, H('upperarm_' + s))
    T['upperarm_' + s] = seg(H('upperarm_' + s), H('lowerarm_' + s), sh_t, J['el_' + s], rad=TW.get('arm_rad', 1.0))
    T['lowerarm_' + s] = seg(H('lowerarm_' + s), H('hand_' + s), J['el_' + s], J['wr_' + s], rad=TW.get('arm_rad', 1.0))
    hip_t = ap(A, H('thigh_' + s))
    T['thigh_' + s] = seg(H('thigh_' + s), H('calf_' + s), hip_t, J['kn_' + s], rad=TW.get('leg_rad', 1.0))
    T['calf_' + s] = seg(H('calf_' + s), H('foot_' + s), J['kn_' + s], J['an_' + s], rad=TW.get('leg_rad', 1.0))
    # 足: かかと→つま先の向きと長さを合わせ、床に置く
    fv = mv[(mv[:, 2] < H('foot_' + s)[2] - 0.01) & (mv[:, 0] * sg > 0)]
    Mf = T['calf_' + s]
    hm_ = ap(Mf, fv[fv[:, 1].argmax()])
    tm_ = ap(Mf, fv[fv[:, 1].argmin()])
    fa = np.concatenate([wv(n) for n, o in bpy.data.objects.items() if n.endswith('.' + s) and 'cls' in o and ('of foot' in n or 'Calcaneus' in n)])
    heel_a = fa[fa[:, 1].argmax()]
    toe_a = fa[fa[:, 1].argmin()]
    d0 = (tm_ - hm_)[:2]
    d1 = (toe_a - heel_a)[:2]
    ang = math.atan2(d1[1], d1[0]) - math.atan2(d0[1], d0[0])
    sl = np.linalg.norm(d1) / np.linalg.norm(d0)
    F = np.eye(4)
    F[:3, :3] = rot_axis(np.array([0, 0, 1.0]), ang) * sl
    F[2, 2] = 1.0
    mid_m = (hm_ + tm_) / 2
    mid_a = (heel_a + toe_a) / 2
    F[:2, 3] = mid_a[:2] - (F[:3, :3] @ np.array([mid_m[0], mid_m[1], 0]))[:2]
    Tf = F @ Mf
    z0 = min(ap(Tf, p)[2] for p in fv)
    Tf[2, 3] += J['floor'][2] - z0 + TW.get('foot_dz', 0)
    T['foot_' + s] = Tf
    T['ball_' + s] = Tf
    # 手: 手首→中指の付け根。親指の向きでねじりを決める
    hd = H('hand_' + s)
    mc = H('middle_01_' + s)
    base = seg(hd, mc, J['wr_' + s], J['mcp_' + s])
    ax = J['mcp_' + s] - J['wr_' + s]
    ax /= np.linalg.norm(ax)
    th_m = ap(base, H('thumb_02_' + s)) - J['wr_' + s]
    tp, td = ends('Proximal phalanx of first finger of hand.' + s, J['wr_' + s])
    th_a = tp - J['wr_' + s]
    pm = th_m - ax * (th_m @ ax)
    pa = th_a - ax * (th_a @ ax)
    tw = math.atan2(np.cross(pm, pa) @ ax, pm @ pa) + math.radians(TW.get('twist_add', 0)) * sg
    TWIST[s] = tw
    T['hand_' + s] = seg(hd, mc, J['wr_' + s], J['mcp_' + s], twist=tw)
    print('twist', s, round(math.degrees(tw), 1))
    for f, ord_ in FN.items():
        names = [f'Proximal phalanx of {ord_} finger of hand.{s}', f'Middle phalanx of {ord_} finger of hand.{s}', f'Distal phalanx of {ord_} finger of hand.{s}']
        if f == 'thumb':
            names = [f'First metacarpal bone.{s}', names[0], names[2]]
        prev = J['wr_' + s]
        for i, nm in enumerate(names):
            bn = f'{f}_0{i + 1}_{s}'
            if nm not in bpy.data.objects:
                print('missing', nm)
                continue
            p, d = ends(nm, prev)
            hb = H(bn)
            nxt = H(f'{f}_0{i + 2}_{s}') if i < 2 else hb + (hb - H(f'{f}_0{i}_{s}')) * 0.8
            M = seg(hb, nxt, p, d)
            M[:3, :3] = rot_axis(d - p, tw) @ M[:3, :3]
            M[:3, 3] = p - M[:3, :3] @ hb
            T[bn] = M
            prev = d


def tf(n):
    while n not in T:
        n = B[n].parent.name
    return T[n]


gi = {g.index: g.name for g in mesh.vertex_groups}
out = np.zeros_like(mv)
lw = {s: np.zeros(len(mv)) for s in 'lr'}
for v in mesh.data.vertices:
    ws = [(gi[g.group], g.weight) for g in v.groups if gi[g.group] in B and g.weight > 0]
    tot = sum(w for _, w in ws) or 1.0
    p = np.zeros(3)
    for n, w in ws:
        p += w / tot * ap(tf(n), mv[v.index])
        if n.startswith('lowerarm_'):
            lw[n[-1]][v.index] = w / tot
    out[v.index] = p
# 前腕のねじり: 手のねじりを、ひじから手首へ向けて少しずつ配る
for s in 'lr':
    e = J['el_' + s]
    ax = J['wr_' + s] - e
    L = np.linalg.norm(ax)
    ax /= L
    for i in np.nonzero(lw[s] > 0)[0]:
        t = min(1, max(0, (out[i] - e) @ ax / L))
        r = out[i] - e
        along = ax * (r @ ax)
        out[i] = e + along + rot_axis(ax, TWIST[s] * t * lw[s][i]) @ (r - along)
for m in list(mesh.modifiers):
    mesh.modifiers.remove(m)
mesh.parent = None
mesh.matrix_world = Matrix.Identity(4)
for v in mesh.data.vertices:
    v.co = Vector(out[v.index])
mesh.data.update()
rig.hide_render = True
rig.hide_set(True)
if RENDER:
    m = bpy.data.materials.new('ghost')
    m.use_nodes = True
    bs = m.node_tree.nodes['Principled BSDF']
    bs.inputs['Base Color'].default_value = (0.1, 0.5, 1, 1)
    bs.inputs['Alpha'].default_value = 0.4
    m.surface_render_method = 'BLENDED'
    mesh.data.materials.clear()
    mesh.data.materials.append(m)
    zb.render_views(OUT + '/fit', views=('front', 'left'), res=(900, 1400))
    zb.render_views(OUT + '/fitarm', zc=1.15, scale=0.9, views=('front', 'back'), res=(1000, 1000))
bpy.ops.wm.save_as_mainfile(filepath=OUT + '/fit1.blend', compress=True)
