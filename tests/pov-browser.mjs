// POV / 正解動作ガイド（pov.html）の受入確認: npm start（別ターミナル）→ node tests/pov-browser.mjs（BASE=公開 URL でも可）
// - カメラの許可なしで道場の画像が出る・初期は DOJO / EYE / SOLID・DEMO の表示
// - EYE / OVER SHOULDER / THIRD PERSON でカメラの位置が実際に変わる・旋回でカメラの前方が追従する・足は視野に入ったときだけ
// - SOLID / SKELETON / BOTH / OFF・比較画像（背景のみ／重ねた結果）
// - 3D データの読み込み（412 コマ・欠損と低信頼度を含む）と 0.2 秒刻みの同期・不正なファイルの拒否・DEMO に戻す
// - カメラ拒否・カメラ許可（模擬カメラ）・動画ファイル背景・ゲーム本体からの行き来（ゲームは Three.js を読まない）
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { makeDemoParsed, samplesToCsv, DEMO_LABEL, N } from '../app/pov/pose.js';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const GL = ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const tmp = mkdtempSync(join(tmpdir(), 'kiva-pov-'));

// 試験用のファイル: 実データ風（DEMO の値にノイズ・欠損・低信頼度を加えた 412 コマ。中身は試験用）と、不正なファイル
const d = makeDemoParsed();
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
for (const s of d.samples) for (let j = 0; j < N; j++) for (let a = 0; a < 3; a++) s.vals[j * 4 + a] += rnd() * 0.01;
for (let k = 60; k < 64; k++) d.samples[k].vals.set([NaN, NaN, NaN, NaN], 15 * 4);
for (let k = 120; k < 124; k++) for (const j of [13, 14, 15, 16, 25]) d.samples[k].vals[j * 4 + 3] = 0.05;
const realCsv = join(tmp, 'seipai_world_test.csv');
writeFileSync(realCsv, samplesToCsv(d.samples, { comment: 'test data (not a real measurement)' }));
const badCsv = join(tmp, 'normalized.csv');
writeFileSync(badCsv, 'time,joint,x,y,z,visibility\n' + Array.from({ length: 10 }, (_, k) => Array.from({ length: 33 }, (_, j) => `${k * 0.2},${j},${0.4 + j * 0.005},${0.3 + j * 0.01},0.1,0.9`).join('\n')).join('\n'));
const video = join(tmp, 'clip.webm');
let haveVideo = false;
try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=8', '-c:v', 'libvpx', '-b:v', '200k', video]); haveVideo = true; } catch { console.log('（ffmpeg がないため動画ファイルの確認を省略）'); }

const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: GL });
const open = async (ctx, path = 'pov.html') => {
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.addInitScript(() => {
    window.__gum = 0;
    const md = navigator.mediaDevices;
    if (md && md.getUserMedia) { const orig = md.getUserMedia.bind(md); md.getUserMedia = (c) => { window.__gum++; return orig(c); }; }
  });
  await p.goto(base + path);
  return { p, errs };
};
const waitPov = (p) => p.waitForFunction(() => window.__pov && window.__pov.info(), null, { timeout: 60000 });
const info = (p) => p.evaluate(() => window.__pov.info());
const click = (p, sel) => p.evaluate((s) => document.querySelector(s).click(), sel);
const at = async (p, t) => { await p.evaluate((t) => window.__pov.setTime(t), t); return info(p); };

