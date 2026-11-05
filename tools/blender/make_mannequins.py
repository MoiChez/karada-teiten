# 3D ビュー用のマネキン（男性・女性・中間）を作って GLB に書き出す（public/models/mannequin-v1-*.glb）。
# 作り直して中身が変わるときは v1 の番号を上げる（端末のキャッシュが古いまま残らないように）。
#
# 使い方（Blender 5.2 + MPFB 2.0.18 を入れた環境で）:
#   blender -b --python tools/blender/make_mannequins.py -- public/models
#
# - 人体は MPFB（MakeHuman）の標準の体。出力は CC0 として扱える
# - 骨は game_engine リグ（Unreal 形式の 53 本）。アプリ側で測った関節の向きに合わせて回す
# - 顔の細部の目印として、鼻・耳・かかと・つま先の位置に空のオブジェクト（lm_番号）を骨の子として置く。
#   番号は MediaPipe の点の番号（0 鼻、7/8 左右の耳、29/30 左右のかかと、31/32 左右のつま先）
# - 色や質感はアプリ側で付けるので、材質と UV は書き出さない
import os
import sys
import importlib

import bpy
from mathutils import Matrix, Vector

HumanService = importlib.import_module('bl_ext.user_default.mpfb.services.humanservice').HumanService
TargetService = importlib.import_module('bl_ext.user_default.mpfb.services.targetservice').TargetService

OUT_DIR = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else '.'

VARIANTS = {
    'male': 1.0,
    'female': 0.0,
    'neutral': 0.5,
}


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def world_verts(obj, group_name=None):
    """評価前のメッシュの頂点（ワールド座標）。group_name を渡すとそのグループの頂点だけ"""
    mw = obj.matrix_world
    if group_name is None:
        return [(v.index, mw @ v.co) for v in obj.data.vertices]
    g = obj.vertex_groups.get(group_name)
    if g is None:
        return []
    out = []
    for v in obj.data.vertices:
        for ge in v.groups:
            if ge.group == g.index and ge.weight > 0.5:
                out.append((v.index, mw @ v.co))
                break
    return out


def bone_head(rig, name):
    return rig.matrix_world @ rig.data.bones[name].head_local


def landmark_points(mesh, rig):
    """MediaPipe の点にあたる体表の位置（ワールド座標）。キャラクターは -Y を向き、左が +X、上が +Z"""
    verts = [p for _, p in world_verts(mesh)]
    neck = bone_head(rig, 'neck_01')
    head = bone_head(rig, 'head')
    head_verts = [p for p in verts if p.z > head.z - 0.02]
    pts = {}
    # 鼻: 顔の中心線上で最も前
    mid = [p for p in head_verts if abs(p.x) < 0.004]
    pts[0] = min(mid, key=lambda p: p.y)
    # 耳: 頭の最も外側から 1.5cm 以内の頂点の重心
    for idx, sign in ((7, 1), (8, -1)):
        side = [p for p in head_verts if p.x * sign > 0 and p.z < head.z + 0.12]
        xmax = max(abs(p.x) for p in side)
        ear = [p for p in side if abs(p.x) > xmax - 0.015]
        pts[idx] = sum(ear, Vector()) / len(ear)
    # かかと: 足首より下で最も後ろ / つま先: 最も前
    for heel_idx, toe_idx, sign, foot in ((29, 31, 1, 'foot_l'), (30, 32, -1, 'foot_r')):
        ankle = bone_head(rig, foot)
        foot_verts = [p for p in verts if p.z < ankle.z + 0.01 and p.x * sign > 0]
        pts[heel_idx] = max(foot_verts, key=lambda p: p.y)
        pts[toe_idx] = min(foot_verts, key=lambda p: p.y)
    del neck
    return pts


PARENT_BONE = {0: 'head', 7: 'head', 8: 'head', 29: 'foot_l', 30: 'foot_r', 31: 'ball_l', 32: 'ball_r'}


def build(name, gender):
    clear_scene()
    macro = TargetService.get_default_macro_info_dict()
    macro['gender'] = gender
    mesh = HumanService.create_human(mask_helpers=True, macro_detail_dict=macro)
    mesh.name = f'mannequin_{name}'
    rig = HumanService.add_builtin_rig(mesh, 'game_engine', import_weights=True)
    rig.name = f'rig_{name}'

    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = mesh
    mesh.select_set(True)

    # 体の形（性別などの調整）をメッシュに焼き込む
    if mesh.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)

    # 目の穴を埋めるため、目の補助形状を残して頭の骨に付ける
    head_group = mesh.vertex_groups.get('head')
    keep = mesh.vertex_groups.new(name='keep')
    body = mesh.vertex_groups['body']
    eyes = [mesh.vertex_groups.get('helper-l-eye'), mesh.vertex_groups.get('helper-r-eye')]
    eye_idx = {g.index for g in eyes if g}
    for v in mesh.data.vertices:
        gi = {ge.group for ge in v.groups if ge.weight > 0.5}
        if body.index in gi:
            keep.add([v.index], 1.0, 'REPLACE')
        elif gi & eye_idx:
            keep.add([v.index], 1.0, 'REPLACE')
            # 目は頭と一緒に動かす（ほかの骨の重みを外す）
            for ge in list(v.groups):
                g = mesh.vertex_groups[ge.group]
                if g.name in rig.data.bones:
                    g.remove([v.index])
            head_group.add([v.index], 1.0, 'REPLACE')
    for m in mesh.modifiers:
        if m.type == 'MASK':
            m.vertex_group = 'keep'
            bpy.ops.object.modifier_apply(modifier=m.name)
            break

    # 骨に関係のない頂点グループは消す（書き出しを軽くする）
    for g in list(mesh.vertex_groups):
        if g.name not in rig.data.bones:
            mesh.vertex_groups.remove(g)
    for p in mesh.data.polygons:
        p.use_smooth = True
    while mesh.data.uv_layers:
        mesh.data.uv_layers.remove(mesh.data.uv_layers[0])
    mesh.data.materials.clear()

    # 目印（骨の子の空オブジェクト）
    bpy.context.view_layer.update()
    empties = []
    for idx, p in landmark_points(mesh, rig).items():
        e = bpy.data.objects.new(f'lm_{idx}', None)
        bpy.context.scene.collection.objects.link(e)
        e.parent = rig
        e.parent_type = 'BONE'
        e.parent_bone = PARENT_BONE[idx]
        bpy.context.view_layer.update()
        e.matrix_world = Matrix.Translation(p)
        empties.append(e)
    bpy.context.view_layer.update()

    bpy.ops.object.select_all(action='DESELECT')
    for o in [mesh, rig, *empties]:
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    out = os.path.abspath(os.path.join(OUT_DIR, f'mannequin-v1-{name}.glb'))
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format='GLB',
        use_selection=True,
        export_texcoords=False,
        export_normals=True,
        export_materials='NONE',
        export_animations=False,
        export_skins=True,
        export_morph=False,
        export_yup=True,
        export_apply=True,
    )
    print(f'WROTE {out} verts={len(mesh.data.vertices)} bones={len(rig.data.bones)}')


os.makedirs(OUT_DIR, exist_ok=True)
for n, g in VARIANTS.items():
    build(n, g)
