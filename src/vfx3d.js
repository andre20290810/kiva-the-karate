// 3D 表示用のヒット演出。拳・足のボーンに結び付け、時刻（アニメーション時刻）の関数として描く。
// 状態は「いつ・どこで・どちら向きに当たったか」だけを持ち、粒子の位置は経過時間から毎フレーム計算する
// （一時停止・再開・巻き戻しで同じ絵になる）。スコア・判定・時刻には一切触れない。

const LIMBS = ['wrist.L', 'wrist.R', 'foot.L', 'foot.R'];
const LIFE = 0.75;
const SPARKS = 34;

function rand(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function glowTexture(THREE, size = 128, core = 0.18) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(core, 'rgba(255,255,255,.85)');
  r.addColorStop(.45, 'rgba(255,255,255,.22)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// 加算合成の点群（各点: 位置・色・大きさ・不透明度）
function pointsMaterial(THREE, map) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, scale: { value: 600 } },
    vertexShader: `attribute float size; attribute float alpha; attribute vec3 tint; varying float vA; varying vec3 vC;
      uniform float scale;
      void main(){ vA=alpha; vC=tint; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=size*scale/max(.1,-mv.z); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform sampler2D map; varying float vA; varying vec3 vC;
      void main(){ vec4 t=texture2D(map,gl_PointCoord); gl_FragColor=vec4(vC*t.rgb, t.a*vA); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

function pool(THREE, n, material) {
  const geo = new THREE.BufferGeometry();
  const attr = (k, size) => { const a = new THREE.BufferAttribute(new Float32Array(n * size), size); a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(k, a); return a; };
  const p = { pos: attr('position', 3), tint: attr('tint', 3), size: attr('size', 1), alpha: attr('alpha', 1), n, used: 0 };
  p.points = new THREE.Points(geo, material);
  p.points.frustumCulled = false;
  p.reset = () => { p.used = 0; };
  p.push = (x, y, z, r, g, b, s, a) => {
    if (p.used >= n || a <= 0.003) return;
    const i = p.used++;
    p.pos.array.set([x, y, z], i * 3); p.tint.array.set([r, g, b], i * 3); p.size.array[i] = s; p.alpha.array[i] = a;
  };
  p.flush = () => {
    geo.setDrawRange(0, p.used);
    for (const a of [p.pos, p.tint, p.size, p.alpha]) a.needsUpdate = true;
  };
  return p;
}

export function findLimbBones(root) {
  // glTF の書き出しで '.' が落ちる場合（wristL）にも対応する
  const out = {};
  const norm = (s) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const want = Object.fromEntries(LIMBS.map((k) => [norm(k), k]));
  root.traverse((o) => { if (o.isBone && want[norm(o.name)] && !out[want[norm(o.name)]]) out[want[norm(o.name)]] = o; });
  return out;
}

export class Vfx3D {
  constructor(THREE, scene, { quality = 1 } = {}) {
    this.THREE = THREE; this.scene = scene; this.quality = quality;
    this.group = new THREE.Group(); this.group.name = 'vfx3d'; scene.add(this.group);
    const glow = glowTexture(THREE);
    this.sparks = pool(THREE, 2600, pointsMaterial(THREE, glow));
    this.motes = pool(THREE, 420, pointsMaterial(THREE, glowTexture(THREE, 64, .05)));
    this.group.add(this.sparks.points, this.motes.points);
    // 3D の衝撃波（打撃方向に垂直な輪）と床の輪。メッシュを使い回す
    this.rings = [];
    const ringMat = () => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 18; i++) {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 64, 1), ringMat());
      m.visible = false; this.group.add(m); this.rings.push(m);
    }
    // 打撃点の光（体の該当部分だけを照らす。人物を白く塗りつぶさない強さ）
    this.flash = new THREE.PointLight(0xffc860, 0, 2.2, 2); this.group.add(this.flash);
    // 軌跡（手足の残像の帯）
    this.trailN = 24;
    this.trails = {};
    for (const k of LIMBS) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.trailN * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(this.trailN * 2), 1).setUsage(THREE.DynamicDrawUsage));
      const idx = [];
      for (let i = 0; i < this.trailN - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      geo.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(k.startsWith('wrist') ? 0x7fd8ff : 0xffb35c) } },
        vertexShader: 'attribute float alpha; varying float vA; void main(){ vA=alpha; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
        fragmentShader: 'uniform vec3 color; varying float vA; void main(){ gl_FragColor=vec4(color*1.6, vA); }',
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; this.group.add(mesh);
      this.trails[k] = { mesh, hist: [], foot: k.startsWith('foot') };
    }
    this.events = [];
    this.floorY = -0.145;
    this.bones = {};
    this._v = new THREE.Vector3(); this._q = new THREE.Vector3();
    this.stats = { events: 0, sparks: 0 };
  }

  setBones(bones) { this.bones = bones || {}; this.reset(); }
  reset() { this.events.length = 0; for (const k in this.trails) this.trails[k].hist.length = 0; }

  limbPos(k, out) { const b = this.bones[k]; if (!b) return null; return b.getWorldPosition(out); }

  // 判定時: 直近で最も速く動いている手足を「打撃した部位」とみなし、その位置と向きを記録する
  hit({ t, grade, seed = 0 }) {
    if (grade === 'MISS') return;
    let best = null;
    for (const k of LIMBS) {
      const h = this.trails[k].hist;
      if (h.length < 2) continue;
      const a = h[h.length - 1], b = h[Math.max(0, h.length - 4)];
      const dt = Math.max(1e-3, a.t - b.t);
      // 体全体の移動・向き変えではなく、腰に対する手足の速さで「打った部位」を選ぶ
      const v = [0, 1, 2].map((i) => ((a.p[i] - a.c[i]) - (b.p[i] - b.c[i])) / dt);
      const sp = Math.hypot(...v);
      // 足は蹴り・膝上げ（床から上がっているとき）だけ対象。踏み替え・向き変えの足では出さない
      const raised = a.p[1] - this.floorY > 0.22;
      const w = k.startsWith('wrist') ? 1 : raised ? 0.8 : 0;
      if (!best || sp * w > best.sp) best = { k, sp: sp * w, v, p: a.p };
    }
    if (!best) {
      const p = this.limbPos('wrist.R', this._v);
      best = { k: 'wrist.R', sp: 0, v: [0, 0, 1], p: p ? [p.x, p.y, p.z] : [0, 1.2, 0] };
    }
    const n = Math.hypot(...best.v) || 1;
    // 動きが小さいときは体の中心から手足へ向かう水平方向（カメラ正面に輪を出して人物を覆わない）
    let dir = best.v.map((x) => x / n);
    if (best.sp <= 0.3) {
      const c = this.center || [0, best.p[1], 0];
      const hx = best.p[0] - c[0], hz = best.p[2] - c[2], m = Math.hypot(hx, hz) || 1;
      dir = [hx / m, 0, hz / m];
    }
    this.events.push({ t, grade, limb: best.k, origin: best.p.slice(), dir, seed: (seed * 2654435761) >>> 0 });
    if (this.events.length > 24) this.events.shift();
  }

  update(t) {
    const THREE = this.THREE;
    // 軌跡: 時刻が戻ったら履歴を捨てる（巻き戻し・再スタート）
    for (const k of LIMBS) {
      const tr = this.trails[k];
      const p = this.limbPos(k, this._v);
      if (!p) { tr.mesh.visible = false; continue; }
      if (tr.hist.length && t < tr.hist[tr.hist.length - 1].t - 1e-4) tr.hist.length = 0;
      if (!tr.hist.length || t - tr.hist[tr.hist.length - 1].t > 1 / 120) tr.hist.push({ t, p: [p.x, p.y, p.z], c: (this.center || [0, 0, 0]).slice() });
      while (tr.hist.length > this.trailN || (tr.hist.length && t - tr.hist[0].t > 0.22)) tr.hist.shift();
      this.drawTrail(tr, t);
    }
    // 粒子・衝撃波
    this.sparks.reset();
    for (const r of this.rings) r.visible = false;
    let ri = 0, flash = 0, flashAt = null;
    this.events = this.events.filter((e) => t - e.t < LIFE && t >= e.t - 0.02);
    for (const e of this.events) {
      const age = Math.max(0, t - e.t), life = 1 - age / LIFE;
      const perfect = e.grade === 'PERFECT';
      const col = perfect ? [1.0, 0.78, 0.32] : [0.36, 0.78, 1.0];
      const [ox, oy, oz] = e.origin, [dx, dy, dz] = e.dir;
      const rnd = rand(e.seed + 1);
      // 方向性のある火花（打撃方向に円錐状に飛ぶ。重力で少し落ちる）
      for (let i = 0; i < SPARKS * this.quality; i++) {
        const spread = 0.55, sp = 2.2 + rnd() * 3.2;
        const rx = dx + (rnd() - .5) * spread * 2, ry = dy + (rnd() - .5) * spread * 2 + 0.15, rz = dz + (rnd() - .5) * spread * 2;
        const m = Math.hypot(rx, ry, rz) || 1;
        const drag = (1 - Math.exp(-3.2 * age)) / 3.2;
        const x = ox + rx / m * sp * drag, y = oy + ry / m * sp * drag - 1.6 * age * age, z = oz + rz / m * sp * drag;
        const a = life * life * (0.55 + rnd() * 0.45) * (perfect ? 1 : 0.75);
        this.sparks.push(x, y, z, col[0], col[1], col[2], 0.035 + rnd() * 0.03, a);
        // 残光（同じ火花の少し前の位置）
        const d2 = (1 - Math.exp(-3.2 * Math.max(0, age - 0.035))) / 3.2;
        this.sparks.push(ox + rx / m * sp * d2, oy + ry / m * sp * d2, oz + rz / m * sp * d2, col[0], col[1], col[2], 0.025, a * 0.5);
      }
      // 打撃点のエネルギー核（短く強く）
      const core = Math.max(0, 1 - age / 0.18);
      this.sparks.push(ox, oy, oz, col[0], col[1], col[2], 0.12 * (0.6 + 0.4 * core), core * 0.7);
      // 打撃方向に垂直な衝撃波（2 重）
      for (let j = 0; j < 2 && ri < this.rings.length; j++) {
        const aj = Math.max(0, age - j * 0.07);
        const r = this.rings[ri++];
        const s = 0.04 + aj * (perfect ? 0.75 : 0.55);
        r.visible = aj > 0;
        r.position.set(ox + dx * aj * 0.6, oy + dy * aj * 0.6, oz + dz * aj * 0.6);
        r.lookAt(r.position.x + dx, r.position.y + dy, r.position.z + dz);
        r.scale.setScalar(s);
        r.material.color.setRGB(col[0], col[1], col[2]);
        r.material.opacity = Math.max(0, 1 - aj / LIFE) ** 1.6 * (perfect ? 0.85 : 0.6);
      }
      // 床の輪（足元の踏み込み）
      if (ri < this.rings.length) {
        const r = this.rings[ri++];
        r.visible = true;
        r.position.set(ox, 0.012 - 0.145, oz); r.rotation.set(-Math.PI / 2, 0, 0);
        r.scale.setScalar(0.12 + age * 1.1);
        r.material.color.setRGB(col[0], col[1], col[2]);
        r.material.opacity = life * life * 0.32;
      }
      if (core > flash) { flash = core; flashAt = e; }
    }
    if (flashAt) {
      this.flash.position.set(...flashAt.origin);
      this.flash.color.setRGB(...(flashAt.grade === 'PERFECT' ? [1, .8, .45] : [.5, .8, 1]));
    }
    this.flash.intensity = flash * 3;
    this.sparks.flush();
    // 奥行きの浮遊光（時刻の関数。ステージは動かさない）
    this.motes.reset();
    const mr = rand(7);
    for (let i = 0; i < 260 * this.quality; i++) {
      const bx = (mr() - .5) * 14, by = mr() * 5.5, bz = -2 - mr() * 12, ph = mr() * 6.28, sp = .15 + mr() * .25;
      const tw = .45 + .55 * Math.sin(t * (0.6 + mr()) + ph);
      this.motes.push(bx + Math.sin(t * sp + ph) * .4, by + Math.sin(t * sp * .7 + ph * 2) * .25, bz, .45, .75, 1, .05 + mr() * .07, .16 * tw * (1 - Math.min(1, -bz / 16)));
    }
    this.motes.flush();
    this.stats = { events: this.events.length, sparks: this.sparks.used };
  }

  drawTrail(tr, t) {
    const h = tr.hist, n = this.trailN;
    const pos = tr.mesh.geometry.attributes.position, al = tr.mesh.geometry.attributes.alpha;
    // 速さに応じた濃さ（止まっている手足には残像を出さない）。直近の判定があれば少し強める
    let speed = 0;
    if (h.length >= 2) {
      const a = h[h.length - 1], b = h[0];
      speed = Math.hypot(...[0, 1, 2].map((i) => (a.p[i] - a.c[i]) - (b.p[i] - b.c[i]))) / Math.max(1e-3, a.t - b.t);
    }
    const boost = this.events.some((e) => t - e.t < 0.3 && t >= e.t) ? 1.4 : 1;
    const last = h[h.length - 1];
    const footDown = tr.foot && last && last.p[1] - this.floorY < 0.18;
    const strength = footDown ? 0 : Math.min(1, Math.max(0, (speed - 0.9) / 2.5)) * boost;
    tr.mesh.visible = strength > 0.01 && h.length > 2;
    if (!tr.mesh.visible) return;
    const cam = this.camera;
    for (let i = 0; i < n; i++) {
      const s = h[Math.max(0, Math.min(h.length - 1, h.length - n + i))];
      const prev = h[Math.max(0, Math.min(h.length - 1, h.length - n + i - 1))];
      // 帯の幅方向: 進行方向とカメラ方向の外積
      let tx = s.p[0] - prev.p[0], ty = s.p[1] - prev.p[1], tz = s.p[2] - prev.p[2];
      const vx = cam ? cam.position.x - s.p[0] : 0, vy = cam ? cam.position.y - s.p[1] : 0, vz = cam ? cam.position.z - s.p[2] : 1;
      let wx = ty * vz - tz * vy, wy = tz * vx - tx * vz, wz = tx * vy - ty * vx;
      const m = Math.hypot(wx, wy, wz) || 1;
      const u = i / (n - 1), w = 0.045 * u;
      wx = wx / m * w; wy = wy / m * w; wz = wz / m * w;
      pos.setXYZ(i * 2, s.p[0] + wx, s.p[1] + wy, s.p[2] + wz);
      pos.setXYZ(i * 2 + 1, s.p[0] - wx, s.p[1] - wy, s.p[2] - wz);
      const a = u * u * 0.55 * strength;
      al.setX(i * 2, a); al.setX(i * 2 + 1, a);
    }
    pos.needsUpdate = true; al.needsUpdate = true;
  }
}
