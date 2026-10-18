// Stabilize visual foot-height estimates without inventing 3D ground truth.
// The input is the vertical height of the lowest visible foot for each sample.
export function smoothFootCorrections(heights, target=-0.145, maxCorrection=.24) {
 if(!Array.isArray(heights)||heights.length===0) return [];
 const safe=heights.map(v=>Number.isFinite(v)?v:NaN);
 const median=xs=>xs.slice().sort((a,b)=>a-b)[Math.floor(xs.length/2)];
 const clean=safe.map((v,i)=>{
  const around=safe.slice(Math.max(0,i-2),Math.min(safe.length,i+3)).filter(Number.isFinite);
  return around.length?median(around):(Number.isFinite(v)?v:target);
 });
 // A low-pass window keeps ankle visibility jitter from shaking the entire model.
 const filtered=clean.map((_,i)=>{
  let sum=0,weight=0;
  for(let j=Math.max(0,i-2);j<=Math.min(clean.length-1,i+2);j++){
   const w=3-Math.abs(j-i);sum+=clean[j]*w;weight+=w;
  }
  return Math.max(-maxCorrection,Math.min(maxCorrection,target-sum/weight));
 });
 return filtered;
}
export function correctionAt(values,t,fps=5){
 if(!values.length||!Number.isFinite(t))return 0;
 const v=Math.max(0,Math.min(values.length-1,t*fps));
 const i=Math.floor(v),j=Math.min(values.length-1,i+1);
 return values[i]+(values[j]-values[i])*(v-i);
}
