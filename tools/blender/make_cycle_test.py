# 動き（ローイングエルゴ・固定式の自転車）の計算を試すための動画を作る。アプリの動作確認用で、配信はしない。
# マネキンだけを動かす（器具は置かない）。
#
# 使い方（Blender 5.2 で）:
#   blender -b --python tools/blender/make_cycle_test.py -- erg  public/models/mannequin-v1-male.glb out.mp4 [preview]
#   blender -b --python tools/blender/make_cycle_test.py -- bike public/models/mannequin-v1-male.glb out.mp4 [preview]
#
# 正解の値（骨の関節の位置から求めた、横から見た角度）を out.csv に書き、区切りごとの値を表示する。
# 推定の点（MediaPipe）は骨の関節と位置が違うので、アプリの値とは数度ずれる
import csv
import math
import sys

import bpy
from mathutils import Quaternion, Vector

args = sys.argv[sys.argv.index('--') + 1:]
MODE, GLB, OUT = args[0], args[1], args[2]
PREVIEW = len(args) > 3 and args[3] == 'preview'
FPS = 30

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
X = (to_arm @ Vector((1, 0, 0))).normalized()  # 体の左右の軸（体の左が +X）
Y = (to_arm @ Vector((0, 1, 0))).normalized()  # 前後の軸（体は -Y を向く）
Z = (to_arm @ Vector((0, 0, 1))).normalized()
FWD = -Y


def rot_up(deg_forward):
    """上を向いた骨（背骨・首）を前へ倒す回転（度）"""
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


def reset():
    for b in pb:
        b.rotation_mode = 'QUATERNION'
        b.rotation_quaternion = Quaternion()
        b.location = Vector()
    arm.location = Vector()
    view_layer.update()


def sag(fwd, up):
    """横から見た面の中の向き（前へ fwd、上へ up）"""
    return FWD * fwd + Z * up


def ik(a, b, l1, l2, bend_fwd):
    """a と b（前, 上）を長さ l1・l2 の 2 本でつなぐときの、間の関節の位置。bend_fwd が真なら前側（膝）、偽なら後ろ・下側（ひじ）へ曲げる"""
    dx, dz = b[0] - a[0], b[1] - a[1]
    d = min(math.hypot(dx, dz), l1 + l2 - 1e-4)
    base = math.atan2(dz, dx)
    alpha = math.acos((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))
    c1 = (a[0] + l1 * math.cos(base + alpha), a[1] + l1 * math.sin(base + alpha))
    c2 = (a[0] + l1 * math.cos(base - alpha), a[1] + l1 * math.sin(base - alpha))
    if bend_fwd:
        return c1 if c1[0] + c1[1] > c2[0] + c2[1] else c2
    return c1 if c1[1] < c2[1] else c2


reset()
L_THIGH = (wpos('thigh_l') - wpos('calf_l')).length
L_SHIN = (wpos('calf_l') - wpos('foot_l')).length
L_UPPER = (wpos('upperarm_l') - wpos('lowerarm_l')).length
L_FORE = (wpos('lowerarm_l') - wpos('hand_l')).length
LEG = L_THIGH + L_SHIN


def smooth(u):
    u = max(0.0, min(1.0, u))
    return u * u * (3 - 2 * u)


def span(s, a, b):
    return smooth((s - a) / (b - a))


def pose_legs(hip_to_ankle):
    """股関節から足首への向き（前, 上）ごとに、脚を 2 本の骨で組む（左右別）"""
    for side in 'lr':
        d = hip_to_ankle[side]
        k = ik((0, 0), d, L_THIGH, L_SHIN, True)
        set_dir(f'thigh_{side}', sag(k[0], k[1]))
        set_dir(f'calf_{side}', sag(d[0] - k[0], d[1] - k[1]))


def pose_arms(target_fwd_up):
    """肩から手首への向き（前, 上）に、腕を 2 本の骨で組む。ひじは下へ曲げる"""
    for side in 'lr':
        s = 1 if side == 'l' else -1
        e = ik((0, 0), target_fwd_up, L_UPPER, L_FORE, False)
        out = s * 0.06 * X
        set_dir(f'upperarm_{side}', sag(e[0], e[1]) + out)
        fore = sag(target_fwd_up[0] - e[0], target_fwd_up[1] - e[1])
        set_dir(f'lowerarm_{side}', fore - out)
        set_dir(f'hand_{side}', fore)


