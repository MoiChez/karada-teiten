# 歩き方の計算を試すための動画（マネキンが横から見て往復して歩く）を作る。アプリの動作確認用で、配信はしない。
#
# 使い方（Blender 5.2 で）:
#   blender -b --python tools/blender/make_walk_test.py -- public/models/mannequin-v1-male.glb out.mp4 [preview]
#   preview を付けると、動画の代わりに数コマを PNG で書き出す（out.mp4 の名前に _1.png などを付ける）
#
# 正解の値（テンポ・上体の傾き・歩幅の目安）を最後に表示する。歩き方は単純な周期の動きで、実際の人の歩き方ではない
import math
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

args = sys.argv[sys.argv.index('--') + 1:]
GLB, OUT = args[0], args[1]
PREVIEW = len(args) > 2 and args[2] == 'preview'

CADENCE = 110  # 歩/分
LEAN_DEG = 6  # 上体（腰から肩）の前傾
HIP_MEAN, HIP_AMP = 7.0, 18.0  # 股関節の曲げ（前が +）の平均と振れ幅
KNEE_MAX = 55.0
ARM_AMP = 16.0
ELBOW = 18.0
FPS = 30
CAM_DIST = 3.2
WALK_HALF = 3.2  # 画面の外から外まで（m）
TURN_GAP = 0.6  # 折り返しの間（秒）

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
arm.rotation_mode = 'XYZ'  # 読み込んだ直後は四元数。折り返しで Z 軸まわりに回すため
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
scene = bpy.context.scene
view_layer = bpy.context.view_layer

# 材質（肌に近い色。推定モデルが人として見つけやすいように）
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


def rot_x(deg_forward):
    """前へ曲げる角度（度）。体は -Y を向いているので、X 軸まわりに負に回すと前へ振れる"""
    return Quaternion(X, -math.radians(deg_forward))


def set_abs(name, q):
    """骨を、最初の向きからアーマチュアの座標で q だけ回した向きにする（位置は親に従う）"""
    b = pb[name]
    rest = b.bone.matrix_local.to_3x3()
    m = (q.to_matrix() @ rest).to_4x4()
    m.translation = b.matrix.translation
    b.matrix = m
    view_layer.update()


def wpos(name, tail=False):
    b = pb[name]
    return arm.matrix_world @ (b.tail if tail else b.head)


def set_dir(name, d):
    """骨を、アーマチュアの座標での向き d に向ける（最初の向きからの最小の回転）"""
    b = pb[name].bone
    rest = (b.tail_local - b.head_local).normalized()
    set_abs(name, rest.rotation_difference(d.normalized()))


def arm_dir(side, deg_forward):
    """体の横に 8° 開いて下ろした腕を、前へ deg_forward 振った向き（体は -Y を向く）"""
    s = 1 if side == 'l' else -1
    a = math.radians(deg_forward)
    o = math.radians(8)
    return s * math.sin(o) * X + math.cos(o) * (-math.sin(a) * Y - math.cos(a) * Vector((0, 0, 1)))


omega = math.pi * CADENCE / 60


def pose(t):
    for b in pb:
        b.rotation_mode = 'QUATERNION'
        b.rotation_quaternion = Quaternion()
        b.location = Vector()
    view_layer.update()
    ph = omega * t
    # 体幹: 3 本の背骨で少しずつ前へ（合わせて LEAN_DEG）
    set_abs('spine_01', rot_x(LEAN_DEG * 0.5))
    set_abs('spine_02', rot_x(LEAN_DEG * 0.8))
    set_abs('spine_03', rot_x(LEAN_DEG))
    set_abs('neck_01', rot_x(LEAN_DEG * 0.5))
    set_abs('head', rot_x(0))
    for side, sgn in (('l', 1), ('r', -1)):
        p = ph if side == 'l' else ph + math.pi
        hip = HIP_MEAN + HIP_AMP * math.sin(p)
        knee = 5 + KNEE_MAX * max(0.0, math.cos(p)) ** 2
        set_abs(f'thigh_{side}', rot_x(hip))
        set_abs(f'calf_{side}', rot_x(hip - knee))
        set_abs(f'foot_{side}', rot_x(0))
        # 腕は同じ側の脚と逆に振る
        a = -ARM_AMP * math.sin(p)
        set_dir(f'upperarm_{side}', arm_dir(side, a))
        set_dir(f'lowerarm_{side}', arm_dir(side, a + ELBOW))
        set_dir(f'hand_{side}', arm_dir(side, a + ELBOW))


