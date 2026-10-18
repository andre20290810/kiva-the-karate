import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const data=JSON.parse(readFileSync(join(root,'source/retarget-prototype/all_pose2d.json'),'utf8'));
const joints=[11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32];
const segments=[];
const frames=data.frames.map((f,i)=>{
 const bad=joints.filter(id=>f.joints[id].confidence<.6);
 let maxStep=0,fast=[];
 if(i){for(const id of joints){const p=f.joints[id],a=data.frames[i-1].joints[id];const dx=p.x-a.x,dy=p.y-a.y;const distance=Math.hypot(dx,dy);if(distance>maxStep)maxStep=distance;if(distance>.13)fast.push(id);}}
 return {i,t:f.time,lowConfidence:bad,fastJointIds:fast,maxStep:Number(maxStep.toFixed(4)),unreliable:bad.length>=3||fast.length>=3};
});
let active=null;
for(const f of frames){if(f.unreliable){if(!active)active={start:f.t,end:f.t,frames:0,maxStep:0};active.end=f.t;active.frames++;active.maxStep=Math.max(active.maxStep,f.maxStep);}
else if(active){segments.push(active);active=null;}}
if(active)segments.push(active);
const result={source:'2D landmarks detected from a single-camera video',warning:'Not real 3D ground truth. Large step may be a genuine fast karate motion, not necessarily detection error.',fps:data.fps,totalFrames:frames.length,jointCount:joints.length,unreliableFrames:frames.filter(f=>f.unreliable).length,lowConfidenceFrames:frames.filter(f=>f.lowConfidence.length>=3).length,fastMovementFrames:frames.filter(f=>f.fastJointIds.length>=3).length,segments,topRiskFrames:frames.filter(f=>f.unreliable).sort((a,b)=>b.lowConfidence.length-a.lowConfidence.length||b.maxStep-a.maxStep).slice(0,25)};
const path=join(root,'source/retarget-prototype/pose_quality_audit.json');
writeFileSync(path,JSON.stringify(result,null,2));console.log(JSON.stringify({totalFrames:result.totalFrames,unreliableFrames:result.unreliableFrames,lowConfidenceFrames:result.lowConfidenceFrames,fastMovementFrames:result.fastMovementFrames,segments:segments.slice(0,12)},null,2));
