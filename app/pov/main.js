// POV / 正解動作ガイド（pov.html）。ゲーム本体（index.html・app/main.js）とは独立したページで、ゲームのロジック・譜面・保存データには触れない。
// 背景（道場の画像）と操作は先に表示し、Three.js（app/pov/vendor/）は後から読み込む（ゲームの初回表示・モバイル性能に影響させない）。
import {
  parsePoseText, processPose, analyzeFrames, poseAt, makeDemoParsed, samplesToCsv, FLAG, JOINTS, KEY_JOINTS, BONES,
  INTERVAL, FRAME_COUNT, DEMO_LABEL, P3, v3, UP, wrapDeg, yawOf,
} from './pose.js';

const { sub, add, mul, cross, norm, lerp, mid, horiz, len } = v3;
const $ = (s) => document.querySelector(s);
const DEFAULTS = { opacity: 1, scale: 1, fov: 72, pitchOffset: -12, offFwd: 0.04, offSide: 0, offUp: 0, backDist: 0.6, orbit: 35, curl: 0.9, smooth: 1, bgZoom: 1, bgY: 50, fwdSource: 'head', mirror: false, horizon: false, pip: true };
const SKEY = 'kiva-pov-adjust-v1';
const loadAdj = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch { return { ...DEFAULTS }; } };
const saveAdj = () => { try { localStorage.setItem(SKEY, JSON.stringify(S.adj)); } catch { /* 保存できなくても動く */ } };
const pad4 = (k) => String(k).padStart(4, '0');
const VIEW_NOTE = {
  eye: 'EYE / 一人称: 演者自身の目の位置から、演者の頭の向き（耳の軸と鼻）で前方を決めます。頭は描かず、足は視野に入ったときだけ描きます。',
  over: 'OVER SHOULDER / 背面確認: 頭の後ろ（距離は調整で 0.4〜0.8 m）・少し上から肩越しに見る確認用の第三者視点です（一人称ではありません）。',
  third: 'THIRD PERSON / 全身検証: 固定した位置から全身を見るデバッグ用の視点です（方位は調整で変更）。',
};

// 初期表示は DOJO / EYE / SOLID（背景・視点・表示は保存しない。カメラは利用者が選んだときだけ起動）
const S = { bg: 'dojo', view: 'eye', display: 'solid', speed: 1, t: 0, playing: false, step: false, adj: loadAdj() };
const D = { parsed: null, kind: 'demo', name: 'DEMO', res: null, an: null, cam: null, fit: null };
let R = null, THREE = null, renderer, scene, camera, rig = null, skel = null;
let camStream = null, fileUrl = null;
let lastFrameK = -1, lastDiag = 0, curInfo = null;

const msg = (text, err = false) => { const m = $('#povMsg'); m.textContent = text; m.classList.toggle('err', !!err); };

