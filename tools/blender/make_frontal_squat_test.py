# 正面・背面から撮ったスクワットの左右差の計算を試すための動画を作る。アプリの動作確認用で、配信はしない。
# マネキンがバーを担ぐ形で 4 回しゃがみ、しゃがむほど、腰が体の左へずれ、左の膝が内側へ入り、肩が左へ傾く。
#
# 使い方（Blender 5.2 で）:
#   blender -b --python tools/blender/make_frontal_squat_test.py -- public/models/mannequin-v1-male.glb out.mp4 rear|front [preview]
#
# 正解の値（骨の関節の位置から求めた、正面から見た値）をコマごとに out.csv に書き、1 回ごとのいちばん深いところの値を表示する。
# 推定の点（MediaPipe）は骨の関節と位置が違うので、アプリの値とは少しずれる
import csv
import math
import sys

import bpy
from mathutils import Quaternion, Vector

args = sys.argv[sys.argv.index('--') + 1:]
GLB, OUT, VIEW = args[0], args[1], args[2]
PREVIEW = len(args) > 3 and args[3] == 'preview'
assert VIEW in ('rear', 'front')

FPS = 30
REPS = [80.0, 100.0, 110.0, 100.0]  # 1 回ごとの膝の曲がりの最大（度）
SHIN_K = 0.42
TRUNK_K = 0.40
REP_SEC = 2.4
GAP_SEC = 0.6
EDGE_SEC = 1.0
CAM_DIST = 3.0
SHIFT_M = 0.06  # いちばん深いとき（膝 110°）の、腰の体の左へのずれ（メートル）
VALGUS_M = 0.06  # 同じく、左の膝が内側へ入る量（メートル）
TILT_DEG = 6.0  # 同じく、肩の傾き（左が下がる）
STANCE = 0.16  # 足首を体の中心から左右に開く量（メートル）

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
arm.rotation_mode = 'XYZ'
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
scene = bpy.context.scene
view_layer = bpy.context.view_layer

mat = bpy.data.materials.new('skin')
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get('Principled BSDF')
bsdf.inputs['Base Color'].default_value = (0.72, 0.55, 0.45, 1)
bsdf.inputs['Roughness'].default_value = 0.6
dark = bpy.data.materials.new('hair_shoes')
dark.use_nodes = True
dark.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (0.06, 0.05, 0.05, 1)
for m in meshes:
    m.data.materials.clear()
    m.data.materials.append(mat)
    m.data.materials.append(dark)
    # 後ろ姿でも頭と足が分かるように、頭の後ろ半分と上（髪）と、足（靴）を暗くする。人形は -Y を向いている
    groups = {g.name: g.index for g in m.vertex_groups}
    def weight(v, names):
        return sum(e.weight for e in v.groups if e.group in [groups[n] for n in names if n in groups])
    verts = m.data.vertices
    for poly in m.data.polygons:
        vs = [verts[i] for i in poly.vertices]
        head = sum(weight(v, ['head']) for v in vs) / len(vs)
        feet = sum(weight(v, ['foot_l', 'foot_r', 'ball_l', 'ball_r']) for v in vs) / len(vs)
        if (head > 0.6 and poly.normal.y > -0.25) or feet > 0.5:
            poly.material_index = 1

pb = arm.pose.bones
to_arm = arm.matrix_world.to_3x3().inverted()
X = (to_arm @ Vector((1, 0, 0))).normalized()  # 体の左（+X）
Y = (to_arm @ Vector((0, 1, 0))).normalized()  # 体の後ろ（体は -Y を向く）
Z = (to_arm @ Vector((0, 0, 1))).normalized()


def rot_x(deg_forward):
    return Quaternion(X, -math.radians(deg_forward))


def rot_up(deg_forward):
    return Quaternion(X, math.radians(deg_forward))


def set_abs(name, q):
    b = pb[name]
    rest = b.bone.matrix_local.to_3x3()
    m = (q.to_matrix() @ rest).to_4x4()
    m.translation = b.matrix.translation
    b.matrix = m
    view_layer.update()


def set_dir(name, d):
    """骨の向きを、アーマチュアの座標の向き d にする"""
    b = pb[name].bone
    rest = (b.tail_local - b.head_local).normalized()
    set_abs(name, rest.rotation_difference(d.normalized()))


def wpos(name, tail=False):
    b = pb[name]
    return arm.matrix_world @ (b.tail if tail else b.head)


def bone_len(name):
    b = pb[name].bone
    return (b.tail_local - b.head_local).length * arm.matrix_world.to_scale().x


