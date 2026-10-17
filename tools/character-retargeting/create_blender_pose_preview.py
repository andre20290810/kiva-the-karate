import bpy, json, math
from pathlib import Path
from mathutils import Vector
root=Path(__file__).resolve().parents[2]
data=json.loads((root/'source/retarget-prototype/first_10_seconds_pose2d.json').read_text())
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
scene.render.fps=25
scene.frame_start=1
scene.frame_end=250
scene['warning']='2D OBSERVATIONS ONLY: all Z=0. NOT actual 3D motion.'
ids=[0,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]
labels={0:'Nose',11:'LeftShoulder',12:'RightShoulder',13:'LeftElbow',14:'RightElbow',15:'LeftWrist',16:'RightWrist',23:'LeftHip',24:'RightHip',25:'LeftKnee',26:'RightKnee',27:'LeftAnkle',28:'RightAnkle',29:'LeftHeel',30:'RightHeel',31:'LeftFoot',32:'RightFoot'}
material=bpy.data.materials.new('ReferencePoints_NotFinalCharacter')
material.diffuse_color=(0.15,0.75,1,1)
for i in ids:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=8,radius=.035)
    obj=bpy.context.object
    obj.name=f'Observed2D_{i:02}_{labels[i]}'
    obj.data.materials.append(material)
    for fr in data['frames']:
        p=fr['joints'][i]
        frame=round(fr['time']*25)+1
        obj.location=((p['x']-.5)*4, (.9-p['y'])*4, 0)
        obj.keyframe_insert(data_path='location',frame=frame)
# Coordinate grid is only a display guide; no depth.
bpy.ops.object.camera_add(location=(0,0,9))
camera=bpy.context.object
camera.rotation_euler=(0,0,0)
camera.data.type='ORTHO'
camera.data.ortho_scale=5
scene.camera=camera
scene.frame_set(1)
dest=root/'source/retarget-prototype/pose2d_preview.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(dest))
print('PREVIEW_SAVED='+str(dest))