// ---------------------------------------------------------------------
// データ
// ---------------------------------------------------------------------
function opts() {
  return { mirror: !!S.adj.mirror, confThreshold: Number($('#confTh').value) || 0.5, interpolateLowConf: $('#interpLow').checked, timeOffset: Number($('#timeOffset').value) || 0 };
}
/** 解析済みデータを表示用に処理して差し替える。失敗したら今のデータを残す */
function useData(parsed, kind, name) {
  const res = processPose(parsed, opts());
  renderReport(res.report, kind, name);
  if (!res.ok) return false;
  D.parsed = parsed; D.kind = kind; D.name = name; D.res = res;
  D.an = analyzeFrames(res.frames, { conf: opts().confThreshold });
  computeCam();
  $('#seek').max = String((res.frames.length - 1) * INTERVAL);
  if (S.t > (res.frames.length - 1) * INTERVAL) S.t = 0;
  const badge = $('#demoBadge');
  if (kind === 'demo') { badge.textContent = DEMO_LABEL; badge.classList.remove('real'); }
  else { badge.textContent = `読み込んだ 3D データ: ${name}（${res.frames.length} コマ）— 推定値。正解の型との一致は未検証`; badge.classList.add('real'); }
  $('#dataState').textContent = kind === 'demo'
    ? `表示中: ${DEMO_LABEL}。実際の 3D 関節データ（412 コマ）を読み込むと置き換わります。`
    : `表示中: ${name}（${res.report.stats.samples} フレーム → ${res.frames.length} コマ）。DEMO ではありません。`;
  if (THREE) buildRig();
  drawTimelineBase();
  lastFrameK = -1;
  return true;
}
function renderReport(rep, kind, name) {
  const li = (cls, xs) => (xs.length ? `<ul>${xs.map((x) => `<li class="${cls}">${esc(x)}</li>`).join('')}</ul>` : '');
  $('#report').innerHTML = `<b>${esc(kind === 'demo' ? 'DEMO（人工的な動作）' : name)}</b>`
    + (rep.errors.length ? `<div class="e">読み込めませんでした（表示中のデータはそのまま）:</div>${li('e', rep.errors)}` : '')
    + li('w', rep.warnings) + li('i', rep.info);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 各コマのカメラの向き（前方の基準と平滑化を反映） */
function computeCam() {
  const an = D.an, n = an.length, w = Number(S.adj.smooth) || 0;
  const src = S.adj.fwdSource === 'body' ? 'bodyFwd' : 'headFwd';
  D.cam = an.map((a, k) => {
    let f = [0, 0, 0], pitch = 0, c = 0;
    for (let i = Math.max(0, k - w); i <= Math.min(n - 1, k + w); i++) { f = add(f, an[i][src]); pitch += an[i].pitch; c++; }
    return { fwd: norm(horiz(f)), pitch: S.adj.fwdSource === 'body' ? 0 : pitch / c };
  });
}

// ---------------------------------------------------------------------
// 3D（遅延読み込み）
// ---------------------------------------------------------------------
async function init3d() {
  msg('3D 表示（Three.js）を読み込み中…');
  try {
    R = await import('./rig.js');
    THREE = R.THREE;
  } catch (e) {
    msg(`3D 表示を読み込めませんでした（${e.message}）。\n背景の画像は表示しています。再読み込みしてください。`, true);
    return;
  }
  try {
    renderer = new THREE.WebGLRenderer({ canvas: $('#povGl'), alpha: true, antialias: true, preserveDrawingBuffer: true });
  } catch (e) {
    msg('この端末・ブラウザでは WebGL（3D 表示）を使えません。背景の画像だけ表示しています。', true);
    return;
  }
  renderer.setClearColor(0x000000, 0);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(S.adj.fov, 1, 0.03, 60);
  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x6b4a2e, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1.5, 4, 2.5); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffe2c4, 0.5); fill.position.set(-2, 1.5, -1.5); scene.add(fill);
  skel = R.createSkeletonView(BONES);
  scene.add(skel.group);
  buildRig();
  resize();
  msg('');
  requestAnimationFrame(loop);
}
function buildRig() {
  if (rig) { scene.remove(rig.root); rig.dispose(); }
  rig = R.createRig(D.res.lengths, { curl: Number(S.adj.curl) });
  rig.setOpacity(Number(S.adj.opacity));
  scene.add(rig.root);
  // 全コマの当てはめのずれ（骨の長さの揺れ）
  let sum = 0, max = 0, maxK = 0, maxName = '';
  D.res.frames.forEach((f, k) => { const e = rig.update(f.p); sum += e.meanMm; if (e.maxMm > max) { max = e.maxMm; maxK = k; maxName = e.worst; } });
  D.fit = { meanMm: sum / D.res.frames.length, maxMm: max, maxK, maxName };
}
function resize() {
  const st = $('#povStage'), W = st.clientWidth, H = st.clientHeight;
  layoutBg();
  if (!renderer) return;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(W, H, false);
  camera.aspect = W / Math.max(1, H);
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------
// 1 コマの描画
// ---------------------------------------------------------------------
function cameraFor(view, eye, fwd, pitchDeg, hip) {
  const a = S.adj;
  const yawDir = norm(horiz(fwd));
  const right = cross(yawDir, UP);
  const pr = ((view === 'eye' ? pitchDeg + Number(a.pitchOffset) : pitchDeg + Number(a.pitchOffset) * 0.5) * Math.PI) / 180;
  const dir = add(mul(yawDir, Math.cos(pr)), mul(UP, Math.sin(pr)));
  if (view === 'eye') {
    const pos = add(add(add(eye, mul(yawDir, Number(a.offFwd))), mul(right, Number(a.offSide))), mul(UP, Number(a.offUp)));
    return { pos, target: add(pos, dir), near: 0.03, yawDir, dir };
  }
  if (view === 'over') {
    const pos = add(add(add(eye, mul(yawDir, -Number(a.backDist))), mul(UP, 0.24 + Number(a.offUp))), mul(right, 0.22 + Number(a.offSide)));
    return { pos, target: add(eye, mul(dir, 2.5)), near: 0.05, yawDir, dir };
  }
  const az = (Number(a.orbit) * Math.PI) / 180;
  const target = [hip[0], 1.0, hip[2]];
  const pos = add(target, [Math.sin(az) * 2.8, 0.4 + Number(a.offUp), Math.cos(az) * 2.8]);
  return { pos, target, near: 0.05, yawDir, dir: norm(sub(target, pos)) };
}

let lastTs = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
  lastTs = ts;
  const end = (D.res.frames.length - 1) * INTERVAL;
  if (S.playing) { S.t += dt * S.speed; if (S.t >= end) { S.t = end; setPlaying(false); } }
  if (document.hidden) return;
  renderFrame();
}