def knee_at(t):
    u = t - EDGE_SEC
    if u < 0:
        return 0.0
    k = int(u // (REP_SEC + GAP_SEC))
    if k >= len(REPS):
        return 0.0
    w = u - k * (REP_SEC + GAP_SEC)
    if w > REP_SEC:
        return 0.0
    return REPS[k] * (1 - math.cos(2 * math.pi * w / REP_SEC)) / 2


def reset():
    for b in pb:
        b.rotation_mode = 'QUATERNION'
        b.rotation_quaternion = Quaternion()
        b.location = Vector()
    arm.location = Vector()
    view_layer.update()


def solve_leg(side, hip_w, ankle_w, pole_w):
    """股関節と足首（世界の座標）から、太ももとすねの長さを保つ膝の位置を求め、骨を向ける"""
    l1 = bone_len(f'thigh_{side}')
    l2 = bone_len(f'calf_{side}')
    d = ankle_w - hip_w
    dist = min(d.length, l1 + l2 - 1e-4)
    u = d.normalized()
    a = (dist * dist + l1 * l1 - l2 * l2) / (2 * dist)
    h = math.sqrt(max(0.0, l1 * l1 - a * a))
    p = pole_w - u * pole_w.dot(u)
    p.normalize()
    knee_w = hip_w + u * a + p * h
    m = arm.matrix_world.to_3x3().inverted()
    set_dir(f'thigh_{side}', m @ (knee_w - hip_w))
    set_dir(f'calf_{side}', m @ (ankle_w - wpos(f'calf_{side}')))
    set_abs(f'foot_{side}', Quaternion())


def pose(knee):
    """膝の曲がり knee（度）の姿勢。しゃがむほど、腰が体の左へ、左の膝が内側へ、肩が左へ傾く"""
    reset()
    s = knee / max(REPS)
    lean = knee * TRUNK_K
    set_abs('spine_01', rot_up(lean * 0.6))
    set_abs('spine_02', rot_up(lean * 0.85))
    # 肩の傾き: 前後の軸（Y）まわりに回す
    set_abs('spine_03', Quaternion(Y, math.radians(TILT_DEG * s)) @ rot_up(lean))
    set_abs('neck_01', rot_up(lean * 0.5))
    set_abs('head', rot_up(lean * 0.2))
    # 腕はバーを担ぐ形（ひじは横・下・後ろへ、前腕は上へ。手は肩より少し上で、肩幅より広く）
    for side in 'lr':
        sg = 1 if side == 'l' else -1
        set_dir(f'upperarm_{side}', sg * X * 0.75 - Z * 0.75 + Y * 0.45)
        set_dir(f'lowerarm_{side}', Z * 1.0 + sg * X * 0.25 + Y * 0.1)
        set_dir(f'hand_{side}', Z * 0.6 + sg * X * 0.2)
    # まず腰の高さを決める（すねの前傾と太ももの振れから、横から見た脚の形）
    shin = knee * SHIN_K
    for side in 'lr':
        set_abs(f'thigh_{side}', rot_x(knee - shin))
        set_abs(f'calf_{side}', rot_x(-shin))
        set_abs(f'foot_{side}', Quaternion())
    # 足首を左右に開いた位置に置き、腰を左へずらして、脚を解き直す
    a0 = (wpos('foot_l') + wpos('foot_r')) / 2
    low = min(wpos(n, tail).z for n in ('foot_l', 'foot_r', 'ball_l', 'ball_r') for tail in (False, True))
    arm.location = Vector((-a0.x + SHIFT_M * s, -a0.y, -low))
    view_layer.update()
    for side in 'lr':
        sg = 1 if side == 'l' else -1
        ankle = Vector((sg * STANCE, wpos(f'foot_{side}').y, wpos(f'foot_{side}').z))
        # 膝の向き（前と、少し外）。左の膝は、しゃがむほど内側へ
        pole = Vector((0, -1, 0)) + Vector((sg * 0.35, 0, 0))
        if side == 'l':
            pole += Vector((-VALGUS_M * s / 0.06 * 0.9, 0, 0))
        solve_leg(side, wpos(f'thigh_{side}'), ankle, pole)


def truth():
    """骨の関節の位置から、正面から見た値（体の左が +）を求める"""
    hl, hr = wpos('thigh_l'), wpos('thigh_r')
    kl, kr = wpos('calf_l'), wpos('calf_r')
    al, ar = wpos('foot_l'), wpos('foot_r')
    sl, sr = wpos('upperarm_l'), wpos('upperarm_r')
    stance = al.x - ar.x
    return {
        'hipH': (hl.z + hr.z) / 2 - (al.z + ar.z) / 2,
        'hip_shift': ((hl.x + hr.x) / 2 - (al.x + ar.x) / 2) / stance * 100,
        'knee_ratio': (kl.x - kr.x) / stance,
        'knee_l_out': (kl.x - al.x) / stance * 100,
        'knee_r_out': (ar.x - kr.x) / stance * 100,
        'pelvis_tilt': math.degrees(math.atan2(hl.z - hr.z, hl.x - hr.x)),
        'shoulder_tilt': math.degrees(math.atan2(sl.z - sr.z, sl.x - sr.x)),
    }


total = EDGE_SEC * 2 + len(REPS) * REP_SEC + (len(REPS) - 1) * GAP_SEC
n_frames = int(total * FPS) + 1
rows = []
pose(0)
leg0 = truth()['hipH']
for f in range(n_frames):
    t = f / FPS
    pose(knee_at(t))
    g = truth()
    g['depth'] = (leg0 - g['hipH']) / leg0 * 100
    rows.append((t, g))
    arm.keyframe_insert('location', frame=f + 1)
    for b in pb:
        b.keyframe_insert('rotation_quaternion', frame=f + 1)

KEYS = ('depth', 'hip_shift', 'knee_ratio', 'knee_l_out', 'knee_r_out', 'pelvis_tilt', 'shoulder_tilt')
with open(OUT.replace('.mp4', '.csv'), 'w', newline='') as fh:
    w = csv.writer(fh)
    w.writerow(['t_ms', *KEYS])
    for t, g in rows:
        w.writerow([round(t * 1000), *(round(g[k], 3) for k in KEYS)])

for k in range(len(REPS)):
    a = EDGE_SEC + k * (REP_SEC + GAP_SEC)
    seg = [g for t, g in rows if a <= t <= a + REP_SEC]
    bottom = max(seg, key=lambda g: g['depth'])
    print('GT rep', k + 1, ' '.join(f'{key}={bottom[key]:.2f}' for key in KEYS))

# 床・壁・光・カメラ（後ろ: 体の後ろ +Y から、前: 体の前 -Y から。腰の高さ、縦長）
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
floor = bpy.context.object
fm = bpy.data.materials.new('floor')
fm.use_nodes = True
fm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.55, 0.55, 0.52, 1)
floor.data.materials.append(fm)
back = -1.8 if VIEW == 'rear' else 1.8
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, back, 3), rotation=(math.pi / 2, 0, 0))
wall = bpy.context.object
wm = bpy.data.materials.new('wall')
wm.use_nodes = True
wm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.62, 0.74, 0.84, 1)
wall.data.materials.append(wm)
world = bpy.data.worlds.new('w')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.8, 0.8, 0.8, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
scene.world = world
bpy.ops.object.light_add(type='SUN', location=(2, 3, 5), rotation=(math.radians(40), math.radians(20), math.radians(30)))
bpy.context.object.data.energy = 3.0
# カメラの側からも照らす（体が背景に沈まないように）
bpy.ops.object.light_add(type='SUN', location=(0, 0, 5), rotation=(math.radians(-60 if VIEW == 'rear' else 60), 0, 0))
bpy.context.object.data.energy = 2.5
if VIEW == 'rear':
    bpy.ops.object.camera_add(location=(0, CAM_DIST, 0.9), rotation=(math.pi / 2, 0, math.pi))
