// KIVA THE KARATE — セーパイ 2D（背景透過の実写連続画像）。
// 読み込み → 再生（共通の再生時計）→ 入力 → 判定 → 描画（背景・人物・エフェクト・レーン）。

import { TimelineClock } from './clock.js';
import { Judge } from './judge.js';
import { AutoPlayer } from './auto.js';
import { Input } from './input.js';
import { FrameStore } from './frames.js';
import { Effects } from './fx.js';
import { LaneRenderer, drawSequence, LANE_STYLE } from './lanes.js';
import { Sfx } from './sfx.js';
import { BACKGROUNDS, orientationOf, containRect, laneRect, standingHeight, subjectTransform } from './layout.js';
import { normalizeChart, validateChart, BUTTON_INFO } from './chart.js';
import { Editor } from './editor.js';

const $ = (s) => document.querySelector(s);
const AUTOSAVE_KEY = 'kiva2d.chart.autosave.v1';
const PREFS_KEY = 'kiva2d.prefs.v1';
// 旧 3D 版の保存設定（表示モード・画質など）。新しい 2D 版では使わないので消す
const LEGACY_KEYS = ['kiva.quality', 'kiva.displayMode', 'kiva.character', 'kiva.padProfiles.v1', 'kr.inputLatency', 'kr.volume'];

export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

async function fetchJson(url, what) {
  let r;
  try { r = await fetch(url, { cache: 'no-cache' }); } catch (e) { throw new Error(`${what}を読み込めません: ${url}\n${e.message}`); }
  if (!r.ok) throw new Error(`${what}を読み込めません（HTTP ${r.status}）: ${url}${r.status === 404 ? '\nREADME「素材の配置」を参照してください。' : ''}`);
  try { return await r.json(); } catch (e) { throw new Error(`${what}の JSON が壊れています: ${url}\n${e.message}`); }
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(`背景画像を読み込めません: ${src}`));
    im.src = src;
  });
}

export class App {
  constructor() {
    this.params = new URLSearchParams(location.search);
    this.state = 'loading';
    this.autoMode = this.params.get('auto') === '1';
    this.editMode = false;
    this.loop = { a: null, b: null, on: false };
    this.generation = 0;
    this.lastT = 0;
    this.prefs = { volume: 0.8, sfx: 0.6, fxStrength: 1, lowFx: false, ...JSON.parse(store.get(PREFS_KEY) || '{}') };
    for (const k of LEGACY_KEYS) store.del(k);
    this.canvas = $('#stage');
    this.ctx = this.canvas.getContext('2d');
    this.lanes = new LaneRenderer();
    this.fx = new Effects();
    this.fx.setQuality({ low: this.prefs.lowFx || this.params.has('low'), strength: this.prefs.fxStrength });
    this.input = new Input();
    this.held = { Y: false, X: false, A: false, B: false };
    this.flash = { Y: -9, X: -9, A: -9, B: -9 };
    this.log = [];
    window.__app = this;
  }

  status(msg, kind = 'info') {
    const el = $('#status');
    el.textContent = msg;
    el.dataset.kind = kind;
    (kind === 'error' ? console.error : console.info)(msg);
  }

  progress(p, msg) {
    $('#loading').hidden = p >= 1;
    $('#loadBar').style.width = `${Math.round(p * 100)}%`;
    if (msg) $('#loadMsg').textContent = msg;
  }

