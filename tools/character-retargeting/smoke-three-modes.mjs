import {chromium} from 'playwright-core';
const b=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try{
for(const v of [{width:1200,height:800},{width:390,height:844},{width:844,height:390}]){
 const p=await b.newPage({viewport:v});const errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.goto('http://127.0.0.1:8177/');
 await p.waitForFunction(()=>['ready','error'].includes(window.__game?.state),null,{timeout:90000});
 for(const id of ['kiva-video','kiva-3d','alexandre-3d','kiva-video']){
  await p.selectOption('#displayMode',id);
  await p.waitForFunction(id=>window.__game?.displayMode===id||document.querySelector('#status')?.dataset.kind==='error',id,{timeout:30000});
  const value=await p.evaluate(()=>({mode:window.__game.displayMode,loaded:window.__game.threeStage?.loaded,variant:window.__game.threeStage?.variant,threeDuration:window.__game.threeStage?.duration,videoVisible:getComputedStyle(document.querySelector('#originalVideo')).display,threeVisible:document.querySelector('#threeStage')?getComputedStyle(document.querySelector('#threeStage')).display:'none',notice:document.querySelector('#status').textContent}));
  console.log(JSON.stringify({viewport:v,selected:id,result:value,errors}));
  if(id!=='kiva-video')await p.screenshot({path:'source/three-'+id+'-'+v.width+'.png'});
 }
 await p.close();
}
}finally{await b.close();}
