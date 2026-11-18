# どの向きから撮っても関節の角度を出せるようにするための、学習用の合成データを作る（アプリには入れない）。
# 3D の人形（public/models/mannequin-v2-*.glb、CC0）に、スクワット・ローイングエルゴ・固定式の自転車の動きをさせ、
# カメラの向き（体のまわり 360°）・高さ（床の近くから見上げる〜上から見下ろす）・距離・画角を、クリップごとに変えて撮る。
# 正解は、骨の関節と顔・足の目印の 3D の位置（MediaPipe の点の番号）と、カメラの位置・向き・画角。
#
# 使い方（Blender 5.2 で）:
#   blender -b --python tools/blender/make_view_dataset.py -- 出力フォルダ クリップ数 [乱数の種] [最初のクリップの番号]
# 出力: 出力フォルダ/c0000/0000.jpg ...（コマの絵）、出力フォルダ/c0000/clip.json（正解とカメラ）
#
# 動きの大きさ・速さ・体型・カメラは乱数で決める（同じ種なら同じデータ）。乱数の種とクリップの番号で、
# 何台かのパソコンや何回かに分けて作っても、同じクリップを作り直せる
import json
import math
import os
import random
import sys

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

args = sys.argv[sys.argv.index('--') + 1:]
OUT = os.path.abspath(args[0])
N_CLIPS = int(args[1])
SEED = int(args[2]) if len(args) > 2 else 1
FIRST = int(args[3]) if len(args) > 3 else 0
MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'models')

FPS = 10  # 学習には 1 秒あたり 10 コマで十分（アプリの点は 30 コマ/秒を、なめらかにしてから使う）
FRAMES = 24  # 1 クリップのコマ数（2.4 秒。エルゴ 1 本・自転車 3 回転半・スクワット 1 回ほど）
SHORT_SIDE = 288  # 絵の短い辺（推定モデルは 256 px 前後に縮めて使う）

# 正解として書き出す点（MediaPipe の点の番号 → 骨の付け根、または目印）
POINTS = {
    0: 'lm_0', 7: 'lm_7', 8: 'lm_8',
    11: 'upperarm_l', 12: 'upperarm_r', 13: 'lowerarm_l', 14: 'lowerarm_r', 15: 'hand_l', 16: 'hand_r',
    23: 'thigh_l', 24: 'thigh_r', 25: 'calf_l', 26: 'calf_r', 27: 'foot_l', 28: 'foot_r',
    29: 'lm_29', 30: 'lm_30', 31: 'lm_31', 32: 'lm_32',
}

# ---------- 場面（床・光・背景）。人形は毎回読み直す ----------


def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    floor = bpy.context.object
    fm = bpy.data.materials.new('floor')
    fm.use_nodes = True
    floor.data.materials.append(fm)
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    scene.world = world
    bpy.ops.object.light_add(type='SUN', location=(3, 2, 5))
    sun = bpy.context.object
    bpy.ops.object.camera_add()
    cam = bpy.context.object
    cam.data.sensor_fit = 'HORIZONTAL'
    cam.data.sensor_width = 36
    scene.camera = cam
    scene.render.engine = 'BLENDER_EEVEE'
    try:
        scene.eevee.taa_render_samples = 8
    except AttributeError:
        pass
    scene.render.image_settings.file_format = 'JPEG'
    scene.render.image_settings.quality = 85
    return scene, floor, fm, world, sun, cam


scene, floor, floor_mat, world, sun, cam = setup_scene()
view_layer = bpy.context.view_layer
skin = bpy.data.materials.new('skin')
skin.use_nodes = True
cloth = bpy.data.materials.new('cloth')
cloth.use_nodes = True

loaded = {}


def load_body(kind):
    """人形を読み込む（種類ごとに 1 回）。読み込んだものは、使わないときは隠す"""
    if kind not in loaded:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(MODELS, f'mannequin-v2-{kind}.glb'))
        objs = [o for o in bpy.data.objects if o not in before]
        arm = next(o for o in objs if o.type == 'ARMATURE')
        meshes = [o for o in objs if o.type == 'MESH']
        for m in meshes:
            m.data.materials.clear()
            m.data.materials.append(skin)
        markers = {o.name.split('.')[0]: o for o in objs if o.name.startswith('lm_')}
        loaded[kind] = (arm, markers, objs)
    for k, (_, _, objs) in loaded.items():
        for o in objs:
            o.hide_render = k != kind
    return loaded[kind][0], loaded[kind][1]