  // ---------- 読み込み ----------
  async load() {
    try {
      this.progress(0, '譜面を読み込み中…');
      const chartUrl = new URL(this.params.get('chart') || 'charts/seipai.json', location.href).href;
      const initial = await fetchJson(chartUrl, '初期譜面');
      const v0 = validateChart(initial);
      if (v0.errors.length) throw new Error('初期譜面にエラーがあります:\n' + v0.errors.join('\n'));
      this.initialChart = normalizeChart(initial);
      const manifestUrl = new URL(this.initialChart.source.frameManifest, location.href).href;
      this.progress(0.02, '画像の一覧を読み込み中…');
      this.manifest = await fetchJson(manifestUrl, '連続画像の一覧（manifest.json）');
      if (this.manifest.frameCount !== this.initialChart.source.frameCount) {
        throw new Error(`連続画像の枚数が譜面と一致しません（画像 ${this.manifest.frameCount} 枚、譜面 ${this.initialChart.source.frameCount} 枚）`);
      }
      this.duration = this.manifest.durationSeconds || this.initialChart.source.durationSeconds;
      // 自動保存された編集内容があれば復元（壊れていれば初期譜面）
      let chart = this.initialChart, restored = false;
      const saved = store.get(AUTOSAVE_KEY);
      if (saved && !this.params.has('fresh')) {
        try {
          const obj = JSON.parse(saved);
          const v = validateChart(obj, { frameCount: this.manifest.frameCount });
          if (!v.errors.length) { chart = normalizeChart(obj); restored = true; }
        } catch { /* 初期譜面を使う */ }
      }
      this.chart = chart;
      this.clock = new TimelineClock({ duration: this.duration });
      this.clock.volume = this.prefs.volume;
      this.sfx = new Sfx(this.clock);
      this.sfx.volume = this.prefs.sfx;
      const bgP = Promise.all([loadImage(BACKGROUNDS.landscape.src), loadImage(BACKGROUNDS.portrait.src)]);
      this.store = new FrameStore(this.manifest, manifestUrl);
      const framesP = this.store.fetchAll((d, n) => this.progress(0.05 + 0.85 * d / n, `人物画像を読み込み中… ${d}/${n}`));
      const audioP = this.loadAudio();
      [this.bgImages] = await Promise.all([bgP, framesP]);
      this.progress(0.93, '音声を準備中…');
      this.audioNote = await audioP;
      await this.store.warm(0);
      this.progress(1);
      this.setup();
      this.state = 'ready';
      this.clock.stop(-this.chart.settings.leadInSeconds);
      this.newJudge(this.clock.position());
      const stand = this.manifest.standIn ? ' ／ 人物画像はローカル試験用の代用素材です（提供 ZIP が未配置）' : '';
      this.status(`準備完了: ノーツ ${this.chart.notes.length}、画像 ${this.store.count} 枚（0.2 秒間隔）。${this.audioNote}${restored ? ' ／ 自動保存した編集内容を復元しました' : ''}${stand}`, 'ok');
      this.updateUi();
    } catch (e) {
      this.state = 'error';
      this.progress(1);
      this.status(e.message, 'error');
      $('#loadError').hidden = false;
      $('#loadError').textContent = e.message;
    }
  }

  /** 音源の候補を順に試し、このブラウザでデコードできた最初のものを使う（AAC → Opus など） */
  async loadAudio() {
    const src = this.chart.audio?.src;
    const list = Array.isArray(src) ? src : src ? [src] : [];
    if (!list.length) return '音源なし（効果音のみ）';
    const errs = [];
    for (const one of list) {
      try {
        const r = await fetch(new URL(one, location.href).href);
        if (!r.ok) { errs.push(`${one}: HTTP ${r.status}`); continue; }
        await this.clock.loadAudio(await r.arrayBuffer(), this.chart.audio.startAtTimelineSeconds || 0);
        this.audioSrc = one;
        return `音源: ${one}`;
      } catch (e) { errs.push(`${one}: ${e.message.split('\n')[0]}`); }
    }
    return `音源を使えません（${errs.join(' ／ ')}）。効果音のみで進行します`;
  }

  setup() {
    // 入力
    const pads = {};
    document.querySelectorAll('#pad [data-b]').forEach((el) => { pads[el.dataset.b] = el; });
    this.padEls = pads;
    this.input.onPress = (b, perfMs, o) => this.onPress(b, perfMs, o);
    this.input.onRelease = (b, perfMs, o) => this.onRelease(b, perfMs, o);
    this.input.attachKeyboard();
    this.input.attachButtons(pads);
    // 画面
    this.resize();
    new ResizeObserver(() => this.resize()).observe($('#stageWrap'));
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
    window.addEventListener('pagehide', () => this.pause());
    this.editor = new Editor(this, $('#editor'));
    this.bindUi();
    this.raf();
  }

  // ---------- 再生 ----------
  get t() { return this.clock ? this.clock.position() : 0; }