def pose_trunk(lean):
    set_abs('spine_01', rot_up(lean * 0.6))
    set_abs('spine_02', rot_up(lean * 0.85))
    set_abs('spine_03', rot_up(lean))
    set_abs('neck_01', rot_up(lean * 0.5))
    set_abs('head', rot_up(lean * 0.2))


def fa(v):
    """ワールドの点を（前, 上）にする"""
    return (-v.y, v.z)


# ---------- エルゴ ----------
ERG_T, ERG_DRIVE, ERG_STROKES = 2.4, 0.9, 6
ERG_SEAT = (0.42, 0.80)  # 足首から腰までの後ろへの距離（キャッチ, フィニッシュ）
ERG_LEAN = (28.0, -18.0)  # 上体の前傾（キャッチ, フィニッシュ）
ERG_ANKLE = Vector((0, 0, 0.40))  # 足首を固定する位置


def erg_s(t):
    u = t % ERG_T
    return u / ERG_DRIVE if u <= ERG_DRIVE else 1 - (u - ERG_DRIVE) / (ERG_T - ERG_DRIVE)


def pose_erg(t):
    reset()
    s = erg_s(t)
    seat = ERG_SEAT[0] + (ERG_SEAT[1] - ERG_SEAT[0]) * span(s, 0, 0.6)
    lean = ERG_LEAN[0] + (ERG_LEAN[1] - ERG_LEAN[0]) * span(s, 0.3, 0.8)
    pose_trunk(lean)
    d = (seat, -0.10)  # 足首は腰より前、少し下
    pose_legs({'l': d, 'r': d})
    for side in 'lr':
        set_dir(f'foot_{side}', sag(0.75, 0.66))
    # 手はハンドルの高さ（腰より 0.26 上）。腕を伸ばした届きから、引くほど体へ近づく
    sh = fa(wpos('upperarm_l'))
    hp = fa(wpos('thigh_l'))
    up = (hp[1] + 0.26) - sh[1]
    reach_max = math.sqrt(max(0.01, (L_UPPER + L_FORE - 0.01) ** 2 - up * up))
    reach = reach_max - (reach_max - 0.16) * span(s, 0.6, 1)
    pose_arms((reach, up))
    a = (wpos('foot_l') + wpos('foot_r')) / 2
    arm.location = ERG_ANKLE - a
    view_layer.update()


# ---------- 自転車 ----------
BIKE_T, BIKE_SEC = 60 / 90, 8.0
BIKE_R = 0.17
BIKE_CRANK = (0.15, -0.62)  # 股関節から見たクランクの軸（前, 上）
BIKE_HIP = Vector((0, 0, 0.95))
BIKE_BAR = (0.52, 0.22)  # 股関節から見た手首の位置（前, 上）


def pose_bike(t):
    reset()
    pose_trunk(45)
    # (前, 上) の円で、上（90°）→ 前（0°）→ 下と回るよう、角度を減らしていく（前にこぐ向き）
    th = -2 * math.pi * t / BIKE_T
    d = {}
    for side, ph in (('l', 0.0), ('r', math.pi)):
        d[side] = (BIKE_CRANK[0] + BIKE_R * math.cos(th + ph), BIKE_CRANK[1] + BIKE_R * math.sin(th + ph))
    pose_legs(d)
    for side, ph in (('l', 0.0), ('r', math.pi)):
        tilt = math.radians(15 + 10 * math.sin(th + ph))
        set_dir(f'foot_{side}', sag(math.cos(tilt), -math.sin(tilt)))
    sh = fa(wpos('upperarm_l'))
    hp = fa(wpos('thigh_l'))
    pose_arms((hp[0] + BIKE_BAR[0] - sh[0], hp[1] + BIKE_BAR[1] - sh[1]))
    h = (wpos('thigh_l') + wpos('thigh_r')) / 2
    arm.location = BIKE_HIP - h
    view_layer.update()


# ---------- 正解 ----------

def interior(a, b, c):
    v1 = Vector((0, a.y - b.y, a.z - b.z))
    v2 = Vector((0, c.y - b.y, c.z - b.z))
    return math.degrees(v1.angle(v2))


