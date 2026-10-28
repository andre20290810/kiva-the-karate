// POV / 正解動作ガイド: 33 点の関節から動かす人体モデル（Three.js の SkinnedMesh + Skeleton）。
// 外部のモデルファイルは使わず、形はここで生成する（上腕・前腕は連続したテーパー、手のひら・5 本の指、足、白い道着の袖・ズボン、黒帯）。
// 骨は平らな階層（すべて root の子）にして、各コマで関節の点から骨のワールド行列を直接決める（向きの基準は boneFrames()）。
// 骨の長さは読み込んだデータの中央値。コマごとの骨の長さの揺れは「メッシュの骨端と関節点のずれ」として測る（retargetError）。
import * as THREE from './vendor/three.module.min.js';
import { P3, v3, UP } from './pose.js';

const { sub, add, mul, dot, cross, len, norm, lerp, mid } = v3;
const FINGERS = [ // 名前・付け根の位置（手の座標: x は親指側が +、y は手首→指の付け根）・節の長さ・太さ
  { n: 'index', x: 0.028, y: 1.0, l: [0.042, 0.026, 0.021], r: 0.0095 },
  { n: 'middle', x: 0.009, y: 1.04, l: [0.046, 0.029, 0.022], r: 0.0098 },
  { n: 'ring', x: -0.01, y: 1.0, l: [0.042, 0.027, 0.021], r: 0.0092 },
  { n: 'pinky', x: -0.028, y: 0.92, l: [0.034, 0.021, 0.019], r: 0.0082 },
];
const THUMB = { n: 'thumb', l: [0.036, 0.03, 0.026], r: 0.011 };
const SEG_BONES = ['pelvis', 'chest', 'neck', 'head', 'upperarmL', 'forearmL', 'handL', 'upperarmR', 'forearmR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];

/** 正規直交の基底（Y を dir に、Z を zRef に近く）→ { o, x, y, z } */
function frame(o, dir, zRef, fallback) {
  const y = norm(dir);
  let z = sub(zRef, mul(y, dot(zRef, y)));
  if (len(z) < 0.15 && fallback) { const f = sub(fallback, mul(y, dot(fallback, y))); z = len(f) > 1e-6 ? f : z; }
  if (len(z) < 1e-6) z = Math.abs(y[1]) < 0.9 ? sub(UP, mul(y, y[1])) : [0, 0, 1];
  z = norm(z);
  const x = cross(y, z);
  return { o, x, y, z: cross(x, y) };
}
const mat = (f) => new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.z)).setPosition(...f.o);

/** 曲げの向き（child がどちらへ曲がるか。まっすぐなら 0 に近い重み） */
function bend(a, b, c) {
  const u = norm(sub(b, a)), w = norm(sub(c, b));
  const perp = sub(w, mul(u, dot(w, u)));
  return { dir: norm(perp), amount: Math.min(1, len(perp) / 0.35) };
}
const blendRef = (b, fb) => norm(add(mul(b.dir, b.amount), mul(fb, 1 - b.amount)));

/** 33 点（g(j) → [x,y,z]）から各骨の基底を求める（安静時の形にも、各コマにも同じ規則を使う） */
export function boneFrames(g) {
  const F = {};
  const hipM = mid(g(23), g(24)), shM = mid(g(11), g(12));
  const leftH = sub(g(23), g(24)), leftS = sub(g(11), g(12));
  const spine = sub(shM, hipM);
  const fwdP = norm(cross(norm(leftH), norm(spine))), fwdC = norm(cross(norm(leftS), norm(spine)));
  F.pelvis = frame(hipM, spine, fwdP);
  F.chest = frame(lerp(hipM, shM, 0.55), spine, fwdC);
  const earM = mid(g(7), g(8));
  const xh = norm(sub(g(7), g(8)));
  const nv = sub(g(0), earM);
  const zh = norm(sub(nv, mul(xh, dot(nv, xh))));
  const yh = cross(zh, xh);
  F.neck = frame(shM, sub(earM, shM), zh, fwdC);
  F.head = { o: earM, x: xh, y: yh, z: zh };
  for (const [s, sign, sh, el, wr, pk, ix] of [['L', 1, 11, 13, 15, 17, 19], ['R', -1, 12, 14, 16, 18, 20]]) {
    const dorsal = norm(mul(cross(sub(g(ix), g(wr)), sub(g(pk), g(wr))), sign)); // 手の甲の向き
    F['upperarm' + s] = frame(g(sh), sub(g(el), g(sh)), blendRef(bend(g(sh), g(el), g(wr)), fwdC), UP);
    F['forearm' + s] = frame(g(el), sub(g(wr), g(el)), dorsal, F['upperarm' + s].z);
    F['hand' + s] = frame(g(wr), sub(mid(g(ix), g(pk)), g(wr)), dorsal, F['forearm' + s].z);
  }
  for (const [s, hp, kn, an, he, ft] of [['L', 23, 25, 27, 29, 31], ['R', 24, 26, 28, 30, 32]]) {
    const b = bend(g(hp), g(kn), g(an));
    F['thigh' + s] = frame(g(hp), sub(g(kn), g(hp)), norm(add(mul(b.dir, -b.amount), mul(fwdP, 1 - b.amount))), fwdP);
    F['shin' + s] = frame(g(kn), sub(g(an), g(kn)), sub(g(ft), g(he)), fwdP);
    F['foot' + s] = frame(g(an), sub(g(ft), g(an)), sub(g(kn), g(an)), UP);
  }
  return F;
}

