# Z-Anatomy から、筋肉・腱・骨・靱帯だけを取り出して軽い .blend に保存し、確認用の絵を描く
import bpy, sys, json, math
from mathutils import Vector
args=sys.argv[sys.argv.index('--')+1:]
OUT=args[0]
FASCIA_KEEP=('thoracolumbar fascia','Palmar aponeurosis','Plantar aponeurosis')
def cls(o):
    cols={c.name for c in o.users_collection}
    mats=[m.name for m in o.data.materials if m]
    n=o.name
    if n.endswith(('.j','.i','.el','.er','.ol','.or','.t','.g','.s')) or len(o.data.vertices)<8: return None
    if '4: Muscular system' in cols:
        if not mats: return None
        if 'Bursa' in mats or 'Articular capsule' in mats: return None
        if mats==['Fascia']:
            return 'fascia' if any(k in n for k in FASCIA_KEEP) else None
        if mats==['Ligament']: return 'lig'
        if mats==['Tendon']: return 'tendon'
        if 'Tendon' in mats: return 'muscle'
        return None
    if '1: Skeletal system' in cols:
        if 'Cartilage' in ' '.join(mats) or 'artilage' in n: return 'cart'
        return 'bone'
    if '3: Joints' in cols: return 'lig'
    return None
keep={}
for o in bpy.data.objects:
    if o.type=='MESH':
        c=cls(o)
        if c: keep[o.name]=c
print('KEEP',len(keep), {k:sum(1 for v in keep.values() if v==k) for k in set(keep.values())})
for o in list(bpy.data.objects):
    if o.name not in keep: bpy.data.objects.remove(o, do_unlink=True)
sc=bpy.context.scene
info={}
for o in bpy.data.objects:
    if o.name not in sc.collection.all_objects: 
        try: sc.collection.objects.link(o)
        except Exception: pass
    o.hide_set(False); o.hide_viewport=False; o.hide_render=False
    o['cls']=keep[o.name]
    bb=[o.matrix_world@Vector(c) for c in o.bound_box]
    info[o.name]={'cls':keep[o.name],'min':[min(p[i] for p in bb) for i in range(3)],'max':[max(p[i] for p in bb) for i in range(3)],
                  'mats':[m.name if m else None for m in o.data.materials],'mods':[m.type for m in o.modifiers],'scale':list(o.scale),'par':o.parent.name if o.parent else None}
json.dump(info,open(OUT+'/anat_info.json','w'),indent=0)
for lc in sc.view_layers[0].layer_collection.children: lc.exclude=False
bpy.ops.outliner.orphans_purge(do_recursive=True)
bpy.ops.wm.save_as_mainfile(filepath=OUT+'/anat.blend', compress=True)