// ---- 1. スマホ縦・カメラの許可なし ----
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const { p, errs } = await open(ctx);
  // 3D の読み込み前でも背景（道場）が出る
  await p.waitForFunction(() => document.querySelector('#bgDojo').complete && document.querySelector('#bgDojo').naturalWidth > 0, null, { timeout: 30000 });
  await waitPov(p);
  const bg = await p.evaluate(() => {
    const st = document.querySelector('#povStage').getBoundingClientRect(), im = document.querySelector('#bgDojo'), r = im.getBoundingClientRect();
    return { nw: im.naturalWidth, nh: im.naturalHeight, hidden: im.hidden, covers: r.left <= st.left + 0.5 && r.top <= st.top + 0.5 && r.right >= st.right - 0.5 && r.bottom >= st.bottom - 0.5, centered: Math.abs((r.left + r.right) / 2 - (st.left + st.right) / 2) < 1, ratio: Math.abs(r.width / r.height - im.naturalWidth / im.naturalHeight) < 0.01 };
  });
  check(bg.nw === 1168 && !bg.hidden && bg.covers && bg.centered && bg.ratio, 'カメラの許可なしで道場の画像を表示（縦横比を保ち中央クロップ）', JSON.stringify(bg));
  const pressed = await p.evaluate(() => [...document.querySelectorAll('[data-group] [aria-pressed=true]')].map((b) => `${b.closest('[data-group]').dataset.group}=${b.dataset.v}`));
  check(['bg=dojo', 'view=eye', 'display=solid'].every((x) => pressed.includes(x)), '初期は DOJO / EYE / SOLID', pressed.join(' '));
  let i = await info(p);
  check(i.kind === 'demo' && (await p.textContent('#demoBadge')) === DEMO_LABEL, '実データ未読込は「DEMO / 人工的な動作、空手の正解ではありません」');
  check(i.headVisible === false && i.solid === true && i.skeleton === false, '一人称では頭を描かない（SOLID のみ）');
  check(await p.evaluate(() => window.__gum) === 0, 'カメラは選ぶまで起動しない（getUserMedia を呼ばない）');
  const taps = await p.evaluate(() => [...document.querySelectorAll('#povPanel .pbtn, #povHead .pbtn')].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return [b.textContent.trim().slice(0, 14), Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => w < 44 || h < 44));
  check(taps.length === 0, 'ボタンのタップ領域は 44px 以上', JSON.stringify(taps));
  check(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'ページの横スクロールなし');
  const h0 = await p.evaluate(() => document.querySelector('#povStage').clientHeight);
  await click(p, '#panelToggle'); await p.waitForTimeout(200);
  const h1 = await p.evaluate(() => document.querySelector('#povStage').clientHeight);
  check(h1 > h0 + 200, '操作パネルをたたむと映像の領域が広がる（パネルは映像を覆わない）', `${h0}→${h1}px`);
  await click(p, '#panelToggle');

  // 視点: 同じ時刻（体が 90° 旋回した後）で 3 つの視点のカメラ位置
  const views = {};
  for (const v of ['eye', 'over', 'third']) { await click(p, `[data-group=view] [data-v=${v}]`); views[v] = await at(p, 25); }
  const eyeData = await p.evaluate(() => { const a = window.__pov.D.an[125]; return { eye: a.eye, fwd: a.headFwd }; });
  const behind = (c) => (c[0] - eyeData.eye[0]) * eyeData.fwd[0] + (c[2] - eyeData.eye[2]) * eyeData.fwd[2];
  check(dist(views.eye.cam, eyeData.eye) < 0.1, 'EYE: カメラは演者の目の位置', dist(views.eye.cam, eyeData.eye).toFixed(3));
  const od = dist(views.over.cam, eyeData.eye);
  check(od > 0.4 && od < 0.9 && behind(views.over.cam) < -0.35 && views.over.cam[1] > eyeData.eye[1], 'OVER SHOULDER: 頭の後ろ 0.4〜0.8 m・少し上', `距離 ${od.toFixed(2)} m・前後 ${behind(views.over.cam).toFixed(2)}`);
  check(dist(views.third.cam, views.third.target) > 2 && dist(views.third.cam, views.eye.cam) > 1, 'THIRD PERSON: 離れた位置から全身');
  check(views.over.headVisible && !views.eye.headVisible, '頭は EYE だけ描かない');
  // 旋回: 体が 0° → 90° でカメラの前方が回る（モデルを回すのではない）
  await click(p, '[data-group=view] [data-v=eye]');
  const a0 = await at(p, 5), a1 = await at(p, 25);
  const dir = (x) => { const v = [x.target[0] - x.cam[0], x.target[2] - x.cam[2]]; return (Math.atan2(v[0], v[1]) * 180) / Math.PI; };
  check(Math.abs(dir(a0)) < 5 && Math.abs(dir(a1) - 90) < 5, 'EYE: 演者の向き（旋回）にカメラの前方が追従', `${dir(a0).toFixed(1)}° → ${dir(a1).toFixed(1)}°`);
  check(dist(a0.cam, a1.cam) > 0.05, 'EYE: 旋回で目の位置も動く');
  // 足: 前を向いているときは描かず、下を向くと描く
  check(a0.legsVisible === false && a0.feetIn === false, '一人称: 視野に入らない足は描かない');
  await p.evaluate(() => { window.__pov.S.adj.pitchOffset = -45; window.__pov.S.adj.fov = 100; });
  const down = await at(p, 5);
  check(down.feetIn === true && down.legsVisible === true, '一人称: 足が視野に入ったときは描く');
  await p.evaluate(() => { window.__pov.S.adj.pitchOffset = -12; window.__pov.S.adj.fov = 72; });
  // 表示の切り替え
  for (const [v, solid, sk] of [['skeleton', false, true], ['both', true, true], ['off', false, false], ['solid', true, false]]) {
    await click(p, `[data-group=display] [data-v=${v}]`);
    const x = await at(p, 5);
    check(x.solid === solid && x.skeleton === sk, `表示 ${v.toUpperCase()}`);
  }
  // 比較画像: 背景のみと重ねた結果。重ねた結果は腕・手の分だけ違う（OFF ではほぼ同じ）
  const diff = async () => {
    await click(p, '#btnShot'); await p.waitForSelector('#shotDlg[open]');
    const r = await p.evaluate(async () => {
      const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = src; });
      const [a, b] = await Promise.all([load(document.querySelector('#shotBg').src), load(document.querySelector('#shotMix').src)]);
      const c = document.createElement('canvas'); c.width = a.width; c.height = a.height; const g = c.getContext('2d');
      g.drawImage(a, 0, 0); const A = g.getImageData(0, 20 * 2, c.width, c.height - 40).data; g.drawImage(b, 0, 0); const B = g.getImageData(0, 20 * 2, c.width, c.height - 40).data;
      let n = 0; for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30) n++;
      return n / (A.length / 4);
    });
    await click(p, '#shotClose');
    return r;
  };
  await p.evaluate(() => window.__pov.setTime(5));
  const dSolid = await diff();
  await click(p, '[data-group=display] [data-v=off]');
  const dOff = await diff();
  check(dSolid > 0.01 && dOff < 0.002, '比較画像: 背景のみ／重ねた結果（EYE で腕・手が画面に入る）', `差 ${(dSolid * 100).toFixed(1)}%・OFF ${(dOff * 100).toFixed(2)}%`);
  await click(p, '[data-group=display] [data-v=solid]');

  // データの読み込み
  await p.setInputFiles('#poseFile', realCsv);
  await p.waitForFunction(() => window.__pov.D.kind === 'import');
  i = await at(p, 10);
  const badge = await p.evaluate(() => ({ t: document.querySelector('#demoBadge').textContent, real: document.querySelector('#demoBadge').classList.contains('real') }));
  check(i.frames === 412 && badge.real && /seipai_world_test\.csv（412 コマ）/.test(badge.t) && !/DEMO/.test(badge.t), '3D データ（412 コマ）を読み込むと DEMO 表示が消え、推定値であることを示す', badge.t);
  check(i.k === 50 && (await p.textContent('#timeLab')) === '10.00 s・コマ 0050', '0.2 秒刻みの同期（10.00 秒 = コマ 0050）');
  const rep = await p.textContent('#report');
  check(/欠損 4 点を補間/.test(rep) && /見失い 4 コマ/.test(rep), '検証の結果（欠損の補間・見失い）を表示', rep.slice(0, 120));
  await p.evaluate(() => window.__pov.setTime(24.4));
  const warn = await p.evaluate(() => ({ hidden: document.querySelector('#warnBadge').hidden, t: document.querySelector('#warnBadge').textContent, bad: document.querySelector('#warnBadge').classList.contains('bad') }));
  check(!warn.hidden && warn.bad && /見失い/.test(warn.t), '見失ったコマは警告を表示', warn.t.slice(0, 80));
  await p.evaluate(() => window.__pov.setTime(30));
  check(await p.evaluate(() => document.querySelector('#warnBadge').hidden), '問題のないコマは警告なし');
  // 再生: 1× で約 1 秒進む
  await p.evaluate(() => window.__pov.setTime(0));
  await click(p, '#btnPlay'); await p.waitForTimeout(1500); await click(p, '#btnPlay');
  const tPlay = await p.evaluate(() => window.__pov.S.t);
  check(tPlay > 0.8 && tPlay < 2.5, '再生・停止', `${tPlay.toFixed(2)} 秒`);
  await click(p, '#btnNext'); const tn = await p.evaluate(() => window.__pov.S.t);
  check(Math.abs(tn / 0.2 - Math.round(tn / 0.2)) < 1e-6, 'コマ送りは 0.2 秒単位', tn.toFixed(2));
  // 不正なファイル: 読み込まず、表示中のデータを残す
  await p.setInputFiles('#poseFile', badCsv);
  await p.waitForFunction(() => /正規化座標/.test(document.querySelector('#report').textContent));
  i = await info(p);
  check(i.kind === 'import' && i.frames === 412, '不正なファイル（画像の正規化座標）は読み込まず、表示中のデータを残す');
  await click(p, '#btnDemo');
  check((await info(p)).kind === 'demo' && (await p.textContent('#demoBadge')) === DEMO_LABEL, 'DEMO に戻すと DEMO 表示');
  // 拒否: 利用者がカメラを許可しない（ブラウザの確認で「許可しない」を選んだ結果を再現）→ 説明を出して道場の画像のまま
  await p.evaluate(() => { navigator.mediaDevices.getUserMedia = () => { window.__gum++; return Promise.reject(new DOMException('denied', 'NotAllowedError')); }; });
  await click(p, '[data-group=bg] [data-v=camera]');
  await p.waitForFunction(() => /許可されませんでした/.test(document.querySelector('#povMsg').textContent), null, { timeout: 15000 });
  const deny = await p.evaluate(() => ({ msg: document.querySelector('#povMsg').textContent, bg: window.__pov.S.bg, dojo: !document.querySelector('#bgDojo').hidden, err: document.querySelector('#povMsg').classList.contains('err') }));
  check(deny.bg === 'dojo' && deny.dojo && deny.err && /道場の画像で続けます/.test(deny.msg), 'カメラ拒否: 理由を表示して道場の画像で続ける', deny.msg.replace(/\n/g, ' '));
  await p.evaluate(() => { Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: undefined, configurable: true }); });
  await click(p, '[data-group=bg] [data-v=camera]');
  await p.waitForFunction(() => /対応していません/.test(document.querySelector('#povMsg').textContent), null, { timeout: 5000 });
  check(await p.evaluate(() => window.__pov.S.bg === 'dojo'), 'カメラ非対応: 説明を表示して道場の画像で続ける');
  check(errs.length === 0, 'ページエラーなし', errs.join(' / '));
  if (process.env.SHOTS) { await click(p, '[data-group=view] [data-v=eye]'); await p.evaluate(() => window.__pov.setTime(5)); await p.waitForTimeout(200); await p.screenshot({ path: `${process.env.SHOTS}/pov_mobile_eye.png` }); }
  await ctx.close();
}

