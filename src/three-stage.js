// Technical 3D motion preview. Depth in the source motion is unmeasured.
// Stage is deliberately stationary; scoring/audio/gamepad live in Game.
import { smoothFootCorrections, correctionAt } from './foot-stability.js';
export class ThreeStage {
 constructor(host){this.host=host;this.active=false;this.loaded=false;this.loading=null;}
 async init(){
  if(this.loaded)return;
  if(this.loading)return this.loading;
  this.loading=this._init();
  try{await this.loading;}catch(e){this.loading=null;throw e;}
 }
 async _init(){
  const THREE=await import('three');
  const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
  this.THREE=THREE;
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.domElement.id='threeStage';
  renderer.domElement.style.cssText='position:absolute;inset:0;width:100%;height:100%;z-index:2;display:none;pointer-events:none';
  this.host.append(renderer.domElement);
  this.renderer=renderer;
  const scene=new THREE.Scene();scene.background=new THREE.Color(0x09101b);scene.fog=new THREE.FogExp2(0x09101b,0.018);
  this.scene=scene;
  scene.add(new THREE.HemisphereLight(0x9bc9ff,0x262a3a,2.1));
  const light=new THREE.DirectionalLight(0xffe8cc,2.8);light.position.set(-4,9,6);scene.add(light);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(80,80),new THREE.MeshStandardMaterial({color:0x1b2029,metalness:0.75,roughness:0.37}));
  floor.rotation.x=-Math.PI/2;floor.position.y=-0.15;scene.add(floor);
  const grid=new THREE.GridHelper(40,40,0x2fa9db,0x293b50);grid.position.y=-0.14;scene.add(grid);
  // Stationary environment: no conveyor movement, no time-based background animation.
  const railMat=new THREE.MeshStandardMaterial({color:0x35a5cc,emissive:0x082d50,metalness:0.8});
  for(const x of [-4.8,4.8]){
    const rail=new THREE.Mesh(new THREE.BoxGeometry(0.06,0.06,60),railMat);
    rail.position.set(x,-0.1,0);scene.add(rail);
  }
  for(const x of [-5.7,5.7]){
    const col=new THREE.Mesh(new THREE.BoxGeometry(.24,6,.24),new THREE.MeshStandardMaterial({color:0x272d39,metalness:.8}));
    col.position.set(x,3,-4.5);scene.add(col);
  }
  this.camera=new THREE.PerspectiveCamera(34,1,.1,120);
  this.camera.position.set(0,2.2,6.2);this.camera.lookAt(0,1.25,0);
  this.loader=new GLTFLoader();
  this.variants=new Map();
  await this.setVariant('kiva-3d');
  this.loaded=true;
  this.resize();
 }
 async setVariant(id){
  if(id===this.variant)return;
  const path=id==='alexandre-3d'?'assets/3d/alexandre_proxy.glb':'assets/3d/kiva_motion.glb';
  let gltf=this.variants.get(id);
  if(!gltf){gltf=await this.loader.loadAsync(path);this.variants.set(id,gltf);}
  if(!gltf.animations.length)throw new Error('3D animation missing: '+id);
  if(this.model)this.scene.remove(this.model);
  this.model=gltf.scene;
  // Visual baseline calibration only; 2D data cannot prove foot contact.
  this.model.position.y=0;
  this.scene.add(this.model);
  this.mixer=new this.THREE.AnimationMixer(this.model);
  this.action=this.mixer.clipAction(gltf.animations[0]);
  this.action.play();
  this.mixer.setTime(0);
  this.model.updateMatrixWorld(true);
  // Use tracked FOOT meshes, not the lower edge of Alexandre's long coat.
  const feet=[];
  this.model.traverse(o=>{if(o.isMesh && /LEFT_FOOT|RIGHT_FOOT/i.test(o.name))feet.push(o);});
  const bb=new this.THREE.Box3();
  if(feet.length){for(const o of feet)bb.expandByObject(o);}
  else bb.setFromObject(this.model);
  this.model.position.y += -0.145 - bb.min.y;
  this.model.updateMatrixWorld(true);
  this.floorCalibration={baselineFoot:bb.min.y,footParts:feet.length,applied:this.model.position.y};
  this.baseModelY=this.model.position.y;
  this.duration=gltf.animations[0].duration;
  // Sample foot clearance at the source's 5 Hz motion rate. Compensate only
  // moderate floating, never infer horizontal contact or unobserved depth.
  const elevations=[];
  if(feet.length){
    for(let i=0;i<=Math.floor(this.duration*5);i++){
      this.mixer.setTime(Math.min(this.duration,i/5));
      this.model.updateMatrixWorld(true);
      const bounds=new this.THREE.Box3();
      for(const foot of feet)bounds.expandByObject(foot);
      elevations.push(bounds.min.y);
    }
  }
  this.footCorrections=smoothFootCorrections(elevations);
  this.mixer.setTime(0);
  this.model.position.y=this.baseModelY;
  this.model.updateMatrixWorld(true);
  this.variant=id;
 }
 setEnabled(active){
  this.active=active;
  if(this.renderer)this.renderer.domElement.style.display=active?'block':'none';
 }
 resize(){
  if(!this.loaded)return;
  const r=this.host.getBoundingClientRect();
  const w=Math.max(1,r.width),h=Math.max(1,r.height);
  this.camera.aspect=w/h;
  // Keep both arms in frame on narrow portrait screens.
  const hfov=2*Math.atan(Math.tan(this.camera.fov*Math.PI/360)*(w/h));
  const distance=Math.max(5.9,1.75/Math.tan(hfov/2));
  this.camera.position.set(0,2.1,distance);
  this.camera.lookAt(0,1.0,0);
  this.camera.updateProjectionMatrix();this.renderer.setSize(w,h,false);
 }
 sync(vt){
  if(!this.active||!this.loaded)return;
  this.resizeIfNeeded();
  const time=Math.max(0,Math.min(vt,this.duration));
  this.mixer.setTime(time);
  this.model.position.y=this.baseModelY+correctionAt(this.footCorrections||[],time);
  this.renderer.render(this.scene,this.camera);
 }
 resizeIfNeeded(){
  const r=this.host.getBoundingClientRect();
  if(r.width!==this._w||r.height!==this._h){this._w=r.width;this._h=r.height;this.resize();}
 }
}