# ---------- 器具（エルゴ・自転車・バーベル）。実際の動画では器具が脚や手を隠すので、合成の絵にも簡単な形で置く（版 2） ----------

gear_mat = bpy.data.materials.new('gear')
gear_mat.use_nodes = True
rack_mat = bpy.data.materials.new('rack')
rack_mat.use_nodes = True
GEAR = {}


def _prim(kind, name):
    if kind == 'box':
        bpy.ops.mesh.primitive_cube_add(size=1)
    else:
        bpy.ops.mesh.primitive_cylinder_add(radius=1, depth=1, vertices=24)
    o = bpy.context.object
    o.name = name
    o.data.materials.append(gear_mat)
    o.hide_render = True
    return o


def gear(name, kind='rod'):
    if name not in GEAR:
        GEAR[name] = _prim('box' if kind == 'box' else 'cyl', name)
        if name.startswith('rack'):
            GEAR[name].data.materials.clear()
            GEAR[name].data.materials.append(rack_mat)
    return GEAR[name]


def rod(name, a, b, r):
    """a から b への棒（半径 r）"""
    o = gear(name)
    d = b - a
    o.hide_render = d.length < 1e-4
    q = Vector((0, 0, 1)).rotation_difference(d.normalized()) if d.length > 1e-6 else Quaternion()
    o.matrix_world = Matrix.LocRotScale((a + b) / 2, q, Vector((r, r, max(d.length, 1e-4))))


def disk(name, c, axis, radius, width):
    rod(name, c - axis * (width / 2), c + axis * (width / 2), radius)


def slab(name, c, x, y, z, size):
    """中心 c、向き（x, y, z の単位ベクトル）、大きさ size の箱"""
    o = gear(name, 'box')
    o.hide_render = False
    m = Matrix((x, y, z)).transposed()
    o.matrix_world = Matrix.LocRotScale(c, m.to_quaternion(), Vector(size))


def hide_gear():
    for o in GEAR.values():
        o.hide_render = True


def randomize_gear(rnd):
    rack_mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = rnd.choice(
        [(0.6, 0.03, 0.02, 1), (0.05, 0.05, 0.05, 1), (0.35, 0.35, 0.37, 1), (0.08, 0.12, 0.35, 1)]
    )
    g = rnd.uniform(0.03, 0.35)
    gear_mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (g, g, g * rnd.uniform(0.9, 1.1), 1)
    gear_mat.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = rnd.uniform(0, 0.6)