// ---- 2. カメラ許可（模擬カメラ）・動画ファイル ----
{
  const b2 = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: [...GL, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await b2.newContext({ viewport: { width: 844, height: 390 }, permissions: ['camera'] });
  const { p, errs } = await open(ctx);
  await waitPov(p);
  await click(p, '[data-group=bg] [data-v=camera]');
  await p.waitForFunction(() => window.__pov.S.bg === 'camera' && document.querySelector('#bgCam').videoWidth > 0, null, { timeout: 20000 }).catch(() => {});
  const cam = await p.evaluate(() => ({ bg: window.__pov.S.bg, w: document.querySelector('#bgCam').videoWidth, dojoHidden: document.querySelector('#bgDojo').hidden, gum: window.__gum }));
  check(cam.bg === 'camera' && cam.w > 0 && cam.dojoHidden && cam.gum === 1, 'LIVE CAMERA: 選んだときに起動して背景に映す', JSON.stringify(cam));
  await click(p, '[data-group=bg] [data-v=dojo]');
  const back = await p.evaluate(() => ({ bg: window.__pov.S.bg, src: document.querySelector('#bgCam').srcObject, dojo: !document.querySelector('#bgDojo').hidden }));
  check(back.bg === 'dojo' && back.src === null && back.dojo, 'DOJO に戻すとカメラを止める');
  if (haveVideo) {
    await click(p, '[data-group=bg] [data-v=file]');
    const pre = await p.evaluate(() => ({ bg: window.__pov.S.bg, dojo: !document.querySelector('#bgDojo').hidden, box: !document.querySelector('#videoBox').hidden }));
    check(pre.bg === 'dojo' && pre.dojo && pre.box, 'VIDEO FILE: 動画を選ぶまで道場の画像を消さない');
    await p.setInputFiles('#videoFile', video);
    await p.waitForFunction(() => document.querySelector('#bgFile').readyState >= 1);
    await p.evaluate(() => window.__pov.setTime(3)); await p.waitForTimeout(500); await p.evaluate(() => window.__pov.setTime(3)); await p.waitForTimeout(300);
    const v = await p.evaluate(() => ({ bg: window.__pov.S.bg, ct: document.querySelector('#bgFile').currentTime }));
    check(v.bg === 'file' && Math.abs(v.ct - 3) < 0.2, 'VIDEO FILE: 動画を背景にして時刻を合わせる', JSON.stringify(v));
    await click(p, '[data-group=bg] [data-v=dojo]');
    check(await p.evaluate(() => !document.querySelector('#bgDojo').hidden && window.__pov.S.bg === 'dojo'), '動画から道場の画像に戻せる');
  }
  check(errs.length === 0, 'ページエラーなし（カメラ・動画）', errs.join(' / '));
  await ctx.close(); await b2.close();
}

// ---- 3. ゲーム本体との行き来（ゲームは POV のコード・Three.js を読まない） ----
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const reqs = [];
  p.on('request', (r) => reqs.push(r.url()));
  await p.goto(base);
  await p.waitForFunction(() => ['ready', 'paused', 'playing'].includes(window.__app?.state), null, { timeout: 120000 });
  check(!reqs.some((u) => /\/app\/pov\/|three|dojo_pov/.test(u)), 'ゲームの初回表示では POV・Three.js を読み込まない');
  check(await p.getAttribute('#btnPov', 'href') === 'pov.html', 'ゲームのメニュー（⚙ 設定）に POV への入口');
  await p.click('#more > summary');
  await p.click('#btnPov');
  await waitPov(p);
  check(/pov\.html$/.test(p.url()), 'POV のページに移る');
  await p.click('#povBack');
  await p.waitForFunction(() => ['ready', 'paused', 'playing'].includes(window.__app?.state), null, { timeout: 120000 });
  check(new URL(p.url()).pathname.endsWith('/'), '戻るでゲームに戻り、ゲームが使える状態');
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
