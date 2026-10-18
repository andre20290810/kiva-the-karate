// 3D 表示（KIVA 3D / ALEXANDRE 3D）。ステージは静止（コンベア等の時間による背景移動なし）。
// 時刻・スコア・音声・入力は Game 側が持ち、ここは渡された動画時刻に合わせて描くだけ。
// モーションは単眼映像からの推定で、奥行き・回転は測定値ではない。
import { smoothFootCorrections, correctionAt } from './foot-stability.js';
import { Vfx3D, findLimbBones } from './vfx3d.js';

// スキン付き人体モデル（tools/character-3d で作成）。無ければ旧プロトタイプ（棒状の確認用）に戻す。
export const MODEL_SOURCES = Object.freeze({
  'kiva-3d': [
    { path: 'assets/3d/kiva_seipai.glb', kind: 'skinned' },
    { path: 'assets/3d/kiva_motion.glb', kind: 'legacy' },
  ],
  'alexandre-3d': [
    { path: 'assets/3d/alexandre_seipai.glb', kind: 'skinned' },
    { path: 'assets/3d/alexandre_proxy.glb', kind: 'legacy' },
  ],
});

const FLOOR_Y = -0.145;

export class ThreeStage {
  constructor(host) { this.host = host; this.active = false; this.loaded = false; this.loading = null; this.time = 0; }
  async init() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = this._init();
    try { await this.loading; } catch (e) { this.loading = null; throw e; }
  }
  async _init() {
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    this.THREE = THREE;
    const small = Math.min(screen.width || 9999, screen.height || 9999) < 700;
    this.quality = small ? 0.6 : 1;
    const renderer = new THREE.WebGLRenderer({ antialias: !small, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.25 : 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.id = 'threeStage';
    renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:2;display:none;pointer-events:none';
    this.host.append(renderer.domElement);
    this.renderer = renderer;
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x070b14); scene.fog = new THREE.FogExp2(0x070b14, 0.045);
    this.scene = scene;
    this.buildStage();
    this.camera = new THREE.PerspectiveCamera(32, 1, .05, 120);
    this.loader = new GLTFLoader();
    this.variants = new Map();
    this.vfx = new Vfx3D(THREE, scene, { quality: this.quality });
    this.vfx.camera = this.camera;
    await this.setupBloom();
    await this.setVariant('kiva-3d');
    this.loaded = true;
    this.resize();
  }

  buildStage() {
    const THREE = this.THREE, scene = this.scene;
    scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x1a1c26, 0.9));
    const key = new THREE.DirectionalLight(0xfff0dc, 2.4); key.position.set(2.2, 4.5, 3.6);
    key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -2, right: 2, top: 3, bottom: -1, near: .5, far: 12 });
    key.shadow.bias = -0.0004; scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd2ff, 0.55); fill.position.set(-3, 2, 2.5); scene.add(fill);
    // 輪郭光（人物の縁を背後から照らして背景から浮かせる）
    const rimL = new THREE.DirectionalLight(0x66c8ff, 2.6); rimL.position.set(-2.6, 2.6, -3.2); scene.add(rimL);
    const rimR = new THREE.DirectionalLight(0xffa860, 1.8); rimR.position.set(2.8, 2.2, -3.0); scene.add(rimR);
    // 床（暗い板張り風・弱い反射）。時間で動かさない
    const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 72), new THREE.MeshStandardMaterial({ color: 0x15171d, metalness: 0.15, roughness: 0.55 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR_Y; floor.receiveShadow = true; scene.add(floor);
    // 演武場の枠線と奥の柱（固定）
    const lineMat = new THREE.MeshBasicMaterial({ color: 0x2c8fc0, transparent: true, opacity: 0.55 });
    const sq = 2.6;
    for (const [x, z, w, d] of [[0, -sq, sq * 2, .025], [0, sq, sq * 2, .025], [-sq, 0, .025, sq * 2], [sq, 0, .025, sq * 2]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat); m.rotation.x = -Math.PI / 2; m.position.set(x, FLOOR_Y + 0.002, z); scene.add(m);
    }
    const colMat = new THREE.MeshStandardMaterial({ color: 0x1e232d, metalness: .6, roughness: .5 });
    const stripMat = new THREE.MeshBasicMaterial({ color: 0x3fb4e6 });
    for (const x of [-4.2, -1.6, 1.6, 4.2]) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(.3, 6, .3), colMat); col.position.set(x, 3 + FLOOR_Y, -6.5); scene.add(col);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(.04, 5.2, .02), stripMat); strip.position.set(x, 3 + FLOOR_Y, -6.34); scene.add(strip);
    }
  }

  async setupBloom() {
    try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'), import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'), import('three/addons/postprocessing/OutputPass.js')]);
      const T = this.THREE;
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new T.Vector2(256, 256), 0.6, 0.4, 0.96); // 白い道着は光らせず、演出だけを光らせる
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    } catch (e) {
      console.warn('bloom unavailable', e);
      this.composer = null;
    }
  }

  async loadVariant(id) {
    const errors = [];
    for (const src of MODEL_SOURCES[id] || MODEL_SOURCES['kiva-3d']) {
      try { return { gltf: await this.loader.loadAsync(src.path), ...src }; }
      catch (e) { errors.push(src.path + ': ' + e.message); }
    }
    throw new Error('3D model missing: ' + errors.join(' / '));
  }

  async setVariant(id) {
    if (id === this.variant) return this.asset;
    let entry = this.variants.get(id);
    if (!entry) { entry = await this.loadVariant(id); this.variants.set(id, entry); }
    const { gltf } = entry;
    if (!gltf.animations.length) throw new Error('3D animation missing: ' + id);
    if (this.model) this.scene.remove(this.model);
    this.model = gltf.scene;
    this.model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    this.scene.add(this.model);
    this.mixer = new this.THREE.AnimationMixer(this.model);
    this.action = this.mixer.clipAction(gltf.animations[0]);
    this.action.play();
    this.duration = gltf.animations[0].duration;
    this.mixer.setTime(0);
    this.footCorrections = [];
    if (entry.kind === 'skinned') {
      // 接地はモーション作成時に処理済み（Blender の床 z=0 → ここでは FLOOR_Y）
      this.model.position.set(0, FLOOR_Y, 0);
      this.model.scale.setScalar(1);
      this.vfx.setBones(findLimbBones(this.model));
    } else {
      this.calibrateLegacy();
      this.vfx.setBones({});
    }
    this.baseModelY = this.model.position.y;
    this.model.updateMatrixWorld(true);
    this.variant = id;
    this.hipsBone = null;
    this.asset = { path: entry.path, kind: entry.kind, duration: this.duration };
    this.resize();
    return this.asset;
  }

  // 旧プロトタイプ（2D 観測を板状に並べた確認用）の床合わせ。完成モデルとしては扱わない。
  calibrateLegacy() {
    const T = this.THREE;
    this.model.position.set(0, 0, 0);
    this.model.scale.setScalar(0.42);
    this.model.updateMatrixWorld(true);
    const feet = [];
    this.model.traverse((o) => { if (o.isMesh && /LEFT_FOOT|RIGHT_FOOT/i.test(o.name)) feet.push(o); });
    const bb = new T.Box3();
    if (feet.length) for (const o of feet) bb.expandByObject(o); else bb.setFromObject(this.model);
    this.model.position.y += FLOOR_Y - bb.min.y;
    this.model.updateMatrixWorld(true);
    const elevations = [];
    if (feet.length) {
      for (let i = 0; i <= Math.floor(this.duration * 5); i++) {
        this.mixer.setTime(Math.min(this.duration, i / 5));
        this.model.updateMatrixWorld(true);
        const b = new T.Box3(); for (const f of feet) b.expandByObject(f);
        elevations.push(b.min.y);
      }
    }
    this.footCorrections = smoothFootCorrections(elevations);
    this.mixer.setTime(0);
  }

  setEnabled(active) {
    this.active = active;
    if (this.renderer) this.renderer.domElement.style.display = active ? 'block' : 'none';
  }

  findBone(name) { let b = null; this.model?.traverse((o) => { if (!b && o.isBone && o.name === name) b = o; }); return b; }

  hit(e) { if (this.loaded) this.vfx.hit({ ...e, t: e.t ?? this.time }); }
  reset() { this.vfx?.reset(); }

  resize() {
    if (!this.renderer || !this.camera) return;
    const r = this.host.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    this.camera.aspect = w / h;
    // 人物（身長 約 1.6 m）と伸ばした腕・踏み込みが縦横どちらの画面にも収まる距離
    const vfov = this.camera.fov * Math.PI / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (w / h));
    const needH = 2.3, needW = 2.3;
    const distance = Math.max(needH / 2 / Math.tan(vfov / 2), needW / 2 / Math.tan(hfov / 2), 3.2);
    this.camera.position.set(0, 1.05, distance);
    this.camera.lookAt(0, 0.72, 0);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setSize(w, h);
      this.bloom.resolution.set(w * this.quality * 0.5, h * this.quality * 0.5);
    }
  }

  sync(vt) {
    if (!this.active || !this.loaded) return;
    this.resizeIfNeeded();
    const time = Math.max(0, Math.min(vt, this.duration));
    this.time = time;
    this.mixer.setTime(time);
    this.model.position.y = this.baseModelY + correctionAt(this.footCorrections || [], time);
    this.model.updateMatrixWorld(true);
    const hips = this.hipsBone || (this.hipsBone = this.findBone('root'));
    if (hips) { const v = hips.getWorldPosition(new this.THREE.Vector3()); this.vfx.center = [v.x, v.y, v.z]; }
    this.vfx.update(time);
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
  }

  resizeIfNeeded() {
    const r = this.host.getBoundingClientRect();
    if (r.width !== this._w || r.height !== this._h) { this._w = r.width; this._h = r.height; this.resize(); }
  }
}
