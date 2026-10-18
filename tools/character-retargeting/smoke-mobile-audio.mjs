import {chromium} from 'playwright-core';
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
try{
 const ctx=await browser.newContext({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',isMobile:true,hasTouch:true});
 const p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto('http://127.0.0.1:8177/');
 await p.waitForFunction(()=>window.__game?.state==='ready',null,{timeout:90000});
 await p.click('#btnStart');await p.waitForTimeout(1800);
 const first=await p.evaluate(()=>({state:window.__game.state,mobile:window.__game.mobileAudio.enabled,ready:window.__game.mobileAudio.ready,error:window.__game.mobileAudio.error,paused:window.__game.mobileAudio.audio.paused,current:window.__game.mobileAudio.audio.currentTime,audioGain:window.__game.clock.gain.gain.value}));
 await p.click('#btnPause');await p.waitForTimeout(250);
 const paused=await p.evaluate(()=>({state:window.__game.state,nativePaused:window.__game.mobileAudio.audio.paused}));
 await p.click('#btnPause');await p.waitForTimeout(550);
 const resumed=await p.evaluate(()=>({state:window.__game.state,current:window.__game.mobileAudio.audio.currentTime,error:window.__game.mobileAudio.error}));
 console.log(JSON.stringify({first,paused,resumed,errors}));
 await ctx.close();
}finally{await browser.close();}