def truth():
    hip, kn, an = wpos('thigh_l'), wpos('calf_l'), wpos('foot_l')
    sh, el, wr = wpos('upperarm_l'), wpos('lowerarm_l'), wpos('hand_l')
    toe = wpos('ball_l', True)
    d = sh - hip
    return {
        'knee': 180 - interior(hip, kn, an),
        'hip': 180 - interior(sh, hip, kn),
        'trunk': math.degrees(math.atan2(-d.y, d.z)),
        'elbow': 180 - interior(sh, el, wr),
        'ankle': interior(kn, an, toe),
        'handle': (wr.y - an.y) / LEG * 100,
        'seat': (hip.y - an.y) / LEG * 100,
    }


if MODE == 'erg':
    total = ERG_T * ERG_STROKES
    pose_at = pose_erg
    keys = ['knee', 'hip', 'trunk', 'elbow', 'handle', 'seat']
    res = (960, 540)
    cam_loc, lens = (2.9, 0.35, 0.8), 30
else:
    total = BIKE_SEC
    pose_at = pose_bike
    keys = ['knee', 'hip', 'ankle', 'trunk']
    res = (960, 540)
    cam_loc, lens = (2.6, -0.2, 0.75), 30

n_frames = int(total * FPS) + 1
rows = []
for f in range(n_frames):
    t = f / FPS
    pose_at(t)
    rows.append((t, truth()))
    arm.keyframe_insert('location', frame=f + 1)
    for b in pb:
        b.keyframe_insert('rotation_quaternion', frame=f + 1)

with open(OUT.replace('.mp4', '.csv'), 'w', newline='') as fh:
    w = csv.writer(fh)
    w.writerow(['t_ms', *keys])
    for t, g in rows:
        w.writerow([round(t * 1000), *(round(g[k], 2) for k in keys)])

if MODE == 'erg':
    for k in range(ERG_STROKES):
        c = min(rows, key=lambda r: abs(r[0] - k * ERG_T))[1]
        fin = min(rows, key=lambda r: abs(r[0] - (k * ERG_T + ERG_DRIVE)))[1]
        print('GT stroke', k + 1, f"knee_catch={c['knee']:.1f} hip_catch={c['hip']:.1f} trunk_catch={c['trunk']:.1f} trunk_finish={fin['trunk']:.1f} elbow_finish={fin['elbow']:.1f} length={fin['handle'] - c['handle']:.1f}")
    print(f'GT rate={60 / ERG_T:.1f} drive={ERG_DRIVE} recovery={ERG_T - ERG_DRIVE:.2f} leg={LEG:.3f}')
else:
    kn = [g['knee'] for _, g in rows]
    hp = [g['hip'] for _, g in rows]
    an = [g['ankle'] for _, g in rows]
    print(f"GT cadence={60 / BIKE_T:.1f} knee_bdc={min(kn):.1f} knee_tdc={max(kn):.1f} hip_open={min(hp):.1f} hip_closed={max(hp):.1f} ankle_range={max(an) - min(an):.1f} trunk={sum(g['trunk'] for _, g in rows) / len(rows):.1f} leg={LEG:.3f}")

# 床・壁・光・カメラ（体の左側から撮る。横長）
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
bpy.ops.object.camera_add(location=cam_loc, rotation=(math.pi / 2, 0, math.pi / 2))
cam = bpy.context.object
cam.data.lens = lens
cam.data.sensor_width = 36
scene.camera = cam

scene.render.engine = 'BLENDER_EEVEE'
try:
    scene.eevee.taa_render_samples = 16
except AttributeError:
    pass
scene.render.resolution_x, scene.render.resolution_y = res
scene.render.fps = FPS
scene.frame_start = 1
scene.frame_end = n_frames

if PREVIEW:
    scene.render.image_settings.file_format = 'PNG'
    fr = (1, int(ERG_DRIVE * FPS) + 1, int(ERG_T * FPS * 0.75)) if MODE == 'erg' else (1, int(BIKE_T * FPS * 0.25) + 1, int(BIKE_T * FPS * 0.5) + 1)
    for k, f in enumerate(fr):
        scene.frame_set(f)
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