def place_gear(motion, body, opts):
    """今の姿勢に合わせて器具を置く"""
    hide_gear()
    w = body.wpos
    M = body.arm.matrix_world.to_3x3()
    fwd = (M @ body.FWD).normalized()
    fwd.z = 0
    fwd.normalize()
    lat = (M @ body.X).normalized()
    lat.z = 0
    lat.normalize()
    up = Vector((0, 0, 1))
    hip = (w('thigh_l') + w('thigh_r')) / 2
    feet = (w('foot_l') + w('foot_r')) / 2
    hands = (w('hand_l') + w('hand_r')) / 2
    if motion == 'erg':
        rail_z = hip.z - 0.16
        back = hip - fwd * 0.9
        front = feet + fwd * 0.2
        rod('rail', Vector((back.x, back.y, rail_z)), Vector((front.x, front.y, rail_z)), 0.035)
        rod('leg_back', Vector((back.x, back.y, rail_z)), Vector((back.x, back.y, 0.0)), 0.03)
        slab('seat', Vector((hip.x, hip.y, hip.z - 0.11)), lat, fwd, up, (0.28, 0.32, 0.06))
        plate = feet - fwd * 0.02
        tilt = (fwd * 0.6 + up * 0.8).normalized()
        slab('footplate', plate, lat, tilt.cross(lat).normalized(), tilt, (0.3, 0.04, 0.34))
        r_fly = opts.get('fly_r', 0.22) * 0.85
        fly = Vector((front.x, front.y, max(r_fly + 0.05, feet.z - 0.02))) + fwd * 0.3
        disk('flywheel', fly, lat, r_fly, 0.2)
        rod('leg_front', Vector((front.x, front.y, rail_z)), Vector((front.x, front.y, 0.0)), 0.03)
        rod('handle', hands - lat * 0.27, hands + lat * 0.27, 0.017)
        rod('chain', hands, fly + up * 0.1, 0.006)
    elif motion == 'bike':
        crank_c = (w('foot_l') + w('foot_r')) / 2
        rod('crank_l', crank_c, w('foot_l'), 0.012)
        rod('crank_r', crank_c, w('foot_r'), 0.012)
        disk('chainring', crank_c, lat, 0.11, 0.02)
        slab('saddle', Vector((hip.x, hip.y, hip.z - 0.09)), lat, fwd, up, (0.16, 0.27, 0.05))
        rod('seatpost', Vector((hip.x, hip.y, hip.z - 0.11)), crank_c, 0.022)
        rod('down', crank_c, hands - up * 0.12, 0.028)
        rod('stem', hands - up * 0.12, hands, 0.02)
        rod('bar', hands - lat * 0.24, hands + lat * 0.24, 0.016)
        fly = crank_c + fwd * 0.45 + up * 0.05
        disk('flywheel', fly, lat, opts.get('fly_r', 0.24), 0.08)
        base = Vector((crank_c.x, crank_c.y, 0.03))
        rod('base', base - fwd * 0.5, base + fwd * 0.6, 0.035)
        rod('upright', base, crank_c, 0.03)
    if motion == 'squat' and opts.get('rack'):
        # パワーラック（柱 4 本と上の梁）。体のまわりに置く（ラック越しに撮る動画が多いため）
        c = Vector((feet.x, feet.y, 0.0))
        half_w, half_d, top = opts['rack_w'], opts['rack_d'], opts['rack_h']
        corners = [c + lat * sx * half_w + fwd * sy * half_d for sx in (-1, 1) for sy in (-1, 1)]
        for i, q in enumerate(corners):
            rod(f'rack_post{i}', q, q + up * top, 0.035)
        for i, (a, b) in enumerate(((0, 1), (2, 3), (0, 2), (1, 3))):
            rod(f'rack_top{i}', corners[a] + up * top, corners[b] + up * top, 0.03)
        for i, (a, b) in enumerate(((0, 2), (1, 3))):
            rod(f'rack_safety{i}', corners[a] + up * opts['safety_h'], corners[b] + up * opts['safety_h'], 0.022)
    if motion == 'squat' and opts.get('barbell'):
        hl, hr = w('hand_l'), w('hand_r')
        axis = (hl - hr).normalized()
        c = (hl + hr) / 2
        rod('barbell', c - axis * 0.9, c + axis * 0.9, 0.014)
        for k, sgn in (('plate_l', 1), ('plate_r', -1)):
            disk(k, c + axis * sgn * 0.68, axis, opts.get('plate_r', 0.2), 0.08)


# ---------- 骨を動かす ----------


