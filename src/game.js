// ゲーム本体: 読み込み → 開始 → ループ（音声時刻基準）→ 結果。
// 音声・画像・譜面・入力・判定・描画・エフェクトはそれぞれ別モジュール。

import { AudioClock } from './clock.js';
import { compileChart } from './chart.js';
import { Judge, DEFAULT_WINDOWS } from './judge.js';
import { AutoPlayer } from './auto.js';
import { InputRouter } from './input.js';
import { FrameStore } from './frames.js';
import { StageRenderer } from './renderer.js';
import { TrackRenderer } from './track.js';
import { Effects } from './effects.js';

const $ = (s) => document.querySelector(s);

class LoadError extends Error {
  constructor(stage, url, cause) {
    super(`${stage}の読み込みに失敗: ${url}\n${cause?.message || cause}`);
    this.stage = stage;
    this.url = url;
  }
}

async function fetchChecked(stage, url, kind) {
  let res;
  try { res = await fetch(url); } catch (e) { throw new LoadError(stage, url, e); }
  if (!res.ok) throw new LoadError(stage, url, `HTTP ${res.status}${res.status === 404 ? '（ファイルが配置されていません。README の「素材の配置」を参照）' : ''}`);
  try { return kind === 'json' ? await res.json() : await res.arrayBuffer(); } catch (e) { throw new LoadError(stage, url, e); }
}

export class Game {
  constructor() {
    this.params = new URLSearchParams(location.search);
    this.chartUrl = new URL(this.params.get('chart') || 'charts/seipai.chart.json', location.href).href;
    this.clock = new AudioClock();
    this.effects = new Effects();
    this.mode = this.params.get('mode') === 'manual' ? 'manual' : 'auto';
    this.generation = 0;
    this.state = 'loading'; // loading | ready | playing | paused | ended | error
    this.inputLatency = Number(localStorage.getItem('kr.inputLatency') || 0) / 1000;
    this.lastT = 0;
    this.log = [];
  }

  // ---------- 読み込み ----------
  status(msg, kind = 'info') {
    const el = $('#status');
    el.textContent = msg;
    el.dataset.kind = kind;
    if (kind === 'error') console.error(msg); else console.info(msg);
  }

  async load() {
    try {
      this.status('譜面を読み込み中…');
      const chart = await fetchChecked('譜面', this.chartUrl, 'json');
      this.rawChart = chart;
      const framesUrl = new URL(chart.frames, this.chartUrl).href;
      this.status('フレーム定義を読み込み中…');
      const fdef = await fetchChecked('フレーム定義(frames.json)', framesUrl, 'json');
      this.frames = new FrameStore(fdef, framesUrl, {
        decodeHeight: Math.min(1024, Math.round(Math.max(screen.width, screen.height) * Math.min(devicePixelRatio || 1, 2))),
      });
      this.frames.applyFixes(chart.frameFixes || []);
      this.status('音声を読み込み中…');
      const audioP = this.loadAudio([].concat(chart.audio));
      const framesP = this.frames.fetchAll((d, n) => {
        $('#progress').value = d / n;
        if (this.state === 'loading') this.status(`人物画像を読み込み中… ${d}/${n}`);
      });
      audioP.catch(() => {}); // エラーは下の Promise.all で表示
      await Promise.all([audioP, framesP]);
      this.chart = compileChart(chart, this.clock.duration, this.frames.duration);
      for (const w of this.chart.warnings) console.warn('[譜面]', w);
      await this.frames.warm(this.frames.indexAt(this.chart.warp.map(0)));
      this.setupView();
      this.state = 'ready';
      this.status(`準備完了: ${this.chart.title}（ノーツ ${this.chart.notes.length}、音声 ${this.clock.duration.toFixed(1)}秒、画像 ${this.frames.count}枚 5fps）` +
        (this.chart.warnings.length ? ` ／ 譜面の警告 ${this.chart.warnings.length}件（コンソール参照）` : ''), 'ok');
      this.updateButtons();
      this.render();
    } catch (e) {
      this.state = 'error';
      this.status(e.message, 'error');
      this.updateButtons();
    }
  }

