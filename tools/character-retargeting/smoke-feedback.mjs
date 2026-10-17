import {chromium} from 'playwright-core';
const b=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try{
 const p=await b.newPage({viewport:{width:1200,height:800}});const err=[];
 p.on('pageerror',e=>err.push(e.message));await p.goto('http://127.0.0.1:8177/');
 await p.waitForFunction(()=>window.__game?.state==='ready');
 for(const mode of ['kiva-video','kiva-3d','alexandre-3d']){
  await p.selectOption('#displayMode',mode);
  await p.waitForFunction(m=>window.__game.displayMode===m,mode);
  const r=await p.evaluate(m=>{
   const g=window.__game;g.feedback.reset();
   g.feedback.hit({t:1,grade:'PERFECT',anchor:{x:288,y:580}});
   g.feedback.render(1.15,m);
   const c=document.querySelector('#hitOverlay');
   const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
   let nonzero=0;for(let i=3;i<a.length;i+=4)if(a[i]>0)nonzero++;
   return {mode:g.displayMode,canvas:c.width,ringPixels:nonzero,visualMode:document.querySelector('#displayMode').value};
  },mode);
  console.log(JSON.stringify({r,err}));
  await p.screenshot({path:'source/feedback-'+mode+'.png'});
 }
 await p.close();
}finally{await b.close();}