  newJudge(t) {
    this.generation++;
    this.judge = new Judge(this.chart.notes, this.chart.settings);
    this.judge.on((e) => this.onJudge(e));
    this.judge.resetFrom(t);
    this.auto = this.autoMode ? new AutoPlayer(this.judge, { generation: this.generation }) : null;
    if (this.auto) {
      this.auto.reset(t);
      this.auto.onPress = (b) => { this.flash[b] = this.t; this.held[b] = true; };
      this.auto.onRelease = (b) => { this.held[b] = false; };
    }
    this.fx.clear();
    this.lanes.clear();
    this.sfx?.breathStop();
  }

  /** 譜面を編集したとき: 現在位置から判定し直す（同じノーツの二重加点なし） */
  chartChanged() {
    if (!this.judge) return;
    const t = this.t;
    this.newJudge(t);
  }

  async play() {
    if (this.state === 'loading' || this.state === 'error') return;
    await this.clock.unlock();
    if (this.state === 'playing') return;
    if (this.state === 'ready' || this.state === 'ended') {
      const from = this.loop.on && this.loop.a != null ? this.loop.a : -this.chart.settings.leadInSeconds;
      this.clock.stop(from);
      this.newJudge(from);
      this.log = [];
      $('#result').hidden = true;
    }
    this.input.releaseAll();
    this.clock.play(this.clock.position());
    this.state = 'playing';
    this.updateUi();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.clock.pause();
    this.sfx?.breathStop();
    this.state = 'paused';
    this.updateUi();
  }

  togglePlay() { if (this.state === 'playing') this.pause(); else this.play(); }

  retry() {
    if (!this.clock) return;
    const from = this.loop.on && this.loop.a != null ? this.loop.a : -this.chart.settings.leadInSeconds;
    const wasPlaying = this.state === 'playing';
    this.clock.stop(from);
    this.newJudge(from);
    this.log = [];
    $('#result').hidden = true;
    this.state = 'ready';
    if (wasPlaying || !this.editMode) this.play(); else this.updateUi();
  }

  /** シーク（画像・ノーツ・音声を同じ時刻へ。判定状態とエフェクトを初期化） */
  seek(t) {
    if (!this.clock) return;
    const to = Math.max(-this.chart.settings.leadInSeconds, Math.min(t, this.duration));
    this.clock.seek(to);
    this.newJudge(to);
    if (this.state === 'ended') this.state = 'paused';
    if (this.state === 'ready') this.state = 'paused';
    this.updateUi();
  }

  setRate(r) {
    this.clock?.setRate(r);
    $('#speed').value = String(r);
    this.editor?.syncRate(r);
  }

  setAuto(on) {
    this.autoMode = on;
    if (this.judge) {
      // 切替時: 押しっぱなしの長押しは成績に数えず、過去のノーツはまとめて成立させない
      this.judge.cancelHolds();
      this.sfx?.breathStop();
      const t = this.t;
      this.auto = on ? new AutoPlayer(this.judge, { generation: ++this.generation }) : null;
      if (this.auto) {
        this.auto.reset(t);
        this.auto.onPress = (b) => { this.flash[b] = this.t; this.held[b] = true; };
        this.auto.onRelease = (b) => { this.held[b] = false; };
      }
      for (const b of Object.keys(this.held)) this.held[b] = this.input.isDown(b);
      this.usedAuto = this.usedAuto || on;
    }
    this.updateUi();
  }

  finish() {
    this.state = 'ended';
    this.clock.pause();
    this.sfx?.breathStop();
    const s = this.judge.summary();
    const auto = this.autoMode || this.usedAuto;
    const rec = { auto, ...s, at: new Date().toISOString() };
    window.__lastResult = { ...rec, log: this.log };
    if (!auto) {
      const best = JSON.parse(store.get('kiva2d.best.manual') || 'null');
      if (!best || s.score > best.score) store.set('kiva2d.best.manual', JSON.stringify(rec));
    }
    $('#resultTitle').textContent = auto ? 'AUTO 再生の記録（手動プレイの成績には含めません）' : '結果';
    $('#resultBody').innerHTML = `<dl>
      <dt>達成率</dt><dd>${(s.achievement * 100).toFixed(1)}%</dd>
      <dt>スコア</dt><dd>${s.score.toLocaleString()}</dd>
      <dt>最大コンボ</dt><dd>${s.maxCombo}</dd>
      <dt>PERFECT / GOOD / MISS</dt><dd>${s.perfect} / ${s.good} / ${s.miss}</dd>
      ${s.skip ? `<dt>対象外（シークで飛ばした）</dt><dd>${s.skip}</dd>` : ''}</dl>
      <p class="note">入力タイミングの成績です。空手の技能評価ではありません。</p>`;
    $('#result').hidden = false;
    this.updateUi();
  }