else:
    bpy.ops.object.camera_add(location=(0, -CAM_DIST, 0.9), rotation=(math.pi / 2, 0, 0))
cam = bpy.context.object
cam.data.lens = 35
cam.data.sensor_width = 36
scene.camera = cam

scene.render.engine = 'BLENDER_EEVEE'
try:
    scene.eevee.taa_render_samples = 16
except AttributeError:
    pass
scene.render.resolution_x = 540
scene.render.resolution_y = 960
scene.render.fps = FPS
scene.frame_start = 1
scene.frame_end = n_frames

if PREVIEW:
    scene.render.image_settings.file_format = 'PNG'
    for k, frac in enumerate((0.05, 0.62, 0.45)):
        scene.frame_set(max(1, int(n_frames * frac)))
        scene.render.filepath = OUT.replace('.mp4', f'_{k + 1}.png')
        bpy.ops.render.render(write_still=True)
else:
    try:
        scene.render.image_settings.media_type = 'VIDEO'
    except (AttributeError, TypeError):
        pass
    scene.render.image_settings.file_format = 'FFMPEG'
    scene.render.ffmpeg.format = 'MPEG4'
    scene.render.ffmpeg.codec = 'H264'
    scene.render.ffmpeg.constant_rate_factor = 'HIGH'
    scene.render.filepath = OUT
    bpy.ops.render.render(animation=True)
print('done', n_frames, 'frames')