/** 安静時の 33 点（正面 +Z、腕は下ろして肘をわずかに曲げる）。長さはデータの中央値 */
export function restPoints(L) {
  const p = [];
  const hipY = (L.thighL + L.shinL + L.thighR + L.shinR) / 2 + 0.08;
  const hw = L.hipW / 2, sw = L.shoulderW / 2, shY = hipY + L.torso;
  p[23] = [hw, hipY, 0]; p[24] = [-hw, hipY, 0];
  p[11] = [sw, shY, 0]; p[12] = [-sw, shY, 0];
  const earY = shY + L.neck;
  const face = { 0: [0, -0.02, 0.1], 1: [0.015, 0.012, 0.085], 2: [0.032, 0.012, 0.08], 3: [0.048, 0.012, 0.07], 4: [-0.015, 0.012, 0.085], 5: [-0.032, 0.012, 0.08], 6: [-0.048, 0.012, 0.07], 7: [0.075, 0, 0], 8: [-0.075, 0, 0], 9: [0.025, -0.05, 0.085], 10: [-0.025, -0.05, 0.085] };
  for (const [j, o] of Object.entries(face)) p[j] = [o[0], earY + o[1], o[2]];
  for (const [s, sign, sh, el, wr, pk, ix, th] of [['L', 1, 11, 13, 15, 17, 19, 21], ['R', -1, 12, 14, 16, 18, 20, 22]]) {
    const ua = norm([sign * 0.12, -1, 0.0]), fa = norm([sign * 0.05, -1, 0.35]);
    p[el] = add(p[sh], mul(ua, L['upperarm' + s]));
    p[wr] = add(p[el], mul(fa, L['forearm' + s]));
    const hl = L['hand' + s];
    // 手のひらは体側を向く（親指が前）
    p[ix] = add(p[wr], add(mul(fa, hl), [0, 0, 0.03]));
    p[pk] = add(p[wr], add(mul(fa, hl * 0.95), [0, 0, -0.03]));
    p[th] = add(p[wr], add(mul(fa, hl * 0.5), [0, 0, 0.045]));
  }
  for (const [s, sign, hp, kn, an, he, ft] of [['L', 1, 23, 25, 27, 29, 31], ['R', -1, 24, 26, 28, 30, 32]]) {
    p[kn] = add(p[hp], mul(norm([sign * 0.02, -1, 0.06]), L['thigh' + s]));
    p[an] = add(p[kn], mul(norm([0, -1, -0.06]), L['shin' + s]));
    p[he] = add(p[an], [0, -0.05, -0.05]);
    p[ft] = add(p[an], mul(norm([sign * 0.25, -0.4, 1]), L['foot' + s]));
  }
  return p;
}