  // ---------- 入力と判定 ----------
  onPress(b, perfMs, o) {
    this.held[b] = true;
    if (this.state !== 'playing') { this.flash[b] = this.t; return; }
    this.flash[b] = this.clock.position(perfMs);
    if (this.autoMode) return; // AUTO 中の手動入力は成績に混ぜない
    const t = this.clock.position(perfMs) - this.chart.settings.inputOffsetMs / 1000;
    this.judge.press(b, t, { id: o.id, source: o.source });
  }

  onRelease(b, perfMs, o) {
    this.held[b] = false;
    if (this.state !== 'playing' || this.autoMode) return;
    const t = this.clock.position(perfMs) - this.chart.settings.inputOffsetMs / 1000;
    this.judge.release(b, t, { source: o.source });
  }

  onJudge(e) {
    if (e.type === 'stray') { this.lanes.mark('—', this.t, e.button); return; }
    const n = e.note, src = n.src;
    if (e.type === 'holdStart') { this.sfx.breathStart(); return; }
    if (n.input === 'hold') this.sfx.breathStop();
    this.log.push({ id: n.id, time: n.time, grade: e.grade, delta: n.delta, source: e.source, reason: e.reason });
    const shownAt = e.grade === 'MISS' ? this.t : Math.min(this.t, e.time ?? this.t);
    this.lanes.mark(e.grade, Math.max(shownAt, this.t - 0.05), n.button, n.delta);
    if (e.grade === 'MISS') { this.sfx.miss(); return; }
    // 成功: エフェクトは「ノーツの時刻のコマ」の拳・足の位置から
    const kind = { Y: 'breath', X: 'stance', A: 'strike', B: 'turn' }[n.button];
    const ef = src.effect || {};
    const frameIndex = this.store.indexAt(Math.max(0, n.time));
    this.fx.trigger(kind, {
      t: this.t, grade: e.grade, frameIndex, action: src.action, anchor: ef.anchor, direction: ef.direction,
      intensity: ef.intensity ?? 1, seed: this.generation * 101 + this.judge.notes.indexOf(n),
    });
    this.sfx.play(src.action === 'kick' ? 'kick' : kind, e.grade);
  }

  // ---------- 描画 ----------
  resize() {
    const wrap = $('#stageWrap');
    const r = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    // 向きは表示領域（ウィンドウ）の縦横比で決める
    this.orient = orientationOf(window.innerWidth, window.innerHeight);
    document.documentElement.dataset.orient = this.orient;
  }

  geometry() {
    const bgDef = BACKGROUNDS[this.orient];
    const bg = containRect(this.cssW, this.cssH, bgDef.w, bgDef.h);
    const L = laneRect(bg);
    const standH = standingHeight(bg, L, this.chart.display, this.manifest.fitExtents || this.manifest.extents);
    return { bgDef, bg, L, standH };
  }

  transformFor(i, G = this.geometry()) {
    return subjectTransform(this.store.frames[i], G.bg, G.standH, this.chart.display);
  }

