# 動き（スクワット）の計算を試すための動画（マネキンが横向きで 4 回しゃがむ）を作る。アプリの動作確認用で、配信はしない。
#
# 使い方（Blender 5.2 で）:
#   blender -b --python tools/blender/make_squat_test.py -- public/models/mannequin-v1-male.glb out.mp4 [preview]
#   preview を付けると、動画の代わりに数コマを PNG で書き出す（out.mp4 の名前に _1.png などを付ける）
#
# 正解の値（骨の関節の位置から求めた、横から見た角度。1 回ごとの最大）を最後に表示し、コマごとの値を out.csv に書く。
# 推定の点（MediaPipe）は骨の関節と位置が違うので、アプリの値とは数度ずれる
import csv
import math
import sys

import bpy
from mathutils import Quaternion, Vector

args = sys.argv[sys.argv.index('--') + 1:]
GLB, OUT = args[0], args[1]
PREVIEW = len(args) > 2 and args[2] == 'preview'

FPS = 30
REPS = [60.0, 90.0, 110.0, 100.0]  # 1 回ごとの膝の曲がりの最大（度）
SHIN_K = 0.42  # すねの前傾 = 膝の曲がり × これ
TRUNK_K = 0.40  # 上体の前傾 = 膝の曲がり × これ（背骨 3 本に分ける）
REP_SEC = 2.4  # 1 回の長さ（しゃがんで立つまで）
GAP_SEC = 0.6  # 回の間に立っている時間
EDGE_SEC = 1.0  # 最初と最後に立っている時間
CAM_DIST = 2.8

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
for m in meshes:
    m.data.materials.clear()
    m.data.materials.append(mat)

pb = arm.pose.bones
to_arm = arm.matrix_world.to_3x3().inverted()
X = (to_arm @ Vector((1, 0, 0))).normalized()  # 体の左右の軸（アーマチュアの座標）
Y = (to_arm @ Vector((0, 1, 0))).normalized()  # 前後の軸（体は -Y を向く）
Z = (to_arm @ Vector((0, 0, 1))).normalized()


def rot_x(deg_forward):
    """下を向いた骨（脚）を前へ振る回転（度）。体は -Y を向いているので、X 軸まわりに負に回すと前へ振れる"""
    return Quaternion(X, -math.radians(deg_forward))


def rot_up(deg_forward):
    """上を向いた骨（背骨・首）を前へ倒す回転（度）。下を向いた骨とは回す向きが逆になる"""
    return Quaternion(X, math.radians(deg_forward))


def set_abs(name, q):
    b = pb[name]
    rest = b.bone.matrix_local.to_3x3()
    m = (q.to_matrix() @ rest).to_4x4()
    m.translation = b.matrix.translation
    b.matrix = m
    view_layer.update()


def set_dir(name, d):
    b = pb[name].bone
    rest = (b.tail_local - b.head_local).normalized()
    set_abs(name, rest.rotation_difference(d.normalized()))


def wpos(name, tail=False):
    b = pb[name]
    return arm.matrix_world @ (b.tail if tail else b.head)


def knee_at(t):
    """時刻 t（秒）の膝の曲がり（度）。立つ → 4 回しゃがむ → 立つ"""
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


def pose(knee):
    for b in pb:
        b.rotation_mode = 'QUATERNION'
        b.rotation_quaternion = Quaternion()
        b.location = Vector()
    view_layer.update()
    shin = knee * SHIN_K
    lean = knee * TRUNK_K
    set_abs('spine_01', rot_up(lean * 0.6))
    set_abs('spine_02', rot_up(lean * 0.85))
    set_abs('spine_03', rot_up(lean))
    # 顔は前を向いたまま
    set_abs('neck_01', rot_up(lean * 0.5))
    set_abs('head', rot_up(lean * 0.2))
    for side in 'lr':
        thigh = knee - shin  # 太ももの前への振れ（鉛直下向きから）
        set_abs(f'thigh_{side}', rot_x(thigh))
        set_abs(f'calf_{side}', rot_x(-shin))
        set_abs(f'foot_{side}', rot_x(0))
        # 腕は前へ水平に伸ばす
        s = 1 if side == 'l' else -1
        fwd = -Y + s * 0.12 * X
        set_dir(f'upperarm_{side}', fwd)
        set_dir(f'lowerarm_{side}', fwd)
        set_dir(f'hand_{side}', fwd)