  /** 音声候補を順に試し、最初にデコードできたものを使う（ブラウザごとの対応形式の差を吸収） */
  async loadAudio(list) {
    const errs = [];
    for (const rel of list) {
      const url = new URL(rel, this.chartUrl).href;
      try {
        const buf = await fetchChecked('音声', url, 'bin');
        try { await this.clock.load(buf); } catch (e) { throw new Error(`音声をデコードできません（このブラウザ非対応の形式の可能性）: ${url}\n${e.message}`); }
        this.audioUrl = url;
        return;
      } catch (e) { errs.push(e.message); }
    }
    throw new Error(errs.join('\n'));
  }

  setupView() {
    this.stage = new StageRenderer($('#stage'), this.frames, this.chart.camera);
    this.stage.debug = this.params.has('debug');
    this.track = new TrackRenderer($('#track'), this.chart.commands);
    this.track.judgeEl = $('#judgeText');
    const pad = $('#pad');
    pad.innerHTML = '';
    const buttons = this.chart.commands.map((c, i) => {
      const b = document.createElement('button');
      b.className = 'padbtn';
      b.style.setProperty('--c', c.color || '#fc6');
      b.innerHTML = `<span class="lbl">${c.label}</span><span class="key">${c.keyHint || ''}</span>`;
      b.setAttribute('aria-label', `${c.name || c.label}（レーン${i + 1}）`);
      pad.appendChild(b);
      return b;
    });
    this.input = new InputRouter(this.chart.commands.map((c) => c.id), (ev) => this.onCommand(ev));
    this.input.attachKeyboard();
    this.input.attachButtons(buttons);
    const onResize = () => { this.stage.resize(); this.track.resize(); this.render(); };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 200));
    new ResizeObserver(onResize).observe($('#stage'));
    onResize();
    window.addEventListener('gamepadconnected', () => this.updatePadStatus());
    window.addEventListener('gamepaddisconnected', () => this.updatePadStatus());
  }

  // ---------- 進行 ----------
  newRun() {
    this.generation++;
    const windows = { ...DEFAULT_WINDOWS, ...(this.chart.windows || {}), ...this.windowOverrides() };
    this.judge = new Judge(this.chart.notes, windows);
    this.auto = this.mode === 'auto' ? new AutoPlayer(this.judge, { generation: this.generation }) : null;
    this.judge.on((e) => (e.type === 'judged' ? this.onJudged(e) : this.onStray(e)));
    this.effects.clear();
    this.track.flashes = [];
    this.lastT = 0;
    this.log = [];
    $('#result').hidden = true;
    this.updateHud();
  }

  windowOverrides() {
    const o = {};
    if (this.params.has('perfect')) o.perfect = Number(this.params.get('perfect')) / 1000;
    if (this.params.has('good')) o.good = Number(this.params.get('good')) / 1000;
    return o;
  }

  async start() {
    if (!(this.state === 'ready' || this.state === 'ended')) return;
    try { await this.clock.unlock(); } catch (e) { this.status('音声を有効化できません: ' + e.message, 'error'); return; }
    this.newRun();
    this.clock.onended = () => this.finish();
    this.input.resetHeld();
    this.clock.play(0);
    this.state = 'playing';
    this.updateButtons();
    this.loop();
  }

  pause(reason = '') {
    if (this.state !== 'playing') return;
    this.clock.pause();
    this.state = 'paused';
    this.updateButtons();
    if (reason) this.status(`一時停止（${reason}）`);
  }

  async resume() {
    if (this.state !== 'paused') return;
    await this.clock.unlock();
    this.input.resetHeld();
    this.clock.resume();
    this.state = 'playing';
    this.updateButtons();
    this.status('再生中', 'ok');
    this.loop();
  }

  async restart() {
    if (!['playing', 'paused', 'ended'].includes(this.state)) return;
    this.clock.restart();
    this.state = 'ready';
    await this.start();
  }

  setMode(mode) {
    if (this.state === 'playing' || this.state === 'paused') return;
    this.mode = mode;
    this.updateButtons();
    this.updateHud();
  }

  finish() {
    if (this.state !== 'playing') return;
    const t = this.clock.duration;
    this.auto?.update(t);
    this.judge.update(t + 10);
    this.state = 'ended';
    this.updateButtons();
    this.showResult();
    window.__lastResult = { mode: this.mode, ...this.judge.summary(), log: this.log };
  }

  loop() {
    if (this._raf) return;
    const tick = () => {
      this._raf = 0;
      if (this.state !== 'playing') { this.render(); return; }
      this.frame();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  /** 1描画フレーム分の処理。時刻は常に音声の再生位置から取る。 */
  frame() {
    let t = this.clock.songTimeAtPerf(performance.now());
    t = Math.max(t, this.lastT); // 表示用は単調増加に
    this.lastT = t;
    this.input.pollGamepads(performance.now());
    this.auto?.update(t);           // AUTO: 予定時刻ちょうどの入力を共通判定へ
    this.judge.update(t);           // 期限超過 → MISS
    this.render(t);
    if (this._padTick++ % 30 === 0) this.updatePadStatus();
  }

  onCommand(ev) {
    if (this.state !== 'playing') return;
    if (this.mode === 'auto') return; // AUTO DEMO 中の人の入力は成績に混ぜない
    const t = this.clock.songTimeAtPerf(ev.perfMs) - this.inputLatency;
    this.judge.input({ cmd: ev.cmd, time: t, source: ev.source, id: ev.id });
  }

  /** 空振り（対応ノーツなし）: 判定はせず、押したことだけ控えめに表示 */
  onStray(e) {
    this.track.mark('---', Math.max(e.time, this.lastT));
  }

  onJudged(e) {
    const n = this.chart.notes.find((x) => x.id === e.note.id);
    this.log.push({ id: n.id, t: n.t, result: e.result, delta: e.delta, source: e.source });
    const now = this.lastT;
    this.track.mark(e.result, e.result === 'MISS' ? now : (e.time ?? now));
    this.updateHud();
    if (e.result === 'MISS') return; // 失敗時は成功エフェクトを出さない
    // エフェクトは技の「決め」（= ノーツ時刻）に合わせて発生。遅れた入力は入力時刻で。
    const at = Math.max(n.t, e.time ?? n.t);
    const vt = this.chart.warp.map(n.t);
    const fi = this.frames.indexAt(vt);
    for (const fx of n.fx) {
      const p = this.fxPosition(fx, fi);
      if (!p) continue;
      this.effects.spawn(fx.type, at, { ...p, dir: fx.dir, color: fx.color, seed: Math.random() * 6 });
    }
    if (e.combo >= 5) {
      // 連続成功: 控えめな残像（直前の動作の2コマ）
      this.effects.spawn('afterimage', at, { videoTime: vt - 0.2 });
      this.effects.spawn('afterimage', at + 0.04, { videoTime: vt - 0.4 });
    }
    if (e.combo > 0 && e.combo % 10 === 0) this.effects.spawn('flash', at, {});
  }

  /** エフェクト位置（元画像座標）: 手動指定 > 関節推定 > 人物領域の相対位置 */
  fxPosition(fx, fi) {
    const at = fx.at || {};
    if (at.x != null) return { x: at.x, y: at.y };
    if (at.joint) {
      const j = this.frames.joint(fi, at.joint);
      if (j && j.c >= (at.minConf ?? 0.3)) return { x: j.x + (at.dx || 0), y: j.y + (at.dy || 0) };
    }
    const b = this.frames.bbox(fi);
    const rel = at.rel || [0.5, 0.4];
    if (b) return { x: b[0] + b[2] * rel[0], y: b[1] + b[3] * rel[1] };
    return null;
  }

  render(t = this.clock.now()) {
    if (!this.stage) return;
    const vt = this.chart.warp.map(t);
    const beatPulse = this.judge ? Math.max(0, 1 - (t - (this._lastHit ?? -9)) / 0.3) : 0;
    this.stage.draw(t, vt, this.effects, {
      pulse: beatPulse,
      info: { rate: this.chart.warp.rateAt(t), extra: `notes ${this.judge ? this.judge.notes.filter((n) => n.result).length : 0}/${this.chart.notes.length}` },
    });
    this.track.draw(t, this.judge ? this.judge.notes : this.chart.notes);
    const p = this.clock.duration ? t / this.clock.duration : 0;
    $('#timebar').style.setProperty('--p', p);
    window.__debug = { t, vt, frame: this.frames.indexAt(vt), shown: this.stage.lastShown, state: this.state };
  }

  // ---------- UI ----------
  updateHud() {
    const auto = this.mode === 'auto';
    $('#modeBadge').textContent = auto ? 'AUTO DEMO' : 'MANUAL';
    $('#modeBadge').dataset.mode = this.mode;
    $('#app').dataset.mode = this.mode;
    if (!this.judge) return;
    const s = this.judge.summary();
    $('#score').textContent = s.score.toLocaleString();
    $('#combo').textContent = this.judge.combo;
    $('#counts').textContent = `P ${s.perfect} / G ${s.good} / M ${s.miss}`;
    if (this.judge.combo > 0) this._lastHit = this.lastT;
  }

  showResult() {
    const s = this.judge.summary();
    const auto = this.mode === 'auto';
    $('#resultTitle').textContent = auto ? 'AUTO DEMO 終了（自動入力の記録・プレイヤー成績ではありません）' : 'MANUAL 結果';
    $('#resultBody').innerHTML = `
      <dl>
        <dt>達成率</dt><dd>${(s.achievement * 100).toFixed(1)}%</dd>
        <dt>最大コンボ</dt><dd>${s.maxCombo} / ${s.total}</dd>
        <dt>PERFECT</dt><dd>${s.perfect}</dd>
        <dt>GOOD</dt><dd>${s.good}</dd>
        <dt>MISS</dt><dd>${s.miss}</dd>
        <dt>スコア</dt><dd>${s.score.toLocaleString()}</dd>
      </dl>
      <p class="note">ゲーム内の入力タイミングの成績です。空手の技能評価ではありません。</p>`;
    $('#result').hidden = false;
  }

  updateButtons() {
    const st = this.state;
    $('#btnStart').disabled = !(st === 'ready' || st === 'ended');
    $('#btnPause').disabled = !(st === 'playing' || st === 'paused');
    $('#btnPause').textContent = st === 'paused' ? '再開' : '一時停止';
    $('#btnRestart').disabled = !['playing', 'paused', 'ended'].includes(st);
    const lock = st === 'playing' || st === 'paused';
    document.querySelectorAll('input[name=mode]').forEach((r) => { r.disabled = lock; r.checked = r.value === this.mode; });
    $('#app').dataset.state = st;
    this.updateHud();
  }

  updatePadStatus() {
    const el = $('#padStatus');
    const pads = this.input?.gamepads?.length ? this.input.gamepads
      : (navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean).map((p) => ({ id: p.id, mapping: p.mapping, pressed: [] })) : []);
    if (!pads.length) { el.textContent = 'ゲームパッド: 未接続（ボタンを押すと認識されます）'; return; }
    el.textContent = pads.map((p) => `ゲームパッド: ${p.id.slice(0, 40)}（${p.mapping || '非標準配置'}） 押下中: [${p.pressed.join(',')}]`).join(' / ');
  }

  bindUi() {
    $('#btnStart').addEventListener('click', () => this.start());
    $('#btnPause').addEventListener('click', () => (this.state === 'paused' ? this.resume() : this.pause()));
    $('#btnRestart').addEventListener('click', () => this.restart());
    $('#btnResultClose').addEventListener('click', () => { $('#result').hidden = true; });
    document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => this.setMode(r.value)));
    const vol = $('#volume');
    vol.value = Number(localStorage.getItem('kr.volume') ?? 0.8);
    this.clock.setVolume(Number(vol.value));
    vol.addEventListener('input', () => { this.clock.setVolume(Number(vol.value)); localStorage.setItem('kr.volume', vol.value); });
    const lat = $('#latency');
    lat.value = Math.round(this.inputLatency * 1000);
    lat.addEventListener('change', () => { this.inputLatency = Number(lat.value) / 1000; localStorage.setItem('kr.inputLatency', lat.value); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause('タブが非表示になりました'); });
    window.addEventListener('pagehide', () => this.pause('ページ離脱'));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); if (this.state === 'playing') this.pause(); else if (this.state === 'paused') this.resume(); else this.start(); }
      if (e.code === 'KeyR' && !e.repeat) this.restart();
    });
    this._padTick = 0;
    setInterval(() => { if (this.state !== 'playing') { this.input?.pollGamepads(); this.updatePadStatus(); } }, 500); // 状態表示のみ（同期には不使用）
  }
}

window.addEventListener('error', (e) => {
  const el = document.querySelector('#status');
  if (el) { el.textContent = `スクリプトエラー: ${e.message}`; el.dataset.kind = 'error'; }
});

const game = new Game();
window.__game = game;
game.bindUi();
game.updateButtons();
game.load();