function renderFrame() {
  if (!renderer) return;
  const frames = D.res.frames;
  const { p, k, u } = poseAt(frames, S.t, S.step);
  const k1 = Math.min(frames.length - 1, k + 1);
  const A = D.an[k], B = D.an[k1], C0 = D.cam[k], C1 = D.cam[k1];
  const eye = lerp(A.eye, B.eye, u);
  const fwd = norm(lerp(C0.fwd, C1.fwd, u));
  const pitch = C0.pitch + (C1.pitch - C0.pitch) * u;
  const hip = mid(P3({ p }, 23), P3({ p }, 24));
  const fit = rig.update(p);
  // 体の大きさ（目の位置を中心に拡大・縮小。カメラは目に置いたまま）
  const s = Number(S.adj.scale);
  rig.root.scale.setScalar(s);
  rig.root.position.set(eye[0] * (1 - s), eye[1] * (1 - s), eye[2] * (1 - s));
  skel.group.scale.setScalar(s);
  skel.group.position.copy(rig.root.position);
  const view = S.view;
  const c = S.debugCam ? { near: 0.01, yawDir: fwd, dir: fwd, ...S.debugCam(P3, p) } : cameraFor(view, eye, fwd, pitch, hip);
  camera.position.set(...c.pos);
  camera.up.set(0, 1, 0);
  camera.lookAt(...c.target);
  camera.near = c.near;
  camera.fov = Number(S.adj.fov);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  // 表示: SOLID / SKELETON / BOTH / OFF。一人称では頭を描かず、足は視野に入ったときだけ
  const solid = S.display === 'solid' || S.display === 'both';
  const bones = S.display === 'skeleton' || S.display === 'both';
  rig.root.visible = solid;
  skel.group.visible = bones;
  rig.setVisible('head', view !== 'eye');
  let feetIn = true;
  if (view === 'eye') {
    feetIn = false;
    const v = new THREE.Vector3();
    for (const j of [25, 26, 27, 28, 29, 30, 31, 32]) {
      const q = P3({ p }, j);
      v.set(eye[0] + (q[0] - eye[0]) * s, eye[1] + (q[1] - eye[1]) * s, eye[2] + (q[2] - eye[2]) * s).project(camera);
      if (Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z > -1 && v.z < 1 && j >= 27) feetIn = true;
    }
  }
  rig.setVisible('legs', feetIn);
  const fr = u < 0.5 || S.step ? frames[k] : frames[k1];
  skel.update(p, fr.flags, FLAG, view === 'eye');
  renderer.render(scene, camera);
  // 水平線の目安（視線の水平方向の無限遠）
  const hz = $('#horizon');
  if (S.adj.horizon) {
    const v = new THREE.Vector3(...add(c.pos, mul(c.yawDir, 1000))).project(camera);
    const H = $('#povStage').clientHeight;
    hz.hidden = !(v.z < 1 && Math.abs(v.y) <= 1.2);
    hz.style.top = `${((1 - v.y) / 2) * H}px`;
  } else hz.hidden = true;
  curInfo = { k, u, eye, fwd, pitch, cam: c, fit, feetIn, frame: fr, a: u < 0.5 || S.step ? A : B };
  updateUi(k);
}

