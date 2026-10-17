import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const manifest=JSON.parse(readFileSync(join(root,'source/seipai_assets/manifest.json'),'utf8'));
if(manifest.frames.some(f=>f.pose_landmarks?.length!==33))throw Error('Missing 33 landmarks');
const out={format:'kiva-pose2d-v1',canvas:manifest.canvas,fps:manifest.sample_fps,frames:manifest.frames.map(f=>({time:f.time_s,sourceFrame:f.source_frame,joints:f.pose_landmarks.map((p,i)=>({id:i,x:p.x,y:p.y,confidence:p.visibility??0}))})),depthStatus:'UNOBSERVED; two-dimensional landmark observations only'};
const dir=join(root,'source/retarget-prototype');mkdirSync(dir,{recursive:true});
writeFileSync(join(dir,'all_pose2d.json'),JSON.stringify(out));
console.log(out.frames.length+' frames exported, 33 joints each');
