// Original video is synchronized to the game's audio clock, not used as a time authority.
export class OriginalVideoMode {
  constructor(host,src){
    this.video=document.createElement('video');
    this.video.id='originalVideo';
    this.video.setAttribute('playsinline','');
    this.video.playsInline=true;
    this.video.muted=true;
    this.video.preload='auto';
    this.video.src=src;
    this.video.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#07090d;z-index:1;pointer-events:none;display:none';
    host.append(this.video);
    this.enabled=false;
    this.video.addEventListener('error',()=>{this.error='Original video could not be loaded';});
  }
  setEnabled(enabled){
    this.enabled=!!enabled;
    this.video.style.display=this.enabled?'block':'none';
    if(!this.enabled)this.video.pause();
  }
  sync(sourceTime,isPlaying,rate=1){
    if(!this.enabled)return;
    const v=this.video;
    if(v.readyState<1)return;
    const target=Math.max(0,Math.min(Number.isFinite(v.duration)?v.duration:Infinity,sourceTime));
    if(Math.abs(v.currentTime-target)>0.09)try{v.currentTime=target}catch{}
    v.playbackRate=Math.max(0.25,Math.min(4,rate));
    if(isPlaying){if(v.paused)v.play().catch(()=>{});}
    else if(!v.paused)v.pause();
  }
}
