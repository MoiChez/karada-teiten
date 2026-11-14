# アプリの体（MPFB）を解剖モデルの姿勢・寸法に合わせる
import bpy, sys, math, importlib, json
from mathutils import Vector, Matrix
a=sys.argv[sys.argv.index('--')+1:]
sys.path.insert(0,a[0]); import zb
OUT=a[1]
sc=zb.fresh_scene(); zb.paint_anatomy()
HumanService = importlib.import_module('bl_ext.user_default.mpfb.services.humanservice').HumanService
TargetService = importlib.import_module('bl_ext.user_default.mpfb.services.targetservice').TargetService

def wverts(name):
    o=bpy.data.objects[name]; mw=o.matrix_world
    return [mw@v.co for v in o.data.vertices]
def cen(ps): return sum(ps,Vector())/len(ps)
def anat_joints():
    J={}
    for s,sg in (('l',1),('r',-1)):
        hu=wverts('Humerus.'+s); zt=max(p.z for p in hu); zb_=min(p.z for p in hu)
        top=[p for p in hu if p.z>zt-0.045]; xin=min(p.x*sg for p in top)
        J['sh_'+s]=cen([p for p in top if p.x*sg<xin+0.05])
        J['el_'+s]=cen([p for p in hu if p.z<zb_+0.02])
        ru=wverts('Radius.'+s)+wverts('Ulna.'+s); zr=min(p.z for p in ru)
        J['wr_'+s]=cen([p for p in ru if p.z<zr+0.015])
        mc=wverts('Third metacarpal bone.'+s); zm=min(p.z for p in mc)
        J['mcp_'+s]=cen([p for p in mc if p.z<zm+0.01])
        fe=wverts('Femur.'+s); zt=max(p.z for p in fe); zb_=min(p.z for p in fe)
        xin=min(p.x*sg for p in fe if p.z>zt-0.06)
        J['hip_'+s]=cen([p for p in fe if p.z>zt-0.06 and p.x*sg<xin+0.045])
        J['kn_'+s]=cen([p for p in fe if p.z<zb_+0.03])
        J['an_'+s]=cen(wverts('Talus.'+s))
        ca=wverts('Calcaneus.'+s); J['heel_'+s]=max(ca,key=lambda p:p.y)
    return J
J=anat_joints()
allz=[(o.matrix_world@Vector(c)).z for o in bpy.data.objects if o.type=='MESH' and 'cls' in o for c in o.bound_box]
J['top']=Vector((0,0,max(allz))); J['floor']=Vector((0,0,min(allz)))
print('ANAT',{k:[round(x,3) for x in v] for k,v in J.items()})

macro=TargetService.get_default_macro_info_dict(); macro['gender']=0.5
mesh=HumanService.create_human(mask_helpers=True, macro_detail_dict=macro); mesh.name='mq'
rig=HumanService.add_builtin_rig(mesh,'game_engine',import_weights=True); rig.name='mqrig'
for o in (mesh,rig):
    for c in list(o.users_collection): c.objects.unlink(o)
    sc.collection.objects.link(o)
bpy.context.view_layer.objects.active=mesh; mesh.select_set(True)
if mesh.data.shape_keys: bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
keep=mesh.vertex_groups.new(name='keep'); body=mesh.vertex_groups['body']
eyes={g.index for g in (mesh.vertex_groups.get('helper-l-eye'),mesh.vertex_groups.get('helper-r-eye')) if g}
for v in mesh.data.vertices:
    gi={ge.group for ge in v.groups if ge.weight>0.5}
    if body.index in gi or gi&eyes: keep.add([v.index],1.0,'REPLACE')
for m in mesh.modifiers:
    if m.type=='MASK':
        m.vertex_group='keep'; bpy.ops.object.modifier_apply(modifier=m.name); break
for p in mesh.data.polygons: p.use_smooth=True
print('UV',[u.name for u in mesh.data.uv_layers], len(mesh.data.vertices))
bpy.context.view_layer.update()
B=rig.data.bones
def head(n): return rig.matrix_world@B[n].head_local
M={n:head(n) for n in ['pelvis','spine_01','spine_02','spine_03','neck_01','head','clavicle_l','upperarm_l','lowerarm_l','hand_l','middle_01_l','thigh_l','calf_l','foot_l','ball_l','upperarm_r','thigh_r','hand_r','foot_r']}
mv=[mesh.matrix_world@v.co for v in mesh.data.vertices]
M['top']=Vector((0,0,max(p.z for p in mv))); M['floor']=Vector((0,0,min(p.z for p in mv)))
print('MQ',{k:[round(x,3) for x in v] for k,v in M.items()})
json.dump({'anat':{k:list(v) for k,v in J.items()},'mq':{k:list(v) for k,v in M.items()}},open(OUT+'/joints.json','w'))
bpy.ops.wm.save_as_mainfile(filepath=OUT+'/fit0.blend', compress=True)
