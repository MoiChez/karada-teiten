import bpy, math
from mathutils import Vector
COL={'muscle':(0.42,0.06,0.045),'tendon':(0.80,0.74,0.64),'bone':(0.78,0.72,0.60),'cart':(0.70,0.76,0.78),'lig':(0.74,0.70,0.62),'fascia':(0.78,0.74,0.66)}
def mat(name,rgb,rough=0.55):
    m=bpy.data.materials.get('B_'+name)
    if m: return m
    m=bpy.data.materials.new('B_'+name); m.use_nodes=True
    b=m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value=(*rgb,1); b.inputs['Roughness'].default_value=rough
    return m
def paint_anatomy():
    for o in bpy.data.objects:
        if o.type!='MESH' or 'cls' not in o: continue
        c=o['cls']
        if c=='cart': c='bone'
        for i,s in enumerate(o.material_slots):
            n=s.material.name if s.material else ''
            if n.startswith('B_'): continue
            if c=='muscle': k='tendon' if n=='Tendon' else 'muscle'
            elif c=='bone': k='cart' if 'Cartilage' in n else 'bone'
            else: k=c
            s.material=mat(k,COL[k])
def fresh_scene():
    old=bpy.context.scene
    sc=bpy.data.scenes.new('Bake')
    for o in list(bpy.data.objects):
        if o.type=='MESH' and 'cls' in o:
            sc.collection.objects.link(o)
            for m in list(o.modifiers):
                if m.type=='SUBSURF': m.levels=min(m.levels,1); m.render_levels=min(m.render_levels,1)
    bpy.context.window.scene=sc
    bpy.data.scenes.remove(old)
    sc.view_settings.view_transform='Standard'
    return sc
def cam(name,loc,rot,scale):
    cd=bpy.data.cameras.new(name); cd.type='ORTHO'; cd.ortho_scale=scale; cd.clip_end=50
    co=bpy.data.objects.new(name,cd); bpy.context.scene.collection.objects.link(co)
    co.location=loc; co.rotation_euler=rot; return co
def render_views(prefix, zc=0.86, scale=1.9, res=(700,1100), views=('front','back','left')):
    sc=bpy.context.scene
    sc.render.engine='BLENDER_EEVEE'
    sc.render.resolution_x,sc.render.resolution_y=res
    sc.render.film_transparent=False
    if not sc.world: sc.world=bpy.data.worlds.new('w')
    sc.world.use_nodes=True
    sc.world.node_tree.nodes['Background'].inputs[0].default_value=(0.05,0.12,0.14,1)
    sc.world.node_tree.nodes['Background'].inputs[1].default_value=0.6
    if not bpy.data.objects.get('KeyL'):
        for nm,rot,e in (('KeyL',(math.radians(55),0,math.radians(30)),3.0),('KeyB',(math.radians(55),0,math.radians(210)),3.0)):
            ld=bpy.data.lights.new(nm,'SUN'); ld.energy=e
            lo=bpy.data.objects.new(nm,ld); sc.collection.objects.link(lo); lo.rotation_euler=rot
    V={'front':((0,-5,zc),(math.pi/2,0,0)),'back':((0,5,zc),(math.pi/2,0,math.pi)),'left':((5,0,zc),(math.pi/2,0,math.pi/2)),'right':((-5,0,zc),(math.pi/2,0,-math.pi/2))}
    for v in views:
        c=cam('cam_'+v,*V[v],scale); sc.camera=c
        sc.render.filepath=f'{prefix}_{v}.png'
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(c)