class Body:
    def __init__(self, arm, markers):
        self.arm = arm
        self.markers = markers
        arm.rotation_mode = 'XYZ'
        arm.rotation_euler = Euler()
        arm.scale = Vector((1, 1, 1))
        self.pb = arm.pose.bones
        to_arm = arm.matrix_world.to_3x3().inverted()
        self.X = (to_arm @ Vector((1, 0, 0))).normalized()  # 体の左
        self.Y = (to_arm @ Vector((0, 1, 0))).normalized()  # 体は -Y を向く
        self.Z = (to_arm @ Vector((0, 0, 1))).normalized()
        self.FWD = -self.Y
        self.reset()
        w = self.wpos
        self.L_THIGH = (w('thigh_l') - w('calf_l')).length
        self.L_SHIN = (w('calf_l') - w('foot_l')).length
        self.L_UPPER = (w('upperarm_l') - w('lowerarm_l')).length
        self.L_FORE = (w('lowerarm_l') - w('hand_l')).length

    def reset(self):
        for b in self.pb:
            b.rotation_mode = 'QUATERNION'
            b.rotation_quaternion = Quaternion()
            b.location = Vector()
        self.arm.location = Vector()
        view_layer.update()

    def set_abs(self, name, q):
        b = self.pb[name]
        rest = b.bone.matrix_local.to_3x3()
        m = (q.to_matrix() @ rest).to_4x4()
        m.translation = b.matrix.translation
        b.matrix = m
        view_layer.update()

    def set_dir(self, name, d):
        b = self.pb[name].bone
        rest = (b.tail_local - b.head_local).normalized()
        self.set_abs(name, rest.rotation_difference(d.normalized()))

    def wpos(self, name):
        if name.startswith('lm_'):
            o = self.markers.get(name)
            return o.matrix_world.translation.copy() if o else None
        b = self.pb[name]
        return self.arm.matrix_world @ b.head

    def sag(self, fwd, up, side=0.0):
        return self.FWD * fwd + self.Z * up + self.X * side

    def rot_up(self, deg):
        return Quaternion(self.X, math.radians(deg))

    def trunk(self, lean):
        self.set_abs('spine_01', self.rot_up(lean * 0.6))
        self.set_abs('spine_02', self.rot_up(lean * 0.85))
        self.set_abs('spine_03', self.rot_up(lean))
        self.set_abs('neck_01', self.rot_up(lean * 0.5))
        self.set_abs('head', self.rot_up(lean * 0.2))

    def legs(self, hip_to_ankle, foot_dirs=None):
        """股関節から足首への向き（前, 上, 左）ごとに、脚を 2 本の骨で組む。膝は前へ曲げる"""
        for side in 'lr':
            fwd, up, lat = hip_to_ankle[side]
            k = ik((0, 0), (fwd, up), self.L_THIGH, self.L_SHIN, True)
            self.set_dir(f'thigh_{side}', self.sag(k[0], k[1], lat * 0.5))
            self.set_dir(f'calf_{side}', self.sag(fwd - k[0], up - k[1], lat * 0.5))
            if foot_dirs:
                self.set_dir(f'foot_{side}', foot_dirs[side])

    def arm_to(self, side, wrist_rel, elbow_hint):
        """肩から手首（前, 上, 外）へ腕を組む。ひじは elbow_hint（前, 上, 外）の側へ曲げる"""
        s = 1 if side == 'l' else -1
        sh = self.wpos(f'upperarm_{side}')
        target = sh + self.sag(wrist_rel[0], wrist_rel[1], s * wrist_rel[2])
        hint = sh + self.sag(elbow_hint[0], elbow_hint[1], s * elbow_hint[2])
        d = target - sh
        dist = min(d.length, self.L_UPPER + self.L_FORE - 1e-4)
        u = d.normalized()
        a = (dist * dist + self.L_UPPER ** 2 - self.L_FORE ** 2) / (2 * dist)
        h = math.sqrt(max(0.0, self.L_UPPER ** 2 - a * a))
        pole = hint - sh
        pole = pole - u * pole.dot(u)
        if pole.length < 1e-6:
            pole = self.sag(0, -1, 0)
        pole.normalize()
        elbow = sh + u * a + pole * h
        self.set_dir(f'upperarm_{side}', elbow - sh)
        wrist = sh + u * dist
        self.set_dir(f'lowerarm_{side}', wrist - elbow)
        self.set_dir(f'hand_{side}', wrist - elbow)


def ik(a, b, l1, l2, bend_fwd):
    dx, dz = b[0] - a[0], b[1] - a[1]
    d = min(math.hypot(dx, dz), l1 + l2 - 1e-4)
    base = math.atan2(dz, dx)
    alpha = math.acos(max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))))
    c1 = (a[0] + l1 * math.cos(base + alpha), a[1] + l1 * math.sin(base + alpha))
    c2 = (a[0] + l1 * math.cos(base - alpha), a[1] + l1 * math.sin(base - alpha))
    if bend_fwd:
        return c1 if c1[0] + c1[1] > c2[0] + c2[1] else c2
    return c1 if c1[1] < c2[1] else c2