function frameWarnings(info) {
  const f = info.frame, a = info.a;
  const out = [];
  if (f.outside) out.push('データの時間範囲外（端の姿勢を表示）');
  const weak = KEY_JOINTS.filter((j) => f.flags[j] & (FLAG.INTERP | FLAG.LOWCONF));
  if (weak.length) out.push(`${f.lost ? '見失い' : '信頼度不足・補間'}: ${weak.map((j) => JOINTS[j]).join('、')}`);
  out.push(...a.issues);
  return out;
}
function updateUi(k) {
  $('#seek').value = String(S.t);
  $('#timeLab').textContent = `${S.t.toFixed(2)} s・コマ ${pad4(k)}`;
  const info = curInfo;
  const warns = frameWarnings(info);
  const wb = $('#warnBadge');
  wb.hidden = !warns.length;
  if (warns.length) { wb.textContent = `⚠ ${warns.join(' ／ ')}`; wb.classList.toggle('bad', info.frame.lost || info.a.flip); }
  if (k !== lastFrameK) {
    lastFrameK = k;
    if (S.adj.pip && D.res.frames.length === FRAME_COUNT) { $('#pipImg').src = `assets/seipai_v2/cut/frame_${pad4(k)}.webp`; $('#pipCap').textContent = `元映像のコマ（2D）frame_${pad4(k)}`; }
  }
  drawTimelineCursor();
  syncVideo();
  const now = performance.now();
  if ($('#diagBox').open && now - lastDiag > 200) { lastDiag = now; $('#diag').textContent = diagText(info, warns); }
}
function diagText(i, warns) {
  const a = i.a, f = D.fit;
  const p3 = (v) => v.map((x) => x.toFixed(2)).join(', ');
  return [
    `データ: ${D.kind === 'demo' ? DEMO_LABEL : D.name}`,
    `コマ ${pad4(i.k)} / ${D.res.frames.length}  t=${S.t.toFixed(2)} s${S.step ? '（0.2 秒のコマのまま）' : `（コマの間を線形補間 u=${i.u.toFixed(2)}）`}`,
    `頭のヨー ${a.headYaw.toFixed(1)}°  胴体のヨー ${a.bodyYaw.toFixed(1)}°  差 ${a.headBodyDeg.toFixed(1)}°  前コマからの変化 ${a.jump.toFixed(1)}°`,
    `頭のピッチ ${a.pitch.toFixed(1)}°（耳→鼻の角度 ${a.pitchRaw.toFixed(1)}°、全コマの中央値 ${D.an.pitchBase.toFixed(1)}° を水平とみなす）  視線補正 ${S.adj.pitchOffset}°`,
    `頭の点の信頼度（鼻・耳の最小） ${a.headConf.toFixed(2)}  反転の疑い ${a.flip ? 'あり' : 'なし'}`,
    `前方の基準: ${S.adj.fwdSource === 'body' ? '胴体（肩・腰の左右軸）' : '頭（耳の左右軸＋耳→鼻）'}・平滑化 ±${S.adj.smooth} コマ`,
    `カメラ: ${S.view.toUpperCase()} 位置 (${p3(i.cam.pos)}) m  ヨー ${yawOf(i.fwd).toFixed(1)}°  near ${i.cam.near} m  FOV ${S.adj.fov}°  足の表示 ${i.feetIn ? 'あり' : 'なし（視野外）'}`,
    `骨の当てはめ（メッシュの骨端と関節点のずれ）: このコマ 平均 ${i.fit.meanMm.toFixed(1)} mm・最大 ${i.fit.maxMm.toFixed(1)} mm（${i.fit.worst}）`,
    `  全コマ: 平均 ${f.meanMm.toFixed(1)} mm・最大 ${f.maxMm.toFixed(1)} mm（コマ ${pad4(f.maxK)}・${f.maxName}）※骨の長さは全コマの中央値で固定`,
    `警告: ${warns.length ? warns.join(' ／ ') : 'なし'}`,
    '指の曲げ・手首より先の細部は MediaPipe Pose では測れないため固定形状です（実測ではありません）。',
    '背景は固定の 2D 画像です。頭の動きに合わせた視差・実空間への固定はありません（AR ではありません）。',
  ].join('\n');
}

