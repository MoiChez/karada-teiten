# fit1.blend（解剖モデルと、同じ姿勢にしたアプリの体）から、体の UV へ色・凹凸・陰を焼く
import bpy, sys, json, time
import numpy as np
from mathutils import Vector
a = sys.argv[sys.argv.index('--') + 1:]
sys.path.insert(0, a[0])
import zb
OUT = a[1]
RES = int(a[2]) if len(a) > 2 else 1024
ONLY = a[3].split(',') if len(a) > 3 else None
sc = bpy.context.scene
mesh = bpy.data.objects['mq']
zb.paint_anatomy()
# 筋肉ごとに少しだけ色を変える（となりの筋肉との境が見えるように）
mm = bpy.data.materials['B_muscle']
nt = mm.node_tree
bsdf = nt.nodes['Principled BSDF']
oi = nt.nodes.new('ShaderNodeObjectInfo')
ramp = nt.nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].color = (0.33, 0.035, 0.03, 1)
ramp.color_ramp.elements[1].color = (0.50, 0.085, 0.06, 1)
nt.links.new(oi.outputs['Random'], ramp.inputs['Fac'])
nt.links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])

anat = [o for o in bpy.data.objects if o.type == 'MESH' and 'cls' in o]


def center(o):
    bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return sum(bb, Vector()) / 8


SH = ('eltoid', 'ectoralis major', 'atissimus dorsi', 'Teres', 'nfraspinatus', 'upraspinatus', 'ubscapularis', 'Clavicle', 'Scapula', 'rapezius')
C = {o.name: center(o) for o in anat}


def side(o):
    n = o.name
    return 'l' if n.endswith('.l') else 'r' if n.endswith('.r') else ''


def is_sh(o):
    return any(k in o.name for k in SH)


def free_arm(o, s):
    c = C[o.name]
    return side(o) == s and abs(c.x) > 0.15 and 0.6 < c.z < 1.42 and not is_sh(o)


def hand(o, s):
    return free_arm(o, s) and C[o.name].z < 0.90


def leg(o, s):
    c = C[o.name]
    return c.z < 1.03 and (side(o) == s or (side(o) == '' and abs(c.x) < 0.05)) and abs(c.x) < 0.2


def foot(o, s):
    return leg(o, s) and C[o.name].z < 0.16


FA = {s: {o.name for o in anat if free_arm(o, s)} for s in 'lr'}
SETS = {
    'torso': ([o for o in anat if o.name not in FA['l'] and o.name not in FA['r']], 0.05),
}
for s in 'lr':
    SETS['arm_' + s] = ([o for o in anat if o.name in FA[s] or (is_sh(o) and side(o) == s)], 0.04)
    SETS['hand_' + s] = ([o for o in anat if hand(o, s)], 0.012)
    SETS['leg_' + s] = ([o for o in anat if leg(o, s)], 0.05)
    SETS['foot_' + s] = ([o for o in anat if foot(o, s)], 0.02)
print({k: len(v[0]) for k, v in SETS.items()})

# 体のどの texel がどの部位か（骨の重みの和）
gi = {g.index: g.name for g in mesh.vertex_groups}
FING = ('thumb', 'index', 'middl', 'ring_', 'pinky')


def region(n):
    s = n[-1] if n[-2:] in ('_l', '_r') else ''
    if n.startswith('hand') or n[:5] in FING:
        return 'hand_' + s
    if n.startswith(('upperarm', 'lowerarm')):
        return 'arm_' + s
    if n.startswith(('foot', 'ball')):
        return 'foot_' + s
    if n.startswith(('thigh', 'calf')):
        return 'leg_' + s
    return 'torso'


REG = list(SETS.keys())
BONES = {b.name for b in bpy.data.objects['mqrig'].data.bones}
W = np.zeros((len(mesh.data.vertices), len(REG)))
for v in mesh.data.vertices:
    for g in v.groups:
        n = gi[g.group]
        if g.weight > 0 and n in BONES:
            W[v.index, REG.index(region(n))] += g.weight
W /= np.maximum(W.sum(1, keepdims=True), 1e-9)

sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 4
sc.cycles.use_denoising = False
sc.render.bake.use_selected_to_active = True
sc.render.bake.margin = 0
sc.render.bake.use_clear = True
sc.render.bake.use_cage = False

mat = bpy.data.materials.new('bake_target')
mat.use_nodes = True
mesh.data.materials.clear()
mesh.data.materials.append(mat)
tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
mat.node_tree.nodes.active = tex


def new_img(name, noncolor=False):
    im = bpy.data.images.new(name, RES, RES, alpha=True, float_buffer=True)
    im.generated_color = (0, 0, 0, 0)
    if noncolor:
        im.colorspace_settings.name = 'Non-Color'
    return im


def px(im):
    arr = np.empty(RES * RES * 4, dtype=np.float32)
    im.pixels.foreach_get(arr)
    return arr.reshape(RES, RES, 4)