def smooth(u):
    u = max(0.0, min(1.0, u))
    return u * u * (3 - 2 * u)


def span(s, a, b):
    return smooth((s - a) / (b - a))


# ---------- 動き（クリップごとに乱数で変える） ----------

ARM_STYLES = ['bar', 'head', 'clasp', 'front', 'hips', 'down']


def squat_motion(rnd):
    # 実際の人の深いしゃがみ（膝 150° ほど・上体 60° ほど）まで入るように、幅を広く取る（版 2）
    depth = rnd.uniform(50, 155)  # 膝の曲がりの最大（度）
    shin_k = rnd.uniform(0.25, 0.55)
    shin_max = rnd.uniform(30, 48)  # すねの前傾の上限（度）
    trunk_k = rnd.uniform(0.2, 0.65)
    lean_max = rnd.uniform(35, 80)  # 上体の前傾の上限（度。背骨を曲げて配るので、股関節→肩の線の傾きはこの 7 割ほど）
    stance = rnd.uniform(0.0, 0.14)  # 足を開く幅（左右へ、脚の長さに対する割合）
    style = rnd.choice(ARM_STYLES)
    phase = rnd.uniform(0, 1)
    period = rnd.uniform(2.0, 3.2)

    def pose(body, t):
        body.reset()
        u = ((t / period) + phase) % 1.0
        knee = depth * (1 - math.cos(2 * math.pi * u)) / 2
        shin = min(knee * shin_k, shin_max)
        lean = min(knee * trunk_k, lean_max)
        body.trunk(lean)
        leg = body.L_THIGH + body.L_SHIN
        for side in 'lr':
            s = 1 if side == 'l' else -1
            thigh = knee - shin
            # 股関節から見た足首（前, 上）。太ももを前へ thigh°、すねを後ろへ shin° 傾けた形
            kf = body.L_THIGH * math.sin(math.radians(thigh))
            ku = -body.L_THIGH * math.cos(math.radians(thigh))
            af = kf - body.L_SHIN * math.sin(math.radians(shin))
            au = ku - body.L_SHIN * math.cos(math.radians(shin))
            k = ik((0, 0), (af, au), body.L_THIGH, body.L_SHIN, True)
            out = s * stance * leg
            body.set_dir(f'thigh_{side}', body.sag(k[0], k[1], out * 0.5))
            body.set_dir(f'calf_{side}', body.sag(af - k[0], au - k[1], out * 0.5))
            body.set_dir(f'foot_{side}', body.sag(1, -0.05, s * 0.25))
        arms(body, style, lean)
        place_on_floor(body)

    return pose, {'motion': 'squat', 'depth': depth, 'arms': style}


def arms(body, style, lean):
    """腕の構え。肩から見た手首とひじの向き（前, 上, 外）を、腕の長さ（上腕＋前腕）を 1 として決める。
    バー・頭の後ろ・胸の前・腰は上体と一緒に傾け、前へ伸ばす・下ろすは体の傾きによらない（前へ伸ばす人は腕を水平に保ち、
    下ろした腕は下へ垂れる）"""
    c, s_ = math.cos(math.radians(lean)), math.sin(math.radians(lean))
    A = body.L_UPPER + body.L_FORE
    wrist, elbow = {
        'bar': ((-0.09, 0.14, 0.72), (-0.32, -0.12, 0.4)),
        'head': ((-0.22, 0.5, -0.27), (0.05, 0.36, 0.68)),
        'clasp': ((0.5, -0.27, -0.27), (0.11, -0.5, 0.27)),
        'front': ((1.2, -0.05, 0.0), (0.6, -0.05, 0.05)),
        'hips': ((-0.05, -0.86, 0.2), (-0.3, -0.5, 0.4)),
        'down': ((0.02, -1.2, 0.08), (0.0, -0.6, 0.1)),
    }[style]
    tilt = style in ('bar', 'head', 'clasp', 'hips')

    def r(v):  # 胴に沿った（前, 上）を、前傾した体の（前, 上）へ
        f, u, x = v
        if tilt:
            f, u = f * c + u * s_, -f * s_ + u * c
        return (f * A, u * A, x * A)

    for side in 'lr':
        body.arm_to(side, r(wrist), r(elbow))