// ---------------------------------------------------------------------
// 時間グラフ（頭・胴体のヨー、警告）
// ---------------------------------------------------------------------
let tlBase = null;
function drawTimelineBase() {
  if (!D.an) return;
  const cv = $('#timeline');
  const W = Math.max(200, cv.clientWidth || 300), H = 64, dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = W * dpr; cv.height = H * dpr;
  const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
  const g = off.getContext('2d');
  g.scale(dpr, dpr);
  const n = D.an.length, x = (k) => (k / Math.max(1, n - 1)) * W, y = (deg) => H / 2 - (wrapDeg(deg) / 180) * (H / 2 - 4);
  g.fillStyle = '#160f0a'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#3a2a1c'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  D.an.forEach((a, k) => {
    const f = D.res.frames[k];
    if (f.lost) { g.fillStyle = 'rgba(255,59,48,0.55)'; g.fillRect(x(k) - 1, 0, 2.5, H); }
    else if (a.issues.length || f.weak) { g.fillStyle = 'rgba(255,163,26,0.45)'; g.fillRect(x(k) - 1, H - 8, 2.5, 8); }
  });
  for (const [key, col] of [['bodyYaw', '#e8a33d'], ['headYaw', '#35e0ff']]) {
    g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath();
    D.an.forEach((a, k) => { const yy = y(a[key]); if (k && Math.abs(wrapDeg(a[key] - D.an[k - 1][key])) > 150) g.moveTo(x(k), yy); else if (k) g.lineTo(x(k), yy); else g.moveTo(x(k), yy); });
    g.stroke();
  }
  g.fillStyle = '#c8b59b'; g.font = '10px system-ui'; g.fillText('頭のヨー', 4, 11); g.fillStyle = '#e8a33d'; g.fillText('胴体のヨー', 54, 11); g.fillStyle = '#ff7a6e'; g.fillText('見失い・警告', 114, 11);
  tlBase = off;
}
function drawTimelineCursor() {
  const cv = $('#timeline'); if (!tlBase) return;
  const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(tlBase, 0, 0);
  const x = (S.t / ((D.res.frames.length - 1) * INTERVAL)) * cv.width;
  g.fillStyle = '#fff'; g.fillRect(x - 1, 0, 2, cv.height);
}

