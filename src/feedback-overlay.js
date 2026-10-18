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
  // 3D 表示では 3D 側（vfx3d.js）が手足のボーンに結び付けて描く
  return null;
 }
 render(t,mode){
  const w=this.host.clientWidth,h=this.host.clientHeight,dpr=Math.min(devicePixelRatio||1,2);
  const cw=Math.round(w*dpr),ch=Math.round(h*dpr);
  if(this.canvas.width!==cw||this.canvas.height!==ch){this.canvas.width=cw;this.canvas.height=ch;}
  const g=this.ctx;g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  if(!w||!h)return;
  this.events=this.events.filter(e=>t-e.t<.6 && t>=e.t-.05);
  if(mode.endsWith('-3d'))return;
  for(const e of this.events){
   const age=Math.max(0,t-e.t),life=Math.max(0,1-age/.55);
   const p=this.point(e.anchor,mode,w,h);
   if(!p||!Number.isFinite(p.x)||p.x<0||p.x>w||p.y<0||p.y>h)continue;
   const radius=16+age*145;
   const rgb=e.grade==='PERFECT'?'255,199,71':'79,195,255';
   const brightness=e.grade==='PERFECT'?1:.68;
   g.save();g.globalCompositeOperation='screen';
   // Layered shockwave outside the body, visible above both 3D and original video.
   const glow=g.createRadialGradient(p.x,p.y,Math.max(1,radius*.36),p.x,p.y,radius*1.9);
   glow.addColorStop(0,'rgba('+rgb+',0)');
   glow.addColorStop(.55,'rgba('+rgb+',0)');
   glow.addColorStop(.75,'rgba('+rgb+','+(life*.16*brightness)+')');
   glow.addColorStop(1,'rgba('+rgb+',0)');
   g.fillStyle=glow;g.beginPath();g.arc(p.x,p.y,radius*1.9,0,Math.PI*2);g.fill();
   for(let ring=0;ring<3;ring++){
     const r=radius*(1+ring*.26);
     g.lineWidth=(5-ring*1.2)*life;
     g.strokeStyle='rgba('+rgb+','+(life*(.83-ring*.22)*brightness)+')';
     g.shadowColor='rgba('+rgb+',.9)';g.shadowBlur=15*life;
     g.beginPath();g.arc(p.x,p.y,r,Math.PI*(.13+ring*.08),Math.PI*(.91+ring*.08));g.stroke();
     g.beginPath();g.arc(p.x,p.y,r,Math.PI*(1.13+ring*.08),Math.PI*(1.91+ring*.08));g.stroke();
   }
   // Deterministic sparks, so pause/resume and replay draw identically.
   for(let k=0;k<16;k++){
     const angle=k*Math.PI*2/16 + k*.137;
     const near=radius*1.05,far=radius*(1.6+(k%4)*.2);
     const x1=p.x+Math.cos(angle)*near,y1=p.y+Math.sin(angle)*near;
     const x2=p.x+Math.cos(angle)*far,y2=p.y+Math.sin(angle)*far;
     g.lineWidth=(1.5+(k%3))*life;g.strokeStyle='rgba('+rgb+','+(life*.77*brightness)+')';
     g.beginPath();g.moveTo(x1,y1);g.lineTo(x1+(x2-x1)*life,y1+(y2-y1)*life);g.stroke();
   }
   g.shadowBlur=0;
   g.restore();
  }
 }
}