def erg_motion(rnd):
    # 実際の漕ぎ（キャッチの膝 140° ほど、フィニッシュで上体を大きく後ろへ倒す、手を胸まで引く）まで入るように広げる（版 2）
    T = rnd.uniform(1.8, 3.4)
    drive = T * rnd.uniform(0.3, 0.44)
    seat = (rnd.uniform(0.28, 0.44), rnd.uniform(0.74, 0.85))
    lean = (rnd.uniform(15, 58), rnd.uniform(-62, -6))  # 股関節→肩の線の傾きは、この 7 割ほど
    hand_up = rnd.uniform(0.12, 0.38)
    pull = rnd.uniform(0.04, 0.16)  # フィニッシュの手と肩の前後の距離（小さいほどひじを深く曲げる）
    phase = rnd.uniform(0, T)

    def pose(body, t):
        body.reset()
        u = (t + phase) % T
        s = u / drive if u <= drive else 1 - (u - drive) / (T - drive)
        st = seat[0] + (seat[1] - seat[0]) * span(s, 0, 0.6)
        ln = lean[0] + (lean[1] - lean[0]) * span(s, 0.3, 0.8)
        body.trunk(ln)
        d = (st, -0.10, 0.0)
        body.legs({'l': d, 'r': d}, {k: body.sag(0.75, 0.66) for k in 'lr'})
        sh = body.wpos('upperarm_l')
        hp = body.wpos('thigh_l')
        up = (hp.z + hand_up) - sh.z
        reach_max = math.sqrt(max(0.01, (body.L_UPPER + body.L_FORE - 0.01) ** 2 - up * up))
        reach = reach_max - (reach_max - pull) * span(s, 0.6, 1)
        for side in 'lr':
            body.arm_to(side, (reach, up, 0.06), (0.0, -1.0, 0.25))
        a = (body.wpos('foot_l') + body.wpos('foot_r')) / 2
        body.arm.location = Vector((0, 0, 0.40)) - a
        view_layer.update()

    return pose, {'motion': 'erg'}


def bike_motion(rnd):
    T = 60 / rnd.uniform(60, 110)
    R = rnd.uniform(0.15, 0.19)
    # サドルの高さ（クランクの中心の深さ）と前傾を広げる（版 2）
    crank = (rnd.uniform(0.04, 0.22), rnd.uniform(-0.68, -0.54))
    lean = rnd.uniform(25, 85)
    # ハンドルは肩から見た向きで決める（腕をほぼ伸ばす人から、ひじを曲げて低く構える人まで。版 2）
    reach = rnd.uniform(0.62, 0.99)  # 腕の長さに対する、肩からハンドルまでの距離
    drop = rnd.uniform(15, 70)  # 肩から見たハンドルの下向きの角度（度）
    phase = rnd.uniform(0, 2 * math.pi)

    def pose(body, t):
        body.reset()
        body.trunk(lean)
        th = -2 * math.pi * t / T + phase
        d, feet = {}, {}
        for side, ph in (('l', 0.0), ('r', math.pi)):
            d[side] = (crank[0] + R * math.cos(th + ph), crank[1] + R * math.sin(th + ph), 0.0)
            tilt = math.radians(15 + 10 * math.sin(th + ph))
            feet[side] = body.sag(math.cos(tilt), -math.sin(tilt))
        body.legs(d, feet)
        A = (body.L_UPPER + body.L_FORE) * reach
        f, u = A * math.cos(math.radians(drop)), -A * math.sin(math.radians(drop))
        for side in 'lr':
            body.arm_to(side, (f, u, 0.05), (0.0, -1.0, 0.3))
        h = (body.wpos('thigh_l') + body.wpos('thigh_r')) / 2
        body.arm.location = Vector((0, 0, 0.95)) - h
        view_layer.update()

    return pose, {'motion': 'bike'}


def place_on_floor(body):
    body.arm.location = Vector()
    view_layer.update()
    a = (body.wpos('foot_l') + body.wpos('foot_r')) / 2
    low = min(body.wpos(n).z for n in ('foot_l', 'foot_r', 'ball_l', 'ball_r'))
    body.arm.location = Vector((-a.x, -a.y, -low + 0.03))
    view_layer.update()