/** 指の骨の基底（手の基底と指の曲げ 0〜1 から） */
function fingerFrames(hand, sign, curl, scale) {
  const out = {};
  const H = mat(hand);
  const hl = scale;
  const place = (name, base, dir0, angles, lens, across = 0) => {
    let m = H.clone().multiply(new THREE.Matrix4().makeTranslation(base[0], base[1], base[2]));
    // 指の基本の向き（手の y 軸から少し開く）
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...norm(dir0)));
    m.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q));
    for (let i = 0; i < 3; i++) {
      m.multiply(new THREE.Matrix4().makeRotationX(-angles[i] * curl)); // 手のひら側（-Z）へ曲げる
      if (across) m.multiply(new THREE.Matrix4().makeRotationZ(sign * across * curl)); // 親指は人差し指・中指の前へ回り込む
      out[`${name}${i}`] = m.clone();
      m.multiply(new THREE.Matrix4().makeTranslation(0, lens[i], 0));
    }
  };
  for (const f of FINGERS) place(f.n, [sign * f.x, f.y * hl * 0.93, -0.003], [sign * f.x * 0.6, 1, 0], [1.5, 1.7, 1.15], f.l);
  place(THUMB.n, [sign * 0.03, hl * 0.3, -0.014], [sign * 0.6, 0.75, -0.45], [0.35, 0.35, 0.45], THUMB.l, 0.55);
  return out;
}

// ---------------------------------------------------------------------
// 形の生成（骨の座標で作り、安静時の行列で世界座標に置く）
// ---------------------------------------------------------------------
class Builder {
  constructor(boneIndex) { this.bi = boneIndex; this.parts = new Map(); }
  part(key) { let p = this.parts.get(key); if (!p) { p = { pos: [], idx: [], si: [], sw: [] }; this.parts.set(key, p); } return p; }
  /**
   * 骨に沿った管（楕円の断面・端は丸める）。profile(s 0〜1) → [rx, rz, cx?, cz?]。
   * weights(s) → [[骨名, 重み]…]（関節の近くで隣の骨と混ぜ、肘・膝を連続させる）
   */
  tube(key, restM, { len: L, profile, weights, radial = 14, rings = 10, cap0 = true, cap1 = true, y0 = 0 }) {
    const P = this.part(key);
    const base = P.pos.length / 3;
    const ringList = [];
    const capN = 4;
    const pr0 = profile(0), pr1 = profile(1);
    if (cap0) for (let i = 0; i < capN; i++) { const ph = (Math.PI / 2) * (i / capN); ringList.push({ s: 0, y: y0 - Math.min(pr0[0], pr0[1]) * Math.cos(ph), k: Math.max(0.05, Math.sin(ph)) }); }
    for (let i = 0; i <= rings; i++) ringList.push({ s: i / rings, y: y0 + (L * i) / rings, k: 1 });
    if (cap1) for (let i = capN - 1; i >= 0; i--) { const ph = (Math.PI / 2) * (i / capN); ringList.push({ s: 1, y: y0 + L + Math.min(pr1[0], pr1[1]) * Math.cos(ph), k: Math.max(0.05, Math.sin(ph)) }); }
    const v = new THREE.Vector3();
    for (const r of ringList) {
      const [rx, rz, cx = 0, cz = 0] = profile(r.s);
      const w = weights(r.s).slice(0, 4);
      while (w.length < 4) w.push([w[0][0], 0]);
      for (let a = 0; a < radial; a++) {
        const th = (a / radial) * Math.PI * 2;
        v.set(cx + rx * r.k * Math.cos(th), r.y, cz + rz * r.k * Math.sin(th)).applyMatrix4(restM);
        P.pos.push(v.x, v.y, v.z);
        for (const [b, wt] of w) { P.si.push(this.bi[b]); P.sw.push(wt); }
      }
    }
    for (let i = 0; i < ringList.length - 1; i++) for (let a = 0; a < radial; a++) {
      const a1 = (a + 1) % radial, r0 = base + i * radial, r1 = base + (i + 1) * radial;
      P.idx.push(r0 + a, r1 + a, r0 + a1, r0 + a1, r1 + a, r1 + a1);
    }
  }
}
const W1 = (b) => () => [[b, 1]];
/** 端の近くで隣の骨と混ぜる重み（start: 親、end: 子。f は混ぜる範囲の割合） */
const blendW = (b, start, end, f = 0.22) => (s) => {
  const w = new Map([[b, 1]]);
  if (start && s < f) { const k = 0.5 * (1 - s / f); w.set(b, w.get(b) - k); w.set(start, k); }
  if (end && s > 1 - f) { const k = 0.5 * ((s - (1 - f)) / f); w.set(b, w.get(b) - k); w.set(end, (w.get(end) || 0) + k); }
  return [...w.entries()];
};
const taper = (r0, r1, bulge = 0, z = 1) => (s) => { const r = r0 + (r1 - r0) * s + bulge * Math.sin(Math.PI * s); return [r, r * z]; };

