import {readFileSync,writeFileSync} from 'node:fs';
let s=readFileSync('src/feedback-overlay.js','utf8');
const start=s.indexOf('   const radius=18+age*92;');
const end=s.indexOf('   g.restore();',start);
if(start<0||end<0)throw Error('overlay anchor not found');
s=s.slice(0,start)+`   const radius=16+age*145;
   const rgb=e.grade==='PERFECT'?'255,199,71':'79,195,255';
   const brightness=e.grade==='PERFECT'?1:.68;
   g.save();g.globalCompositeOperation='screen';
   // Layered shockwave outside the body, visible above both 3D and original video.
   const glow=g.createRadialGradient(p.x,p.y,Math.max(1,radius*.36),p.x,p.y,radius*1.9);
   glow.addColorStop(0,'rgba('+rgb+',0)');
   glow.addColorStop(.43,'rgba('+rgb+','+(life*.28*brightness)+')');
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
     const near=radius*.6,far=radius*(1.5+(k%4)*.2);
     const x1=p.x+Math.cos(angle)*near,y1=p.y+Math.sin(angle)*near;
     const x2=p.x+Math.cos(angle)*far,y2=p.y+Math.sin(angle)*far;
     g.lineWidth=(1.5+(k%3))*life;g.strokeStyle='rgba('+rgb+','+(life*.77*brightness)+')';
     g.beginPath();g.moveTo(x1,y1);g.lineTo(x1+(x2-x1)*life,y1+(y2-y1)*life);g.stroke();
   }
   g.shadowBlur=0;g.fillStyle='rgba(255,255,255,'+(life*.45*brightness)+')';
   g.beginPath();g.arc(p.x,p.y,Math.max(2,8*life),0,Math.PI*2);g.fill();
`+s.slice(end);
writeFileSync('src/feedback-overlay.js',s);
console.log('Layered foreground VFX applied');
