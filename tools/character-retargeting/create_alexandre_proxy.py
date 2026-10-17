import bpy,json,math
from pathlib import Path
R=Path.cwd()
data=json.loads((R/'source/retarget-prototype/all_pose2d.json').read_text())
bpy.ops.wm.open_mainfile(filepath=str(R/'source/retarget-prototype/full_humanoid_motion.blend'))
def mat(name,rgb,metal=.1):
 m=bpy.data.materials.new(name);m.diffuse_color=(*rgb,1);m.use_nodes=True
 p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*rgb,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=.35
 return m
black=mat('Black leather coat',(0.014,.019,.031),.42)
red=mat('Burgundy red coat lining',(.26,.008,.021),.08)
silver=mat('Silver blue hair',(.55,.69,.83),.33)
skin=mat('Light face',(.67,.51,.43),.02)
pants=mat('Dark charcoal trousers',(.035,.041,.065),.16)
gloves=mat('Black gloves',(.008,.011,.018),.2)
metal=mat('Steel details',(.35,.38,.43),.72)
for obj in bpy.data.objects:
 if not obj.type=='MESH':continue
 n=obj.name
 obj.data.materials.clear()
 obj.data.materials.append(skin if 'HEAD' in n else gloves if 'FOREARM' in n or 'ARM' in n else pants if 'THIGH' in n or 'SHIN' in n or 'FOOT' in n else black)
def loc(f,i):
 p=f['joints'][i];return ((p['x']-.5)*5.2,0,(.86-p['y'])*5.2)
def mid(f,a,b):
 x=loc(f,a);y=loc(f,b);return tuple((x[i]+y[i])/2 for i in range(3))
def panel(n,coords,material):
 verts=[(x,y,z) for x,y,z in coords]
 faces=[(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
 mesh=bpy.data.meshes.new(n);mesh.from_pydata(verts,[],faces);mesh.update()
 obj=bpy.data.objects.new(n,mesh);bpy.context.collection.objects.link(obj);obj.data.materials.append(material)
 return obj
def wedge(n,x0,x1,xb0,xb1,h,y,material):
 return panel(n,[(x0,y,0),(x1,y,0),(xb1,y,-h),(xb0,y,-h),(x0,y+.065,0),(x1,y+.065,0),(xb1,y+.065,-h),(xb0,y+.065,-h)],material)
coats=[
 wedge('Coat left exterior',-.38,-.03,-.58,-.02,1.05,-.13,black),
 wedge('Coat right exterior',.03,.38,.02,.58,1.05,-.13,black),
 wedge('Coat left scarlet interior',-.39,-.04,-.57,-.03,1.03,-.065,red),
 wedge('Coat right scarlet interior',.04,.39,.03,.57,1.03,-.065,red),
 wedge('Coat rear split panel',-.32,.32,-.47,.47,1.08,.11,black)
]
hair=[
 wedge('Silver long hair main',-.18,.18,-.28,.28,.85,.19,silver),
 wedge('Silver hair left strand',-.21,-.09,-.32,-.15,.61,-.12,silver),
 wedge('Silver hair right strand',.09,.21,.15,.32,.69,-.12,silver)
]
bpy.ops.mesh.primitive_cube_add(size=1);belt=bpy.context.object;belt.name='Black belt buckle';belt.data.materials.append(metal);belt.scale=(.15,.075,.08)
for f in data['frames']:
 frame=round(f['time']*25)+1
 hip=mid(f,23,24);head=loc(f,0);face=(head[0],head[1],head[2]+.12)
 for j,o in enumerate(coats):
  sway=math.sin(f['time']*2.2+j*.8)*.045
  o.location=(hip[0],hip[1],hip[2]+.04)
  o.rotation_euler=(0,sway,0)
  o.keyframe_insert(data_path='location',frame=frame);o.keyframe_insert(data_path='rotation_euler',frame=frame)
 for j,o in enumerate(hair):
  o.location=(face[0],face[1],face[2]+.055)
  o.rotation_euler=(0,math.sin(f['time']*2+j)*.045,0)
  o.keyframe_insert(data_path='location',frame=frame);o.keyframe_insert(data_path='rotation_euler',frame=frame)
 belt.location=(hip[0],hip[1]-.07,hip[2]+.18);belt.keyframe_insert(data_path='location',frame=frame)
scene=bpy.context.scene
scene['NOTICE']='Low poly appearance proxy, 2D tracked source motion; NOT faithful 3D capture or approved likeness.'
scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=str(R/'source/retarget-prototype/alexandre_appearance_proxy.blend'))
bpy.ops.export_scene.gltf(filepath=str(R/'source/retarget-prototype/alexandre_appearance_proxy.glb'),export_format='GLB',export_animations=True)
print('ALEXANDRE_PROXY_EXPORTED')
