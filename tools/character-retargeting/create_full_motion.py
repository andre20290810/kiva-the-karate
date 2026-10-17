import bpy,json
from pathlib import Path
from mathutils import Vector
R=Path.cwd()
D=json.loads((R/'source/retarget-prototype/all_pose2d.json').read_text())
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
sc=bpy.context.scene;sc.render.fps=25;sc.frame_end=round(D['frames'][-1]['time']*25)+1
sc['NOTICE']='2.5D reference mannequin only: no real 3D depth measured'
def pos(f,i):
 p=f['joints'][i];return Vector(((p['x']-.5)*5.2,0,(.86-p['y'])*5.2))
def pt(f,k):
 if k=='neck':return (pos(f,11)+pos(f,12))/2
 if k=='hip':return (pos(f,23)+pos(f,24))/2
 if k=='head':return pos(f,0)+Vector((0,0,.17))
 return pos(f,int(k))
def material(n,c):
 m=bpy.data.materials.new(n);m.diffuse_color=(*c,1);return m
skin=material('bronze head',(.72,.54,.35));torso=material('navy torso',(.08,.22,.36));left=material('teal left',(.05,.65,.58));right=material('orange right',(.94,.38,.16));pants=material('dark legs',(.18,.21,.27))
edges=[('neck','hip','TORSO',.16,torso),('11','12','SHOULDERS',.12,torso),('23','24','HIPS',.11,pants),('neck','head','NECK',.075,skin),('11','13','LEFT_ARM',.08,left),('13','15','LEFT_FOREARM',.07,left),('12','14','RIGHT_ARM',.08,right),('14','16','RIGHT_FOREARM',.07,right),('23','25','LEFT_THIGH',.105,pants),('25','27','LEFT_SHIN',.08,left),('24','26','RIGHT_THIGH',.105,pants),('26','28','RIGHT_SHIN',.08,right),('27','31','LEFT_FOOT',.08,left),('28','32','RIGHT_FOOT',.08,right)]
objs=[]
for a,b,n,r,m in edges:
 bpy.ops.mesh.primitive_cylinder_add(vertices=12,radius=r,depth=1)
 o=bpy.context.object;o.name=n;o.data.materials.append(m);objs.append((o,a,b))
bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=10,radius=.18)
head=bpy.context.object;head.name='HEAD_REFERENCE_ONLY';head.data.materials.append(skin)
for f in D['frames']:
 t=round(f['time']*25)+1
 for o,a,b in objs:
  p=pt(f,a);q=pt(f,b);vec=q-p
  if vec.length<.001:vec.z=.001
  o.location=(p+q)/2;o.rotation_euler=vec.to_track_quat('Z','Y').to_euler();o.scale=(1,1,vec.length)
  for prop in ('location','rotation_euler','scale'):o.keyframe_insert(data_path=prop,frame=t)
 head.location=pt(f,'head');head.keyframe_insert(data_path='location',frame=t)
bpy.ops.object.camera_add(location=(0,-12,2))
cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,1.4))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=5.5;sc.camera=cam
sc.frame_set(1)
out=R/'source/retarget-prototype/full_humanoid_motion.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(out))
print('PREVIEW_SAVED='+str(out))