def lowest_foot_z():
    return min(wpos(n, tail).z for n in ('foot_l', 'foot_r', 'ball_l', 'ball_r') for tail in (False, True))


# 正解の値: 1 往復の歩き（2 歩）を細かく区切って、骨の位置から求める（体は -Y を向く）
arm.location = Vector()
arm.rotation_euler = (0, 0, 0)
seps, legs, leans, heads, arms_ = [], [], [], [], []
ear = [o for o in bpy.data.objects if o.name.startswith('lm_7') or o.name.startswith('lm_8')]
for k in range(60):
    pose(k / 60 * 2 * math.pi / omega)
    seps.append(abs(wpos('foot_l').y - wpos('foot_r').y))
    legs.append(max((wpos('thigh_l') - wpos('foot_l')).length, (wpos('thigh_r') - wpos('foot_r')).length))
    S = (wpos('upperarm_l') + wpos('upperarm_r')) / 2
    P = (wpos('thigh_l') + wpos('thigh_r')) / 2
    leans.append(math.degrees(math.atan2(-(S.y - P.y), S.z - P.z)))
    if len(ear) == 2:
        E = (ear[0].matrix_world.translation + ear[1].matrix_world.translation) / 2
        heads.append(math.degrees(math.atan2(-(E.y - S.y), E.z - S.z)))
    angs = [math.degrees(math.atan2(-(wpos(f'hand_{s}').y - S.y), -(wpos(f'hand_{s}').z - S.z))) for s in 'lr']
    arms_.append(angs)
step = max(seps)
leg = sorted(legs)[int(len(legs) * 0.9)]
arm_range = max(max(a) for a in arms_) - min(min(a) for a in arms_)
speed = step * CADENCE / 60
pass_dur = 2 * WALK_HALF / speed
total = 2 * pass_dur + TURN_GAP
n_frames = int(total * FPS)
head_txt = f'{sum(heads) / len(heads):.1f}' if heads else '?'
print(f'GT cadence={CADENCE} step/leg={step / leg * 100:.1f}% (step {step:.3f}m, leg {leg:.3f}m) lean={sum(leans) / len(leans):.1f} head={head_txt} arm_range={arm_range:.1f} speed={speed:.2f}m/s frames={n_frames}')

# 床・光・カメラ
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
bpy.ops.object.camera_add(location=(CAM_DIST, 0, 0.95), rotation=(math.pi / 2, 0, math.pi / 2))
cam = bpy.context.object
cam.data.lens = 26
cam.data.sensor_width = 36
scene.camera = cam

scene.render.engine = 'BLENDER_EEVEE'
try:
    scene.eevee.taa_render_samples = 16
except AttributeError:
    pass
scene.render.resolution_x = 960
scene.render.resolution_y = 540
scene.render.fps = FPS
scene.frame_start = 1
scene.frame_end = n_frames

# 各コマの姿勢と位置をキーにする
for f in range(n_frames):
    t = f / FPS
    if t < pass_dur:
        y = WALK_HALF - speed * t
        rot = 0.0
        tw = t
    elif t < pass_dur + TURN_GAP:
        y, rot, tw = -WALK_HALF - 1, 0.0, pass_dur
    else:
        tw = t - pass_dur - TURN_GAP
        y = -WALK_HALF + speed * tw
        rot = math.pi
    arm.location = Vector((0, y, 0))
    arm.rotation_euler = (0, 0, rot)
    pose(tw)
    arm.location.z -= lowest_foot_z()
    view_layer.update()
    arm.keyframe_insert('location', frame=f + 1)
    arm.keyframe_insert('rotation_euler', frame=f + 1)
    for b in pb:
        b.keyframe_insert('rotation_quaternion', frame=f + 1)

if PREVIEW:
    scene.render.image_settings.file_format = 'PNG'
    for k, frac in enumerate((0.25, 0.5, 0.8)):
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
