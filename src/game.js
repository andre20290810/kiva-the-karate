// ゲーム本体: 読み込み → 開始 → ループ（音声時刻基準）→ 結果。
// 音声・画像・譜面・入力・判定・描画・エフェクトはそれぞれ別モジュール。

import { AudioClock } from './clock.js';
import { compileChart } from './chart.js';
import { Judge, DEFAULT_WINDOWS } from './judge.js';
import { AutoPlayer } from './auto.js';
import { InputRouter } from './input.js';
import { FrameStore } from './frames.js';
import { TrackRenderer } from './track.js';
import { Scene } from './gfx/scene.js';
import { buildControlMap } from './controls.js';
import { ControllerUI } from './ui/controller-ui.js';
import { PadPanel } from './ui/pad-panel.js';

const $ = (s) => document.querySelector(s);
// 設定の保存（プライベートブラウズ等で localStorage が使えなくても動作を続ける）
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

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
    this.mode = this.params.get('mode') === 'manual' ? 'manual' : 'auto';
    this.generation = 0;
    this.state = 'loading'; // loading | ready | playing | paused | ended | error
    this.inputLatency = Number(store.get('kr.inputLatency') || 0) / 1000;
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
    // ボタン ⇔ 譜面コマンドの対応はここで1回だけ作り、画面ボタン・譜面レーン・入力で共有する
    this.controls = buildControlMap(this.chart.commands);
    const quality = this.params.get('quality') || store.get('kiva.quality') || 'AUTO';
    this.scene = new Scene($('#stage'), this.frames, { camera: this.chart.camera, stage: this.rawChart.stage }, {
      quality: quality.toUpperCase(), forceCanvas: this.params.has('canvas2d'),
    });
    $('#quality').value = this.scene.qualityMode;
    this.debug = this.params.has('debug');
    this.track = new TrackRenderer($('#track'), this.controls);
    this.track.judgeEl = $('#judgeText');
    this.pad = new ControllerUI($('#pad'), this.controls);
    this.input = new InputRouter(this.controls, (ev) => this.onCommand(ev));
    this.input.onHeldChange = (b, d) => this.pad.setHeld(b, d);
    this.input.attachKeyboard();
    this.input.attachButtons(this.pad.buttons);
    this.padPanel = new PadPanel($('#padPanel'), this.input, this.controls);
    this.input.onPadsChange = () => this.padPanel.update();
    const onResize = () => {
      this.scene.resize(); this.track.resize();
      if (this.state !== 'playing') this.render();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
    new ResizeObserver(onResize).observe($('#stageWrap'));
    new ResizeObserver(() => { this.track.resize(); if (this.state !== 'playing') this.render(); }).observe($('#track'));
    onResize();
    window.addEventListener('gamepadconnected', () => this.padPanel.update());
    window.addEventListener('gamepaddisconnected', () => this.padPanel.update());
    $('#rendererInfo').textContent = this.scene.rendererKind === 'webgl2' ? 'WebGL2' : 'Canvas2D（互換表示）';
    this.idleLoop();
  }

  /** 再生していない間もゲームパッドの押下表示と待機中のステージを更新する（判定には不使用） */
  idleLoop() {
    const tick = () => {
      if (this.state !== 'playing') {
        this.input.pollGamepads(performance.now());
        // 待機・終了画面だけステージを動かす。一時停止中は描き直さない（画面が静止する）
        if (this.state === 'ready' || this.state === 'ended') this.render(undefined, { idle: true });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------- 進行 ----------
  newRun() {
    this.generation++;
    const windows = { ...DEFAULT_WINDOWS, ...(this.chart.windows || {}), ...this.windowOverrides() };
    this.judge = new Judge(this.chart.notes, windows);
    this.auto = this.mode === 'auto' ? new AutoPlayer(this.judge, { generation: this.generation }) : null;
    this.judge.on((e) => (e.type === 'judged' ? this.onJudged(e) : this.onStray(e)));
    this.scene.reset();
    this.track.flashes = [];
    this.track.bursts = [];
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
    this.render(); // 停止位置で1回だけ描画（停止中は再描画しない＝静止）
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
    this.pad?.setDimmed(mode === 'auto');
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
    const tick = (ts) => {
      this._raf = 0;
      if (this.state !== 'playing') { this.render(); return; }
      this._frameMs = this._lastTs ? ts - this._lastTs : 16.7;
      this._lastTs = ts;
      this.frame();
      this._raf = requestAnimationFrame(tick);
    };
    this._lastTs = 0;
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
  }

  /** 表示用の時刻。再生中・停止中は直前に表示した時刻より戻さない（再開直後の出力遅延による一瞬の逆行を防ぐ） */
  displayTime() {
    const p = this.clock.position();
    return this.state === 'playing' || this.state === 'paused' ? Math.max(p, this.lastT) : p;
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
    const button = this.controls.buttonFor(n.cmd);
    this.track.mark(e.result, e.result === 'MISS' ? now : (e.time ?? now), button);
    this.pad.flash(button, e.result);
    this.updateHud();
    // 演出: 成功は技の「決め」（= ノーツ時刻）に合わせる。遅れた入力は入力時刻。AUTO/MANUAL で同じ規則。
    // 失敗は判定が確定した時刻に不発演出（成功エフェクトは出さない）。
    const at = e.result === 'MISS' ? now : Math.max(n.t, e.time ?? n.t);
    this.scene.hit({
      key: `${this.generation}:${n.id}`, grade: e.result, tech: n.move.vfx || 'generic', t: at,
      kimeVideoTime: this.chart.warp.map(e.result === 'MISS' ? now : n.t), fx: n.fx, combo: e.combo,
    });
    if (e.result === 'MISS') {
      const app = $('#app');
      app.classList.remove('combo-break'); void app.offsetWidth; app.classList.add('combo-break');
    }
  }

  render(t = this.displayTime(), { idle = false } = {}) {
    if (!this.scene) return;
    const vt = this.chart.warp.map(t);
    // 待機中だけはステージの床を壁時計で流す（再生中・一時停止中は音声時刻のみ）
    const stageT = idle && (this.state === 'ready' || this.state === 'ended') ? performance.now() / 1000 % 600 : t;
    const { shownIdx } = this.scene.render(t, vt, { frameMs: this._frameMs || 16.7, stageT });
    this.track.draw(t, this.judge ? this.judge.notes : this.chart.notes);
    const p = this.clock.duration ? t / this.clock.duration : 0;
    $('#timebar').style.setProperty('--p', p);
    window.__debug = { t, vt, frame: this.frames.indexAt(vt), shown: shownIdx, state: this.state, perf: this.scene.perf, vfx: this.scene.vfx.stats };
    if (this.debug) {
      const pf = this.scene.perf;
      $('#debug').textContent = `song ${t.toFixed(3)}s  video ${vt.toFixed(3)}s  frame ${shownIdx}/${this.frames.count} (5fps)\n` +
        `rate ${this.chart.warp.rateAt(t).toFixed(2)}x  ${this.scene.rendererKind} ${this.scene.q.name}  draw ${pf.avgMs.toFixed(1)}ms  fps ${pf.fps.toFixed(0)}\n` +
        `particles ${pf.particles}  sprites ${pf.sprites}  decoded ${this.frames.bitmaps.size}`;
    }
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

  bindUi() {
    $('#btnStart').addEventListener('click', () => this.start());
    $('#btnPause').addEventListener('click', () => (this.state === 'paused' ? this.resume() : this.pause()));
    $('#btnRestart').addEventListener('click', () => this.restart());
    $('#btnResultClose').addEventListener('click', () => { $('#result').hidden = true; });
    document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => this.setMode(r.value)));
    const vol = $('#volume');
    vol.value = Number(store.get('kr.volume') ?? 0.8);
    this.clock.setVolume(Number(vol.value));
    vol.addEventListener('input', () => { this.clock.setVolume(Number(vol.value)); store.set('kr.volume', vol.value); });
    const lat = $('#latency');
    lat.value = Math.round(this.inputLatency * 1000);
    lat.addEventListener('change', () => { this.inputLatency = Number(lat.value) / 1000; store.set('kr.inputLatency', lat.value); });
    $('#quality').addEventListener('change', (e) => {
      store.set('kiva.quality', e.target.value);
      this.scene?.setQuality(e.target.value, this.lastT);
      if (this.state !== 'playing') this.render();
    });
    // 限定公開サーバー（認証あり）で配信されているときだけログアウトを表示
    fetch('/__auth/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((me) => {
      if (me?.user) { $('#logout').hidden = false; $('#who').textContent = me.user; }
    }).catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause('タブが非表示になりました'); });
    window.addEventListener('pagehide', () => this.pause('ページ離脱'));
    window.addEventListener('keydown', (e) => {
      if (e.target?.closest?.('input, select, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); if (this.state === 'playing') this.pause(); else if (this.state === 'paused') this.resume(); else this.start(); }
      if (e.code === 'KeyR' && !e.repeat) this.restart();
    });
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