# ---------- カメラ ----------


def place_camera(rnd, motion, body_h, target):
    """体のまわりの向き（0° = 体の右側から、90° = 正面から）・高さ・距離・画角を決め、体の中ほどへ向ける"""
    yaw = rnd.uniform(0, 360)
    # 見上げる（負）〜見下ろす（正）。床の近くから撮る動画が多いので、見上げる側を厚めにする
    pitch = rnd.choice([rnd.uniform(-22, -5), rnd.uniform(-8, 12), rnd.uniform(5, 32)])
    lens = rnd.uniform(22, 32)  # 36 mm 幅の換算（スマホの広角〜標準）
    portrait = (motion == 'squat') if rnd.random() < 0.8 else (motion != 'squat')
    res = (SHORT_SIDE, int(SHORT_SIDE * 16 / 9)) if portrait else (int(SHORT_SIDE * 16 / 9), SHORT_SIDE)
    fov_h = 2 * math.atan(18 / lens)
    fov_v = 2 * math.atan(math.tan(fov_h / 2) * res[1] / res[0])
    ext_v, ext_h = (1.15 * body_h, 0.8 * body_h) if motion == 'squat' else (1.0 * body_h, 1.5 * body_h)
    dist = max(ext_v / 2 / math.tan(fov_v / 2), ext_h / 2 / math.tan(fov_h / 2)) / rnd.uniform(0.65, 0.9)
    yr, pr = math.radians(yaw), math.radians(pitch)
    # 体は -Y を向く。yaw 0° で体の右側（-X）、90° で体の前（-Y）から
    d = Vector((-math.cos(yr) * math.cos(pr), -math.sin(yr) * math.cos(pr), math.sin(pr)))
    loc = target + d * dist
    if loc.z < 0.12:
        loc.z = 0.12
    cam.location = loc
    q = (target - loc).normalized().to_track_quat('-Z', 'Y')
    roll = math.radians(rnd.uniform(-4, 4))
    cam.rotation_mode = 'QUATERNION'
    cam.rotation_quaternion = q @ Quaternion((0, 0, 1), roll)
    cam.data.lens = lens
    cam.data.sensor_fit = 'HORIZONTAL'
    cam.data.sensor_width = 36
    scene.render.resolution_x, scene.render.resolution_y = res
    view_layer.update()
    return {'yaw': yaw, 'pitch': pitch, 'lens': lens, 'dist': dist, 'res': list(res), 'roll': math.degrees(roll)}


def camera_matrices():
    """ワールド → カメラの行列（カメラは -Z を向き、+Y が上）と、焦点距離（ピクセル）"""
    w2c = cam.matrix_world.inverted()
    rx, ry = scene.render.resolution_x, scene.render.resolution_y
    f = cam.data.lens / cam.data.sensor_width * rx
    return w2c, f, rx, ry


def project(p, w2c, f, rx, ry):
    c = w2c @ p
    z = -c.z
    return (rx / 2 + f * c.x / z, ry / 2 - f * c.y / z, z)


# ---------- 見た目（背景・服・光）を変える ----------


def randomize_look(rnd):
    def rgb(lo, hi):
        return (rnd.uniform(lo, hi), rnd.uniform(lo, hi), rnd.uniform(lo, hi), 1)

    skin.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = rnd.choice(
        [(0.80, 0.62, 0.50, 1), (0.62, 0.45, 0.34, 1), (0.42, 0.29, 0.21, 1), (0.88, 0.72, 0.62, 1)]
    )
    floor_mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = rgb(0.15, 0.7)
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = rgb(0.2, 0.9)
    bg.inputs['Strength'].default_value = rnd.uniform(0.4, 1.0)
    sun.rotation_euler = Euler((math.radians(rnd.uniform(20, 60)), 0, math.radians(rnd.uniform(0, 360))))
    sun.data.energy = rnd.uniform(1.5, 4.5)


# ---------- 書き出し ----------