def select(objs):
    bpy.ops.object.select_all(action='DESELECT')
    vis = {o.name for o in objs}
    for o in anat:
        o.hide_render = o.name not in vis
        o.hide_set(o.name not in vis)
        if o.name in vis:
            o.select_set(True)
    mesh.hide_render = False
    mesh.hide_set(False)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh


# 部位の重みを絵にする（体そのものの色として焼く）
def bake_weights():
    out = []
    sc.render.bake.use_selected_to_active = False
    for k in range(0, len(REG), 3):
        ca = mesh.data.color_attributes.new(f'w{k}', 'FLOAT_COLOR', 'POINT')
        cols = np.ones((len(mesh.data.vertices), 4), dtype=np.float32)
        cols[:, :3] = 0
        for j in range(3):
            if k + j < len(REG):
                cols[:, j] = W[:, k + j]
        ca.data.foreach_set('color', cols.ravel())
        nt2 = mat.node_tree
        for n in [n for n in nt2.nodes if n.type in ('VERTEX_COLOR', 'EMISSION')]:
            nt2.nodes.remove(n)
        vc = nt2.nodes.new('ShaderNodeVertexColor')
        vc.layer_name = ca.name
        em = nt2.nodes.new('ShaderNodeEmission')
        nt2.links.new(vc.outputs['Color'], em.inputs['Color'])
        nt2.links.new(em.outputs['Emission'], nt2.nodes['Material Output'].inputs['Surface'])
        im = new_img(f'wimg{k}', True)
        tex.image = im
        mat.node_tree.nodes.active = tex
        bpy.ops.object.select_all(action='DESELECT')
        for o in anat:
            o.hide_render = True
        mesh.select_set(True)
        bpy.context.view_layer.objects.active = mesh
        bpy.ops.object.bake(type='EMIT')
        out.append(px(im))
        bpy.data.images.remove(im)
    sc.render.bake.use_selected_to_active = True
    wt = np.concatenate([o[:, :, :3] for o in out], axis=2)[:, :, :len(REG)]
    return wt, out[0][:, :, 3]


def dbg(name, arr):
    h, w = arr.shape[:2]
    rgba = np.ones((h, w, 4), dtype=np.float32)
    if arr.ndim == 2:
        rgba[:, :, :3] = arr[:, :, None]
    else:
        rgba[:, :, :arr.shape[2]] = arr[:, :, :4]
    im = bpy.data.images.new('dbg', w, h, alpha=True)
    im.pixels.foreach_set(rgba.ravel())
    im.filepath_raw = OUT + '/dbg_' + name + '.png'
    im.file_format = 'PNG'
    im.save()
    bpy.data.images.remove(im)


t0 = time.time()
wt, cover = bake_weights()
for i_ in range(0, len(REG), 3):
    dbg('w%d' % i_, wt[:, :, i_:i_ + 3])
print('weights', round(time.time() - t0), 's', 'cover', float((cover > 0.5).mean()))
acc = {'col': np.zeros((RES, RES, 3)), 'nor': np.zeros((RES, RES, 3)), 'ao': np.zeros((RES, RES)), 'w': np.zeros((RES, RES))}
for ri, r in enumerate(REG):
    if ONLY and r not in ONLY:
        continue
    objs, ext = SETS[r]
    if wt[:, :, ri].max() <= 0 or not objs:
        continue
    select(objs)
    sc.render.bake.cage_extrusion = ext
    sc.render.bake.max_ray_distance = ext * 2.6
    res = {}
    for kind in ('col', 'nor', 'ao'):
        im = new_img(kind + r, kind != 'col')
        tex.image = im
        mat.node_tree.nodes.active = tex
        if kind == 'col':
            sc.cycles.samples = 4
            bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'})
        elif kind == 'nor':
            sc.cycles.samples = 4
            bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT')
        else:
            sc.cycles.samples = 24
            bpy.ops.object.bake(type='AO')
        res[kind] = px(im)
        bpy.data.images.remove(im)
    dbg('col_' + r, res['col'])
    print(r, 'alpha', float(res['col'][:, :, 3].min()), float(res['col'][:, :, 3].max()), float(res['col'][:, :, 3].mean()), 'wmax', float(wt[:, :, ri].max()), float((wt[:, :, ri] > 0.5).mean()))
    hit = (res['col'][:, :, 3] > 0.5).astype(np.float64)
    w = wt[:, :, ri] * hit
    acc['col'] += res['col'][:, :, :3] * w[:, :, None]
    acc['nor'] += (res['nor'][:, :, :3] * 2 - 1) * w[:, :, None]
    acc['ao'] += res['ao'][:, :, 0] * w
    acc['w'] += w
    print(r, 'hit', round(float((hit * (wt[:, :, ri] > 0.5)).sum() / max(1, (wt[:, :, ri] > 0.5).sum())), 3), round(time.time() - t0), 's')
np.savez_compressed(OUT + f'/bake_{RES}.npz', col=acc['col'].astype(np.float32), nor=acc['nor'].astype(np.float32), ao=acc['ao'].astype(np.float32), w=acc['w'].astype(np.float32), cover=cover.astype(np.float32))
print('done', round(time.time() - t0), 's')