def place():
    """足首が同じ位置（原点の上）に来て、いちばん低い足が床に着くように体を動かす"""
    arm.location = Vector()
    view_layer.update()
    a = (wpos('foot_l') + wpos('foot_r')) / 2
    low = min(wpos(n, tail).z for n in ('foot_l', 'foot_r', 'ball_l', 'ball_r') for tail in (False, True))
    arm.location = Vector((-a.x, -a.y, -low))
    view_layer.update()


def ang_vertical(frm, to):
    """frm → to の、鉛直上向きからの角度（前 = -Y が +）"""
    d = to - frm
    return math.degrees(math.atan2(-d.y, d.z))


def interior(a, b, c):
    v1 = Vector((0, a.y - b.y, a.z - b.z))
    v2 = Vector((0, c.y - b.y, c.z - b.z))
    return math.degrees(v1.angle(v2))


def truth():
    """カメラ側（左）の骨の関節の位置から、横から見た値を求める"""
    hip = wpos('thigh_l')
    kn = wpos('calf_l')
    an = wpos('foot_l')
    sh = wpos('upperarm_l')
    return {
        'knee': 180 - interior(hip, kn, an),
        'hip': 180 - interior(sh, hip, kn),
        'trunk': ang_vertical(hip, sh),
        'shin': ang_vertical(an, kn),
        'hipH': hip.z - an.z,
    }


total = EDGE_SEC * 2 + len(REPS) * REP_SEC + (len(REPS) - 1) * GAP_SEC
n_frames = int(total * FPS) + 1
rows = []
pose(0)
place()
leg0 = truth()['hipH']
for f in range(n_frames):
    t = f / FPS
    pose(knee_at(t))
    place()
    g = truth()
    g['depth'] = (leg0 - g['hipH']) / leg0 * 100
    rows.append((t, g))
    arm.keyframe_insert('location', frame=f + 1)
    for b in pb:
        b.keyframe_insert('rotation_quaternion', frame=f + 1)

with open(OUT.replace('.mp4', '.csv'), 'w', newline='') as fh:
    w = csv.writer(fh)
    w.writerow(['t_ms', 'depth', 'knee', 'hip', 'trunk', 'shin'])
    for t, g in rows:
        w.writerow([round(t * 1000), *(round(g[k], 2) for k in ('depth', 'knee', 'hip', 'trunk', 'shin'))])

for k in range(len(REPS)):
    a = EDGE_SEC + k * (REP_SEC + GAP_SEC)
    seg = [g for t, g in rows if a <= t <= a + REP_SEC]
    print('GT rep', k + 1, ' '.join(f'{key}={max(g[key] for g in seg):.1f}' for key in ('depth', 'knee', 'hip', 'trunk', 'shin')))

# 床・壁・光・カメラ（体の左側から、腰の高さで撮る。縦長）
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
floor = bpy.context.object
fm = bpy.data.materials.new('floor')
fm.use_nodes = True
fm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.55, 0.55, 0.52, 1)
floor.data.materials.append(fm)
bpy.ops.mesh.primitive_plane_add(size=30, location=(-1.6, 0, 3), rotation=(0, math.pi / 2, 0))
wall = bpy.context.object
wm = bpy.data.materials.new('wall')
wm.use_nodes = True
wm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.85, 0.85, 0.82, 1)
wall.data.materials.append(wm)
world = bpy.data.worlds.new('w')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.8, 0.8, 0.8, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
scene.world = world
bpy.ops.object.light_add(type='SUN', location=(3, 2, 5), rotation=(math.radians(40), math.radians(30), 0))
bpy.context.object.data.energy = 3.0
bpy.ops.object.camera_add(location=(CAM_DIST, -0.2, 0.9), rotation=(math.pi / 2, 0, math.pi / 2))
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