// ---------------------------------------------------------------------
// 背景: DOJO（中央クロップ）・LIVE CAMERA・VIDEO FILE
// ---------------------------------------------------------------------
function bgEl() { return S.bg === 'camera' ? $('#bgCam') : S.bg === 'file' ? $('#bgFile') : $('#bgDojo'); }
function bgRect(el) {
  const st = $('#povStage'), W = st.clientWidth, H = st.clientHeight;
  const sw = el.naturalWidth || el.videoWidth, sh = el.naturalHeight || el.videoHeight;
  if (!sw || !sh) return null;
  const k = Math.max(W / sw, H / sh) * Number(S.adj.bgZoom); // 縦横比を保って画面を覆う（はみ出しは切る）
  const w = sw * k, h = sh * k;
  return { x: (W - w) / 2, y: (H - h) * (Number(S.adj.bgY) / 100), w, h, W, H };
}
function layoutBg() {
  for (const el of [$('#bgDojo'), $('#bgCam'), $('#bgFile')]) {
    const r = bgRect(el);
    if (!r) continue;
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }
}
function showBg() {
  $('#bgDojo').hidden = S.bg !== 'dojo';
  $('#bgCam').hidden = S.bg !== 'camera';
  $('#bgFile').hidden = S.bg !== 'file';
  $('#videoBox').hidden = S.bg !== 'file' && !fileUrl;
  setPressed('bg', S.bg);
  layoutBg();
}
async function setBg(v) {
  if (v === 'camera') {
    if (!window.isSecureContext) return bgError('カメラは HTTPS のページでしか使えません。道場の画像で続けます。');
    if (!navigator.mediaDevices?.getUserMedia) return bgError('この端末・ブラウザはカメラの映像（getUserMedia）に対応していません。道場の画像で続けます。');
    msg('カメラの使用を確認しています…\n（ブラウザの確認で「許可」を選ぶと背景に映ります）');
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (e) {
      const why = {
        NotAllowedError: 'カメラの使用が許可されませんでした（ブラウザ・端末の設定でカメラを許可すると使えます）。',
        SecurityError: 'セキュリティの設定でカメラを使えません。',
        NotFoundError: 'カメラが見つかりません。',
        OverconstrainedError: '使えるカメラが見つかりません。',
        NotReadableError: 'カメラを他のアプリが使っているため起動できません。',
        AbortError: 'カメラの起動が中断されました。',
      }[e.name] || `カメラを起動できません（${e.name || e.message}）。`;
      return bgError(`${why}\n道場の画像で続けます。`);
    }
    const vid = $('#bgCam');
    vid.srcObject = camStream;
    vid.onloadedmetadata = () => layoutBg();
    try { await vid.play(); } catch { /* 自動再生の制限: 映像が出なければ画面をタップ */ }
    msg('');
  } else stopCam();
  if (v === 'file' && !fileUrl) {
    $('#videoBox').hidden = false; $('#videoBox').open = true;
    msg('「動画を選ぶ」で撮影した動画を選んでください。\n選ぶまでは道場の画像を表示します。');
    setTimeout(() => { if (!fileUrl) msg(''); }, 3500);
    S.bg = 'dojo'; showBg(); $('#videoBox').hidden = false;
    return;
  }
  S.bg = v;
  showBg();
}
function bgError(text) { stopCam(); S.bg = 'dojo'; showBg(); msg(text, true); setTimeout(() => msg(''), 6000); }
function stopCam() { if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; $('#bgCam').srcObject = null; } }
function syncVideo() {
  if (S.bg !== 'file' || !fileUrl) return;
  const v = $('#bgFile');
  if (!(v.readyState >= 1)) return;
  const want = Math.max(0, S.t + (Number($('#videoOffset').value) || 0));
  v.playbackRate = S.speed;
  if (S.playing) { if (v.paused) v.play().catch(() => {}); if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want; }
  else { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - want) > 0.04) v.currentTime = want; }
}

// ---------------------------------------------------------------------
// 比較画像（背景のみ／重ねた結果）
// ---------------------------------------------------------------------
function capture() {
  const el = bgEl(), r = bgRect(el);
  const st = $('#povStage'), W = st.clientWidth, H = st.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
  const mk = () => { const c = document.createElement('canvas'); c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); if (r) g.drawImage(el, r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr); return c; };
  const bg = mk(), mix = mk();
  if (renderer) { renderFrame(); mix.getContext('2d').drawImage(renderer.domElement, 0, 0, mix.width, mix.height); }
  const g = mix.getContext('2d'); g.font = `${12 * dpr}px system-ui`; g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, 0, mix.width, 18 * dpr); g.fillStyle = '#fff';
  g.fillText(`${D.kind === 'demo' ? DEMO_LABEL : D.name}  ${S.view.toUpperCase()} t=${S.t.toFixed(2)}s`, 6 * dpr, 13 * dpr);
  return { bg: bg.toDataURL('image/png'), mix: mix.toDataURL('image/png') };
}

