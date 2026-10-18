// Native HTMLMediaElement output for mobile Safari/Chrome.
// WebAudio remains the authoritative song clock, but avoids output-routing
// issues on phones. Never mix both outputs simultaneously.
export class MobileAudioOutput {
 constructor(source='assets/seipai/audio.m4a'){
  this.enabled=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if(!this.enabled)return;
  const a=new Audio(source);
  a.preload='auto';a.loop=false;a.playsInline=true;
  this.audio=a;this.ready=false;
  a.addEventListener('error',()=>{this.error='Unable to load mobile audio';});
 }
 prime(volume,from=0){
  if(!this.enabled)return;
  const a=this.audio;
  a.volume=Math.max(0,Math.min(1,volume));
  a.currentTime=Math.max(0,from);
  // Trigger synchronously from Start/Resume tap, before awaiting AudioContext.
  this.error=null;
  this.playPromise=a.play().then(()=>{this.ready=true;}).catch(e=>{this.error=e.message;this.ready=false;});
 }
 sync(t,playing,rate,volume){
  if(!this.enabled)return;
  const a=this.audio;a.volume=Math.max(0,Math.min(1,volume));
  a.playbackRate=Math.max(.5,Math.min(2,rate));
  if(!playing){if(!a.paused)a.pause();return;}
  if(a.paused){a.play().catch(e=>{this.error=e.message;});}
  if(Number.isFinite(t)&&Math.abs(a.currentTime-t)>.18)try{a.currentTime=Math.max(0,t)}catch{}
 }
 stop(){if(this.enabled){this.audio.pause();this.audio.currentTime=0;this.ready=false;}}
}