def make_clip(index):
    rnd = random.Random(SEED * 100003 + index)
    kind = rnd.choice(['male', 'female', 'neutral'])
    arm, markers = load_body(kind)
    # 体型: 人形全体の大きさを少し変える
    sc = rnd.uniform(0.92, 1.08)
    arm.scale = Vector((sc, sc, sc))
    view_layer.update()
    body = Body(arm, markers)
    motion = rnd.choices(['squat', 'erg', 'bike'], weights=[0.55, 0.25, 0.2])[0]
    pose, info = {'squat': squat_motion, 'erg': erg_motion, 'bike': bike_motion}[motion](rnd)
    randomize_look(rnd)
    randomize_gear(rnd)
    # 器具を置くか（実際の動画では器具が写るので、たいていは置く。置かない絵も少し残す）
    gear_opts = {
        'use': rnd.random() < (0.85 if motion != 'squat' else 1.0),
        'fly_r': rnd.uniform(0.2, 0.3),
        'plate_r': rnd.uniform(0.11, 0.23),
        'barbell': info.get('arms') == 'bar' and rnd.random() < 0.85,
        'rack': motion == 'squat' and rnd.random() < 0.5,
        'rack_w': rnd.uniform(0.55, 0.75),
        'rack_d': rnd.uniform(0.45, 0.65),
        'rack_h': rnd.uniform(2.0, 2.3),
        'safety_h': rnd.uniform(0.45, 0.8),
    }
    hide_gear()
    # 体の高さ（立った姿勢の耳〜かかと）
    body.reset()
    place_on_floor(body)
    body_h = (body.wpos('lm_7') or body.wpos('head')).z
    # カメラを向ける点: 動きの最初の姿勢の、腰と肩の中ほど
    pose(body, 0)
    w = body.wpos
    target = (w('thigh_l') + w('thigh_r') + w('upperarm_l') + w('upperarm_r')) / 4
    target.z += rnd.uniform(-0.12, 0.12) * body_h
    camera = place_camera(rnd, motion, body_h, target)
    # カメラがラックのすぐそばだと、柱が絵をふさぐので、そのときはラックを置かない
    if gear_opts['rack']:
        view_layer.update()
        cp = cam.matrix_world.translation
        fc = (w('foot_l') + w('foot_r')) / 2
        if math.hypot(cp.x - fc.x, cp.y - fc.y) < math.hypot(gear_opts['rack_w'], gear_opts['rack_d']) + 1.0:
            gear_opts['rack'] = False
    w2c, f, rx, ry = camera_matrices()
    folder = os.path.join(OUT, f'c{index:04d}')
    os.makedirs(folder, exist_ok=True)
    frames = []
    for k in range(FRAMES):
        t = k / FPS
        pose(body, t)
        if gear_opts['use']:
            place_gear(motion, body, gear_opts)
        pts3, pts2 = {}, {}
        for i, name in POINTS.items():
            p = body.wpos(name)
            if p is None:
                continue
            pts3[i] = [round(v, 5) for v in p]
            u, v, z = project(p, w2c, f, rx, ry)
            pts2[i] = [round(u, 2), round(v, 2), round(z, 4)]
        scene.render.filepath = os.path.join(folder, f'{k:04d}.jpg')
        bpy.ops.render.render(write_still=True)
        frames.append({'t': round(t * 1000), 'p3': pts3, 'p2': pts2})
    cam_m = [list(r) for r in cam.matrix_world]
    meta = {
        'index': index,
        'seed': SEED,
        'body': kind,
        'scale': sc,
        'body_h': body_h,
        **info,
        'gear': bool(gear_opts['use']) and (motion != 'squat' or gear_opts['barbell'] or gear_opts['rack']),
        'camera': {**camera, 'f_px': f, 'matrix_world': cam_m},
        'fps': FPS,
        'frames': frames,
    }
    with open(os.path.join(folder, 'clip.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh)
    print(f'clip {index} {motion} {kind} yaw={camera["yaw"]:.0f} pitch={camera["pitch"]:.0f}', flush=True)


os.makedirs(OUT, exist_ok=True)
for n in range(FIRST, FIRST + N_CLIPS):
    make_clip(n)
print('done', N_CLIPS, 'clips')