const MATS = {
  skin: () => new THREE.MeshStandardMaterial({ color: 0xd8a27c, roughness: 0.62, metalness: 0 }),
  gi: () => new THREE.MeshStandardMaterial({ color: 0xf3f1ea, roughness: 0.85, metalness: 0 }),
  belt: () => new THREE.MeshStandardMaterial({ color: 0x17130f, roughness: 0.7 }),
  hair: () => new THREE.MeshStandardMaterial({ color: 0x1e1712, roughness: 0.8 }),
};

/**
 * 人体モデルを作る。L はデータの骨の長さの中央値（segmentLengths）。
 * 戻り値: { root, update(frame or pointGetter, opts) → { errors }, setVisible(part, bool), setOpacity(x), dispose() }
 */
export function createRig(L, { curl = 0.9 } = {}) {
  const names = [...SEG_BONES];
  for (const s of ['L', 'R']) for (const f of [...FINGERS.map((x) => x.n), THUMB.n]) for (let i = 0; i < 3; i++) names.push(`${s}_${f}${i}`);
  const bi = Object.fromEntries(names.map((n, i) => [n, i]));
  const rp = restPoints(L);
  const rg = (j) => rp[j];
  const RF = boneFrames(rg);
  const restM = {};
  for (const n of SEG_BONES) restM[n] = mat(RF[n]);
  for (const [s, sign] of [['L', 1], ['R', -1]]) { const ff = fingerFrames(RF['hand' + s], sign, curl, L['hand' + s]); for (const [k, m] of Object.entries(ff)) restM[`${s}_${k}`] = m; }
  // メッシュの長さ（骨の向きの先にある関節までの距離）
  const segLen = {
    pelvis: len(sub(RF.chest.o, RF.pelvis.o)), chest: L.torso * 0.45, neck: len(sub(RF.head.o, RF.neck.o)),
    upperarmL: L.upperarmL, forearmL: L.forearmL, handL: L.handL, upperarmR: L.upperarmR, forearmR: L.forearmR, handR: L.handR,
    thighL: L.thighL, shinL: L.shinL, footL: L.footL, thighR: L.thighR, shinR: L.shinR, footR: L.footR,
  };
  const B = new Builder(bi);
  const sw = L.shoulderW / 2, hw = L.hipW / 2;
  // 胴体（道着）・帯
  B.tube('torso:gi', restM.pelvis, { len: segLen.pelvis + 0.11, profile: (s) => [hw + 0.06 - 0.005 * s, 0.108], weights: blendW('pelvis', null, 'chest', 0.4), cap0: true, cap1: false, y0: -0.07 });
  B.tube('torso:gi', restM.chest, { len: segLen.chest + 0.06, profile: (s) => [hw + 0.055 + (sw - hw - 0.03) * s, 0.108 + 0.01 * Math.sin(Math.PI * s)], weights: blendW('chest', 'pelvis', null, 0.35), cap0: false, cap1: true, y0: -0.04 });
  B.tube('torso:belt', restM.pelvis, { len: 0.045, profile: () => [hw + 0.062, 0.112], weights: W1('pelvis'), cap0: false, cap1: false, y0: 0.0, rings: 1 });
  // 首・頭（頭は一人称では描かない）
  B.tube('head:skin', restM.neck, { len: segLen.neck * 0.75, profile: () => [0.05, 0.05], weights: blendW('neck', 'chest', 'head', 0.3), cap0: false, cap1: false });
  B.tube('head:skin', restM.head, { len: 0.08, profile: (s) => [0.075, 0.09, 0, 0.015], weights: W1('head'), y0: -0.05, rings: 6 });
  B.tube('head:hair', restM.head, { len: 0.06, profile: () => [0.079, 0.094, 0, 0.005], weights: W1('head'), y0: 0.0, cap0: false, rings: 4 });
  for (const [s, sign] of [['L', 1], ['R', -1]]) {
    const ua = 'upperarm' + s, fa = 'forearm' + s, hd = 'hand' + s;
    // 袖（上腕〜前腕の 6 割、袖口は開く）
    B.tube('arms:gi', restM[ua], { len: segLen[ua], profile: taper(0.062, 0.052, 0.006), weights: blendW(ua, 'chest', fa, 0.25), cap0: true, cap1: true, y0: -0.02 });
    B.tube('arms:gi', restM[fa], { len: segLen[fa] * 0.6 + 0.02, profile: taper(0.052, 0.05), weights: blendW(fa, ua, null, 0.3), cap0: false, cap1: false, y0: -0.02 });
    // 前腕の肌（手首へ細くなる。袖の中から続く）
    B.tube('arms:skin', restM[fa], { len: segLen[fa], profile: (x) => { const r = 0.036 - 0.011 * x + 0.004 * Math.sin(Math.PI * x * 0.8); return [r, r * 0.82]; }, weights: blendW(fa, ua, hd, 0.2), cap0: false, cap1: false, y0: segLen[fa] * 0.2 - segLen[fa] * 0.2 });
    // 手のひら（手の甲側 +Z、平たい）
    B.tube('arms:skin', restM[hd], { len: segLen[hd] * 0.95, profile: (x) => [0.03 + 0.012 * Math.min(1, x * 2), 0.016 - 0.003 * x, sign * 0.002, 0.002], weights: blendW(hd, fa, null, 0.35), cap0: true, cap1: true, y0: 0.0 });
    // 指（3 節）と親指
    for (const f of [...FINGERS, THUMB]) for (let i = 0; i < 3; i++) {
      const b = `${s}_${f.n}${i}`;
      const r = f.r * 1.12 * (1 - i * 0.1);
      B.tube('arms:skin', restM[b], { len: f.l[i], profile: () => [r, r * 0.88], weights: W1(b), radial: 8, rings: 2 });
    }
  }
  for (const [s] of [['L'], ['R']]) {
    const th = 'thigh' + s, sh = 'shin' + s, ft = 'foot' + s;
    B.tube('legs:gi', restM[th], { len: segLen[th] + 0.01, profile: taper(0.088, 0.068, 0.006), weights: blendW(th, 'pelvis', sh, 0.25), cap0: true, cap1: true, y0: -0.03 });
    B.tube('legs:gi', restM[sh], { len: segLen[sh] * 0.82 + 0.03, profile: taper(0.068, 0.062), weights: blendW(sh, th, null, 0.3), cap0: false, cap1: false, y0: -0.03 });
    B.tube('legs:skin', restM[sh], { len: segLen[sh], profile: taper(0.045, 0.034), weights: blendW(sh, th, ft, 0.15), cap0: false, cap1: true, y0: 0 });
    // 足（つま先方向が骨の y、上が z）
    B.tube('legs:skin', restM[ft], { len: segLen[ft] * 0.95, profile: (x) => [0.035 + 0.012 * x, 0.032 - 0.014 * x, 0, -0.028 - 0.01 * x], weights: blendW(ft, sh, null, 0.25), y0: -0.02 });
  }

  // three の骨・Skeleton
  const root = new THREE.Group();
  root.name = 'kiva-pov-body';
  const bones = names.map((n) => { const b = new THREE.Bone(); b.name = n; b.matrixAutoUpdate = false; b.matrix.copy(restM[n]); root.add(b); return b; });
  const inverses = names.map((n) => restM[n].clone().invert());
  const skeleton = new THREE.Skeleton(bones, inverses);
  const meshes = { torso: [], head: [], arms: [], legs: [] };
  const materials = [];
  for (const [key, P] of B.parts) {
    const [part, m] = key.split(':');
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P.pos, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(P.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(P.sw, 4));
    g.setIndex(P.idx);
    g.computeVertexNormals();
    const material = MATS[m]();
    materials.push(material);
    const mesh = new THREE.SkinnedMesh(g, material);
    mesh.frustumCulled = false;
    mesh.bind(skeleton, new THREE.Matrix4());
    mesh.name = key;
    root.add(mesh);
    meshes[part].push(mesh);
  }

  const chains = [ // メッシュの骨端と関節点のずれ（骨の長さの揺れ・推定の不安定さ）
    ['upperarmL', 13, '左上腕'], ['forearmL', 15, '左前腕'], ['upperarmR', 14, '右上腕'], ['forearmR', 16, '右前腕'],
    ['thighL', 25, '左もも'], ['shinL', 27, '左すね'], ['thighR', 26, '右もも'], ['shinR', 28, '右すね'],
  ];
  let curlNow = curl;
  return {
    root, skeleton, meshes, segLen, restPoints: rp,
    /** p: Float32Array(99) の関節点（Y が上・m）→ 骨を動かす。戻り値 { errors:[{name, mm}], meanMm, maxMm, worst } */
    update(p) {
      const g = (j) => P3({ p }, j);
      const F = boneFrames(g);
      for (const n of SEG_BONES) bones[bi[n]].matrix.copy(mat(F[n]));
      for (const [s, sign] of [['L', 1], ['R', -1]]) {
        const ff = fingerFrames(F['hand' + s], sign, curlNow, L['hand' + s]);
        for (const [k, m] of Object.entries(ff)) bones[bi[`${s}_${k}`]].matrix.copy(m);
      }
      root.updateMatrixWorld(true);
      const errors = chains.map(([b, j, name]) => {
        const f = F[b];
        const tip = add(f.o, mul(f.y, segLen[b]));
        return { name, mm: len(sub(tip, g(j))) * 1000 };
      });
      const meanMm = errors.reduce((a, e) => a + e.mm, 0) / errors.length;
      const worst = errors.reduce((a, e) => (e.mm > a.mm ? e : a), errors[0]);
      return { errors, meanMm, maxMm: worst.mm, worst: worst.name };
    },
    setCurl(c) { curlNow = c; },
    setVisible(part, on) { for (const m of meshes[part]) m.visible = on; },
    setOpacity(x) { for (const m of materials) { m.opacity = x; m.transparent = x < 0.999; m.depthWrite = x > 0.6; m.needsUpdate = true; } },
    dispose() { for (const ms of Object.values(meshes)) for (const m of ms) { m.geometry.dispose(); } materials.forEach((m) => m.dispose()); skeleton.dispose(); },
  };
}

