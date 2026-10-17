// Export measured 2D poses only. Missing depth is explicitly unknown.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const src=JSON.parse(readFileSync(join(root,'source/seipai_assets/manifest.json'),'utf8'));
const frames=src.frames.slice(0,50);
if(frames.some(f=>!Array.isArray(f.pose_landmarks)||f.pose_landmarks.length<33))throw new Error('33-joint data missing');
const output={format:'kiva-pose2d-v1',source:'seipai.mp4',fps:src.sample_fps,canvas:src.canvas,frameCount:frames.length,threeDimensional:false,depthStatus:'unobserved - do not infer as ground truth',frames:frames.map(f=>({time:f.time_s,sourceFrame:f.source_frame,joints:f.pose_landmarks.map((p,i)=>({id:i,x:p.x,y:p.y,confidence:p.visibility??0}))}))};
const dest=join(root,'source/retarget-prototype');mkdirSync(dest,{recursive:true});
writeFileSync(join(dest,'first_10_seconds_pose2d.json'),JSON.stringify(output));
writeFileSync(join(dest,'quality_report.json'),JSON.stringify({frames:frames.length,jointsPerFrame:33,firstTime:frames[0].time_s,lastTime:frames.at(-1).time_s,has3D:false,limitations:['single view','unknown limb depth','manual 3D pose correction required']},null,2));
console.log('Exported '+frames.length+' frames, '+33+' joints to source/retarget-prototype');
