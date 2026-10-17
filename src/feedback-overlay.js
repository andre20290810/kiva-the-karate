// Subtle, character-relative foreground hit cues shared by original-video and 3D views.
// Strictly presentation-only. Never changes score, timing, or game state.
export class FeedbackOverlay {
 constructor(host,frameWidth,frameHeight,threeStage) {
  this.host=host;this.fw=frameWidth;this.fh=frameHeight;this.three=threeStage;
  this.events=[];
  const canvas=document.createElement('canvas');
  canvas.id='hitOverlay';
  canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3';
  this.canvas=canvas;this.ctx=canvas.getContext('2d');
  host.append(canvas);
 }
 reset(){this.events.length=0;this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height);}
 hit(event){if(event.grade==='MISS')return;this.events.push(event);if(this.events.length>35)this.events.shift();}
 point(anchor,mode,w,h){
  if(mode==='kiva-video'){
   const s=Math.min(w/this.fw,h/this.fh);
   return {x:(w-this.fw*s)/2+anchor.x*s,y:(h-this.fh*s)/2+anchor.y*s};
  }
  if(mode.endsWith('-3d')&&this.three.loaded&&this.three.active){
   const T=this.three.THREE;
   const p=new T.Vector3((anchor.x/this.fw-.5)*5.2,(.86-anchor.y/this.fh)*5.2-.55,0);
   p.project(this.three.camera);
   return {x:(p.x*.5+.5)*w,y:(-.5*p.y+.5)*h};
  }
  return null;
 }
 render(t,mode){
  const w=this.host.clientWidth,h=this.host.clientHeight,dpr=Math.min(devicePixelRatio||1,2);
  const cw=Math.round(w*dpr),ch=Math.round(h*dpr);
  if(this.canvas.width!==cw||this.canvas.height!==ch){this.canvas.width=cw;this.canvas.height=ch;}
  const g=this.ctx;g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  if(!w||!h)return;
  this.events=this.events.filter(e=>t-e.t<.6 && t>=e.t-.05);
  for(const e of this.events){
   const age=Math.max(0,t-e.t),life=Math.max(0,1-age/.55);
   const p=this.point(e.anchor,mode,w,h);
   if(!p||!Number.isFinite(p.x)||p.x<0||p.x>w||p.y<0||p.y>h)continue;
   const radius=18+age*92;
   const rgb=e.grade==='PERFECT'?'255,203,93':'96,200,251';
   g.save();g.globalCompositeOperation='screen';g.lineWidth=2.4*life;
   g.strokeStyle='rgba('+rgb+','+(life*.48)+')';
   g.shadowColor='rgba('+rgb+',.35)';g.shadowBlur=5*life;
   g.beginPath();g.arc(p.x,p.y,radius,Math.PI*.12,Math.PI*.88);g.stroke();
   g.beginPath();g.arc(p.x,p.y,radius,Math.PI*1.12,Math.PI*1.88);g.stroke();
   g.restore();
  }
 }
}