  raf() {
    const tick = () => {
      try { this.frame(); } catch (e) { console.error(e); this.status(`描画エラー: ${e.message}`, 'error'); }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  frame() {
    if (!this.clock) return;
    this.input.pollGamepads();
    let t = this.t;
    if (this.state === 'playing') {
      if (this.loop.on && this.loop.a != null && this.loop.b != null && t >= this.loop.b) {
        this.seek(this.loop.a);
        t = this.t;
      }
      this.auto?.update(t);
      this.judge.update(t);
      if (t >= this.duration - 1e-3) { this.finish(); t = this.duration; }
    }
    this.lastT = t;
    this.draw(t);
    this.editor?.tick(t);
  }

  draw(t) {
    const ctx = this.ctx, dpr = this.dpr;
    const G = this.geometry();
    const { bg, L, standH, bgDef } = G;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = bgDef.letterbox;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const img = this.bgImages[this.orient === 'landscape' ? 0 : 1];
    ctx.drawImage(img, bg.x, bg.y, bg.w, bg.h);
    // 人物
    const fi = this.store.indexAt(Math.max(0, t));
    this.store.prefetch(fi);
    const S = { t, store: this.store, frameIndex: fi, transformFor: (i) => this.transformFor(i, G), standH, canvas: this.canvas, dpr };
    this.fx.renderUnder(ctx, S);
    const g = this.store.get(fi);
    let shown = null;
    if (g) {
      const r = this.transformFor(g.index, G).crop();
      ctx.drawImage(g.bmp, r.x, r.y, r.w, r.h);
      shown = g.index;
    }
    // 長押し中の呼吸
    const holding = this.judge?.notes.find((n) => n.holding);
    if (holding) this.fx.renderHold(ctx, S, this.judge.holdProgress(holding, t));
    this.fx.renderOver(ctx, S);
    // レーン・連続コマンド・HUD
    const held = {};
    for (const b of ['Y', 'X', 'A', 'B']) held[b] = this.held[b] || t - this.flash[b] < 0.08;
    const lanesInfo = this.lanes.draw(ctx, L, t, this.judge ? this.judge.notes : [], {
      lead: this.chart.settings.laneLeadSeconds, held, selected: this.editor?.selected,
    });
    drawSequence(ctx, bg, L, t, this.judge, this.chart.sequences);
    for (const b of ['Y', 'X', 'A', 'B']) if (this.padEls[b].classList.contains('down') !== held[b]) this.padEls[b].classList.toggle('down', held[b]);
    this.drawHud(ctx, G, t, fi);
    this.editor?.drawOverlay(ctx, G, t, fi);
    window.__debug = {
      t, frame: fi, shown, state: this.state, orient: this.orient, bg, lanes: L, standH, lanesInfo: { jx: lanesInfo.jx },
      subject: g ? this.transformFor(g.index, G).crop() : null, anchor: g ? [this.transformFor(g.index, G).ox, this.transformFor(g.index, G).oy] : null,
      decoded: this.store.bitmaps.size, fx: this.fx.stats, auto: this.autoMode, rate: this.clock.rate,
    };
  }

  drawHud(ctx, G, t, fi) {
    const { bg } = G;
    const s = this.judge?.summary();
    const fs = Math.max(12, Math.min(20, bg.h * 0.032));
    ctx.save();
    ctx.font = `700 ${fs}px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif`;
    ctx.textBaseline = 'bottom';
    const pad = 8, y = bg.y + bg.h - pad;
    const txt = `SCORE ${s ? s.score.toLocaleString() : 0}   COMBO ${s ? s.combo : 0}`;
    ctx.fillStyle = 'rgba(10,6,4,0.55)';
    const w = ctx.measureText(txt).width;
    ctx.fillRect(bg.x + pad - 4, y - fs - 6, w + 8, fs + 8);
    ctx.fillStyle = '#fff3dc';
    ctx.fillText(txt, bg.x + pad, y);
    // AUTO 表示（はっきり分かるように）
    if (this.autoMode) {
      const label = 'AUTO 再生中';
      const lw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(255,90,60,0.85)';
      ctx.fillRect(bg.x + bg.w - pad - lw - 12, y - fs - 6, lw + 12, fs + 8);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, bg.x + bg.w - pad - lw - 6, y);
    }
    // 開始前の待ち時間
    if (t < 0 && this.state === 'playing') {
      ctx.font = `800 ${Math.round(bg.h * 0.09)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,240,210,0.9)';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4;
      const c = Math.ceil(-t);
      ctx.strokeText(String(c), bg.x + bg.w / 2, bg.y + bg.h * 0.62);
      ctx.fillText(String(c), bg.x + bg.w / 2, bg.y + bg.h * 0.62);
    }
    if (this.state === 'paused' || this.state === 'ready') {
      ctx.font = `600 ${Math.round(fs * 0.85)}px system-ui, sans-serif`;
      ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(255,240,220,0.85)';
      const L = G.L;
      ctx.fillText(`${Math.max(0, t).toFixed(2)} 秒 ／ コマ ${fi}${this.state === 'paused' ? ' ／ 一時停止中' : ''}`, bg.x + bg.w - 10, L.y + L.h + 6 + (this.editMode ? 0 : fs * 2.2));
    }
    ctx.restore();
  }

  // ---------- UI ----------
  updateUi() {
    const st = this.state;
    const playBtn = $('#btnPlay');
    playBtn.textContent = st === 'playing' ? '❚❚ 一時停止' : st === 'paused' ? '▶ 再開' : '▶ 開始';
    playBtn.disabled = st === 'loading' || st === 'error';
    $('#btnRetry').disabled = st === 'loading' || st === 'error';
    $('#btnAuto').setAttribute('aria-pressed', String(this.autoMode));
    $('#btnEdit').setAttribute('aria-pressed', String(this.editMode));
    document.documentElement.dataset.state = st;
    document.documentElement.dataset.auto = String(this.autoMode);
    document.documentElement.dataset.edit = String(this.editMode);
    this.editor?.syncState();
  }

  savePrefs() { store.set(PREFS_KEY, JSON.stringify(this.prefs)); }

  bindUi() {
    $('#btnPlay').addEventListener('click', () => this.togglePlay());
    $('#btnRetry').addEventListener('click', () => this.retry());
    $('#btnAuto').addEventListener('click', () => this.setAuto(!this.autoMode));
    $('#btnEdit').addEventListener('click', () => this.setEdit(!this.editMode));
    $('#speed').addEventListener('change', (e) => this.setRate(Number(e.target.value)));
    $('#btnResultClose').addEventListener('click', () => { $('#result').hidden = true; });
    const s = this.chart.settings;
    const bindNum = (sel, get, set) => {
      const el = $(sel);
      el.value = get();
      el.addEventListener('change', () => {
        const v = Number(el.value);
        if (!Number.isFinite(v)) { el.value = get(); return; }
        set(v);
      });
    };
    bindNum('#volume', () => this.prefs.volume, (v) => { this.prefs.volume = v; this.clock.setVolume(v); this.savePrefs(); });
    $('#volume').addEventListener('input', (e) => this.clock.setVolume(Number(e.target.value)));
    bindNum('#sfxVolume', () => this.prefs.sfx, (v) => { this.prefs.sfx = v; this.sfx.volume = v; this.savePrefs(); });
    bindNum('#fxStrength', () => this.prefs.fxStrength, (v) => { this.prefs.fxStrength = v; this.fx.setQuality({ strength: v }); this.savePrefs(); });
    const low = $('#lowFx');
    low.checked = this.fx.low;
    low.addEventListener('change', () => { this.prefs.lowFx = low.checked; this.fx.setQuality({ low: low.checked }); this.savePrefs(); });
    // 譜面に保存する設定（JSON に入る）
    const chartNum = (sel, key, min, max) => bindNum(sel, () => this.chart.settings[key], (v) => {
      const val = Math.max(min, Math.min(max, v));
      this.editor.apply((c) => { c.settings[key] = val; }, `設定 ${key}`);
    });
    chartNum('#inputOffset', 'inputOffsetMs', -300, 300);
    chartNum('#winPerfect', 'perfectWindowMs', 10, 200);
    chartNum('#winGood', 'goodWindowMs', 20, 300);
    chartNum('#winMiss', 'missWindowMs', 30, 400);
    chartNum('#winRelease', 'holdReleaseWindowMs', 0, 500);
    void s;
    window.addEventListener('keydown', (e) => {
      if (e.target?.closest?.('input, select, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
      else if (e.code === 'KeyR' && !e.repeat && !e.ctrlKey && !e.metaKey) this.retry();
    });
  }

  syncSettingsUi() {
    for (const [sel, key] of [['#inputOffset', 'inputOffsetMs'], ['#winPerfect', 'perfectWindowMs'], ['#winGood', 'goodWindowMs'], ['#winMiss', 'missWindowMs'], ['#winRelease', 'holdReleaseWindowMs']]) {
      $(sel).value = this.chart.settings[key];
    }
  }

  setEdit(on) {
    this.editMode = on;
    if (on) this.pause();
    this.editor.setOpen(on);
    this.updateUi();
    requestAnimationFrame(() => this.resize());
  }
}

export { LANE_STYLE, BUTTON_INFO };

const app = new App();
app.load();