// ---------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------
function setPressed(group, v) { document.querySelectorAll(`[data-group="${group}"] [data-v]`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(v)))); }
function setPlaying(on) {
  S.playing = on;
  const b = $('#btnPlay'); b.textContent = on ? '❚❚' : '▶'; b.setAttribute('aria-label', on ? '停止' : '再生');
  if (on && S.t >= (D.res.frames.length - 1) * INTERVAL - 1e-6) S.t = 0;
}
function stepFrame(d) { setPlaying(false); const k = Math.round(S.t / INTERVAL) + d; S.t = Math.max(0, Math.min(D.res.frames.length - 1, k)) * INTERVAL; }
function applyAdjInputs() {
  document.querySelectorAll('#adjust [data-k]').forEach((el) => {
    const k = el.dataset.k;
    if (el.type === 'checkbox') el.checked = !!S.adj[k]; else el.value = String(S.adj[k]);
    showOut(el);
  });
  $('#pip').hidden = !S.adj.pip;
}
function showOut(el) {
  const o = el.parentElement.querySelector('output'); if (!o) return;
  const k = el.dataset.k, v = Number(el.value);
  o.textContent = { opacity: `${Math.round(v * 100)}%`, scale: `${v.toFixed(2)}×`, fov: `${v}°`, pitchOffset: `${v}°`, offFwd: `${v.toFixed(2)} m`, offSide: `${v.toFixed(2)} m`, offUp: `${v.toFixed(2)} m`, backDist: `${v.toFixed(2)} m`, orbit: `${v}°`, curl: v.toFixed(2), smooth: `±${v}`, bgZoom: `${v.toFixed(2)}×`, bgY: `${v}%` }[k] ?? el.value;
}
function onAdj(el) {
  const k = el.dataset.k;
  S.adj[k] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : Number(el.value);
  showOut(el); saveAdj();
  if (k === 'opacity' && rig) rig.setOpacity(S.adj.opacity);
  if (k === 'curl' && rig) rig.setCurl(S.adj.curl);
  if (k === 'smooth' || k === 'fwdSource') computeCam();
  if (k === 'bgZoom' || k === 'bgY') layoutBg();
  if (k === 'pip') $('#pip').hidden = !S.adj.pip;
  if (k === 'mirror') useData(D.parsed, D.kind, D.name);
  lastFrameK = -1;
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function bind() {
  document.querySelectorAll('[data-group] [data-v]').forEach((b) => b.addEventListener('click', () => {
    const g = b.closest('[data-group]').dataset.group, v = b.dataset.v;
    if (g === 'bg') setBg(v);
    else if (g === 'view') { S.view = v; setPressed('view', v); $('#viewNote').textContent = VIEW_NOTE[v]; }
    else if (g === 'display') { S.display = v; setPressed('display', v); }
    else if (g === 'speed') { S.speed = Number(v); setPressed('speed', v); }
  }));
  $('#btnPlay').addEventListener('click', () => setPlaying(!S.playing));
  $('#btnPrev').addEventListener('click', () => stepFrame(-1));
  $('#btnNext').addEventListener('click', () => stepFrame(1));
  $('#seek').addEventListener('input', (e) => { S.t = Number(e.target.value); });
  $('#stepMode').addEventListener('change', (e) => { S.step = e.target.checked; });
  document.querySelectorAll('#adjust [data-k]').forEach((el) => el.addEventListener(el.type === 'range' ? 'input' : 'change', () => onAdj(el)));
  $('#btnReset').addEventListener('click', () => {
    const mirrorChanged = !!S.adj.mirror !== DEFAULTS.mirror;
    S.adj = { ...DEFAULTS }; saveAdj(); applyAdjInputs();
    if (rig) { rig.setOpacity(S.adj.opacity); rig.setCurl(S.adj.curl); }
    computeCam(); layoutBg();
    if (mirrorChanged) useData(D.parsed, D.kind, D.name);
  });
  $('#panelToggle').addEventListener('click', () => {
    const p = $('#povPanel'), c = p.classList.toggle('collapsed');
    $('#panelToggle').textContent = c ? '▲ 操作パネルを開く' : '▼ 操作パネルをたたむ';
    $('#panelToggle').setAttribute('aria-expanded', String(!c));
    requestAnimationFrame(resize);
  });
  // データの読み込み（端末の中だけ。原データは保持して書き換えない）
  $('#poseFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    msg(`${file.name} を読み込み中…`);
    const text = await file.text();
    const parsed = parsePoseText(text, file.name);
    parsed.rawText = text; Object.freeze(parsed);
    const ok = useData(parsed, 'import', file.name);
    msg(ok ? '' : `${file.name} は読み込めませんでした。理由は「正解動作データ」の欄に表示しています（表示中のデータはそのまま）。`, !ok);
    if (!ok) { $('#dataBox').open = true; setTimeout(() => msg(''), 6000); }
    e.target.value = '';
  });
  $('#btnDemo').addEventListener('click', () => useData(makeDemoParsed(), 'demo', 'DEMO'));
  $('#btnReprocess').addEventListener('click', () => useData(D.parsed, D.kind, D.name));
  $('#btnSampleCsv').addEventListener('click', () => download('kiva_pose3d_sample_DEMO.csv', samplesToCsv(makeDemoParsed().samples, { comment: `${DEMO_LABEL}（入力形式の見本）` }), 'text/csv'));
  $('#btnExport').addEventListener('click', () => {
    const r = (x) => Math.round(x * 1e5) / 1e5;
    const doc = {
      format: 'kiva-pose3d-processed/1',
      note: D.kind === 'demo' ? DEMO_LABEL : '読み込んだデータを検証・補間・0.2 秒の格子に同期した結果（原データは別に保管してください）',
      source: D.name, coordinateSystem: 'y-up（X=演者の左・Y=上・Z=演者の正面、メートル、床を Y=0 に移動）', interval: INTERVAL, options: opts(),
      report: D.res.report,
      frames: D.res.frames.map((f, k) => ({ frame: k, t: f.t, lost: f.lost, p: Array.from(f.p, r), v: Array.from(f.v, r), flags: Array.from(f.flags) })),
      flagBits: FLAG,
    };
    download(`${D.kind === 'demo' ? 'DEMO' : D.name.replace(/\.\w+$/, '')}_processed.json`, JSON.stringify(doc), 'application/json');
  });
  $('#videoFile').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(file);
    const v = $('#bgFile'); v.src = fileUrl; v.onloadedmetadata = () => layoutBg();
    stopCam(); S.bg = 'file'; showBg(); msg('');
  });
  $('#btnShot').addEventListener('click', () => {
    const r = capture();
    $('#shotBg').src = r.bg; $('#shotMix').src = r.mix; $('#dlBg').href = r.bg; $('#dlMix').href = r.mix;
    $('#shotDlg').showModal();
  });
  $('#shotClose').addEventListener('click', () => $('#shotDlg').close());
  // 時間グラフのタップ・ドラッグでシーク
  const tl = $('#timeline');
  const seekTo = (e) => { const r = tl.getBoundingClientRect(); S.t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (D.res.frames.length - 1) * INTERVAL; };
  tl.addEventListener('pointerdown', (e) => { tl.setPointerCapture(e.pointerId); seekTo(e); });
  tl.addEventListener('pointermove', (e) => { if (e.buttons) seekTo(e); });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); setPlaying(!S.playing); }
    if (e.key === 'ArrowLeft') stepFrame(-1);
    if (e.key === 'ArrowRight') stepFrame(1);
  });
  $('#bgDojo').addEventListener('load', layoutBg);
  $('#bgDojo').addEventListener('error', () => msg('道場の背景画像（assets/dojo_pov.jpg）を読み込めませんでした。', true));
  new ResizeObserver(() => { resize(); drawTimelineBase(); }).observe($('#povStage'));
  window.addEventListener('pagehide', stopCam);
}

// ---------------------------------------------------------------------
bind();
applyAdjInputs();
$('#viewNote').textContent = VIEW_NOTE.eye;
showBg();
useData(makeDemoParsed(), 'demo', 'DEMO');
const ready = init3d();
// 動作確認用（テストから状態を読む。操作は画面と同じ関数を通す）
window.__pov = {
  ready, S, D,
  info: () => curInfo && { k: curInfo.k, view: S.view, display: S.display, bg: S.bg, cam: curInfo.cam.pos, target: curInfo.cam.target, near: curInfo.cam.near, feetIn: curInfo.feetIn, fit: curInfo.fit, kind: D.kind, frames: D.res.frames.length, headVisible: rig?.meshes.head[0]?.visible, legsVisible: rig?.meshes.legs[0]?.visible, solid: rig?.root.visible, skeleton: skel?.group.visible },
  setTime: (t) => { S.t = t; renderFrame(); },
  render: () => renderFrame(),
};