/** 骨格の表示（関節と骨の線。信頼度不足・補間・範囲外は色で示す。体の陰にあっても見えるよう深度を無視） */
export function createSkeletonView(BONES) {
  const group = new THREE.Group();
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(BONES.length * 6), 3));
  lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(BONES.length * 6), 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
  lines.renderOrder = 10; lines.frustumCulled = false;
  const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.014, 10, 8), new THREE.MeshBasicMaterial({ depthTest: false, transparent: true }), 33);
  dots.renderOrder = 11; dots.frustumCulled = false;
  group.add(lines, dots);
  const c = new THREE.Color(), m = new THREE.Matrix4();
  const OK = new THREE.Color(0x35e0ff), WARN = new THREE.Color(0xffa31a), BAD = new THREE.Color(0xff3b30);
  const colorOf = (fl, FLAG) => (fl & FLAG.OUTSIDE ? BAD : fl & (FLAG.LOWCONF | FLAG.INTERP | FLAG.DERIVED) ? WARN : OK);
  return {
    group,
    update(p, flags, FLAG, hideHead = false) {
      const pos = lineGeo.attributes.position.array, col = lineGeo.attributes.color.array;
      BONES.forEach(([a, b], i) => {
        const hidden = hideHead && (a <= 10 && b <= 10);
        for (const [k, j] of [[0, a], [1, b]]) {
          pos.set(hidden ? [0, -100, 0] : [p[j * 3], p[j * 3 + 1], p[j * 3 + 2]], i * 6 + k * 3);
          c.copy(colorOf(flags[j], FLAG)); col.set([c.r, c.g, c.b], i * 6 + k * 3);
        }
      });
      lineGeo.attributes.position.needsUpdate = true; lineGeo.attributes.color.needsUpdate = true;
      for (let j = 0; j < 33; j++) {
        const hidden = hideHead && j <= 10;
        m.makeTranslation(p[j * 3], hidden ? -100 : p[j * 3 + 1], p[j * 3 + 2]);
        dots.setMatrixAt(j, m); dots.setColorAt(j, colorOf(flags[j], FLAG));
      }
      dots.instanceMatrix.needsUpdate = true; if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
    },
  };
}

export { THREE };
