// KIVA THE KARATE — セーパイ 2D（背景透過の実写連続画像）。
// 読み込み → 再生（共通の再生時計）→ 入力 → 判定 → 描画（背景・人物・エフェクト・レーン）。

import { TimelineClock } from './clock.js';
import { Judge } from './judge.js';
import { AutoPlayer } from './auto.js';
import { Input } from './input.js';
import { FrameStore } from './frames.js';
import { Effects } from './fx.js';
import { LaneRenderer, LANE_STYLE } from './lanes.js';
import { Sfx, SFX_MIX_GAIN } from './sfx.js';
import { BACKGROUNDS, orientationOf, containRect, coverRect, laneRect, standingHeight, landscapeSubject, subjectTransform } from './layout.js';
import { normalizeChart, validateChart, BUTTON_INFO } from './chart.js';
import { Editor } from './editor.js';
import { GAME } from './config.js';

const $ = (s) => document.querySelector(s);
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
    // バージョン（素材・譜面・音声の組）。保存先もバージョンごと
    // 正式版だけ。旧 URL のバージョン指定（?v=v1 / ?v=v2）は無視して正式版を開く
    this.ver = GAME;
    this.version = GAME.gameVersion;
    this.keys = GAME.keys;
    this.legacyVersionParam = this.params.get('v');
    if (this.legacyVersionParam != null) {
      const u = new URL(location.href);
      u.searchParams.delete('v');
      try { history.replaceState(null, '', u.href); } catch { /* 表示だけ */ }
    }
    // BGM のあるバージョン（ver2）: BGM の選択と 3 系統の音量はバージョンごとに保存
    this.mixMode = !!this.ver.bgm;
    document.documentElement.dataset.mix = String(this.mixMode);
    if (this.mixMode) {
      let saved = {};
      try { saved = JSON.parse(store.get(this.keys.audio) || '{}') || {}; } catch { saved = {}; }
      this.audioPrefs = {
        bgm: this.ver.bgm.some((t) => t.id === saved.bgm) ? saved.bgm : this.ver.defaultBgm,
        levels: { ...this.ver.defaultLevels, ...(saved.levels || {}) },
        mutes: { voice: false, bgm: false, sfx: false, ...(saved.mutes || {}) },
      };
    }
    this.bgmState = null;
    this._bgmToken = 0;
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
      const chartUrl = new URL(this.params.get('chart') || this.ver.chart, location.href).href;
      const initial = await fetchJson(chartUrl, '初期譜面');
      const v0 = validateChart(initial, { gameVersion: this.version });
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
      const saved = store.get(this.keys.autosave);
      if (saved && !this.params.has('fresh')) {
        try {
          const obj = JSON.parse(saved);
          const v = validateChart(obj, { frameCount: this.manifest.frameCount, gameVersion: this.version });
          if (!v.errors.length) { chart = normalizeChart(obj); restored = true; }
        } catch { /* 初期譜面を使う */ }
      }
      this.chart = chart;
      this.clock = new TimelineClock({ duration: this.duration, mix: this.mixMode });
      this.clock.volume = this.prefs.volume;
      this.sfx = new Sfx(this.clock);
      this.sfx.volume = this.prefs.sfx;
      if (this.mixMode) {
        Object.assign(this.clock.levels, this.audioPrefs.levels);
        Object.assign(this.clock.mutes, this.audioPrefs.mutes);
        this.sfx.volume = SFX_MIX_GAIN; // 効果音の大きさは効果音の系統（音量・ミュート）で決める
      }
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
      if (this.mixMode) this.loadBgmTrack(this.audioPrefs.bgm); // 読み込み終わるまで開始ボタンは押せない
      const legacy = /^(ver|v)?\s*1$/i.test(this.legacyVersionParam ?? '') ? 'ver1 は終了しました。正式版で開いています。' : '';
      this.status(`${legacy}準備完了: ノーツ ${this.chart.notes.length}、画像 ${this.store.count} 枚（0〜${this.duration.toFixed(1)} 秒）。${this.audioNote}${restored ? ' ／ 自動保存した編集内容を復元しました' : ''}${stand}`, 'ok');
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
        this.audio = {
          file: one.split('/').pop(),
          codec: /opus/i.test(one) ? 'Opus（予備。このブラウザは AAC をデコードできませんでした）' : /\.(m4a|aac|mp4)$/i.test(one) ? 'AAC' : '不明',
          skipped: errs.slice(), state: 'loaded', reason: '', signal: null,
        };
        this.renderAudioInfo();
        return `音源: ${one}`;
      } catch (e) { errs.push(`${one}: ${e.message.split('\n')[0]}`); }
    }
    this.audio = { file: null, codec: '', skipped: errs, state: 'none', reason: errs.join(' ／ '), signal: null };
    this.renderAudioInfo();
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
    this.breathTailUntil = null;
  }

  /** 譜面を編集したとき: 現在位置から判定し直す（同じノーツの二重加点なし） */
  chartChanged() {
    if (!this.judge) return;
    const t = this.t;
    this.newJudge(t);
  }

  get needsBgm() { return this.mixMode && (this.state === 'ready' || this.state === 'ended') && this.bgmState?.status !== 'ready'; }

  async play() {
    if (this.state === 'loading' || this.state === 'error') return;
    if (this.needsBgm) {
      this.status(this.bgmState?.status === 'error' ? `BGM「${this.bgmState.label}」を読み込めませんでした。「再試行」を押してください` : `BGM「${this.bgmState?.label ?? ''}」を読み込み中です。読み込み後に開始できます`, 'error');
      return;
    }
    const audioOk = await this.clock.unlock();
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
    this.afterAudioStart(audioOk);
    this.updateUi();
  }

  /**
   * 再生開始後の音声の状態。音声ファイルがあるのに AudioContext が動いていない場合は「再生中」とせず、
   * 理由と「音声を再試行」ボタンを出す（ゲームは時計だけで進む）。出力信号は frame() で確認する。
   */
  afterAudioStart(ok) {
    const a = this.audio;
    if (!a || a.state === 'none') return;
    a.signal = null; a.signalPeak = 0; a.signalSince = null;
    if (ok && this.clock._audioMode) { a.state = 'playing'; a.reason = ''; }
    else {
      a.state = 'failed';
      a.reason = this.clock.lastError || `AudioContext: ${this.clock.ctx?.state ?? 'なし'}`;
      this.status(`音声を開始できませんでした（${a.reason}）。操作パネルの「🔈 音声を再試行」を押してください（ゲームは音なしで進行中）`, 'error');
    }
    this.renderAudioInfo();
  }

  async retryAudio() {
    const ok = await this.clock.unlock();
    if (ok && this.state === 'playing' && !this.clock._audioMode) this.clock.play(this.clock.position()); // 同じ位置のまま音声の時計へ
    if (this.state === 'playing') this.afterAudioStart(ok);
    else if (this.audio) { this.audio.state = ok ? 'loaded' : 'failed'; this.audio.reason = ok ? '' : this.clock.lastError; this.renderAudioInfo(); }
    if (ok) this.status('音声を有効にしました', 'ok');
  }

  /** 再生中、音楽の出力に信号が出ているかを確かめる（0.6 秒以上、音のある区間で） */
  checkAudioSignal(t) {
    const a = this.audio;
    if (!a || a.state !== 'playing' || this.state !== 'playing' || !this.clock._audioMode) return;
    const pos = t - this.clock.audioStart;
    if (pos < 0.5 || pos > this.clock.buffer.duration - 0.5) return;
    const now = performance.now();
    a.signalSince ??= now;
    if (this.mixMode && this.clock.mutes.voice && (this.clock.mutes.bgm || !this.clock.bgm)) return; // すべてミュート中は判定しない
    a.signalPeak = Math.max(a.signalPeak || 0, this.clock.outputLevel() + (this.mixMode ? this.clock.bgmLevel() : 0));
    if (now - a.signalSince > 600) {
      const sig = a.signalPeak > 1e-4;
      if (sig !== a.signal) { a.signal = sig; this.renderAudioInfo(); }
      a.signalSince = now; a.signalPeak = 0;
    }
  }

  renderAudioInfo() {
    const a = this.audio, info = $('#audioInfo'), btn = $('#btnAudio');
    if (!a) return;
    const ctxState = this.clock?.ctx?.state ?? 'なし';
    const sess = navigator.audioSession ? navigator.audioSession.type : '未対応';
    const file = a.file ? `${a.file}（${a.codec}）` : '音声ファイルなし';
    const head = {
      none: `音声なし: ${a.reason}`,
      loaded: `音声: ${file} 読み込み済み（未再生）`,
      paused: `音声: ${file} 一時停止中`,
      failed: `音声を再生できていません: ${file} ／ 理由: ${a.reason}`,
      playing: a.signal === false ? `音声: ${file} 再生処理中ですが出力信号がありません` : a.signal ? `再生中の音声: ${file} ／ 出力信号あり` : `音声: ${file} 再生開始（出力を確認中）`,
    }[a.state];
    info.textContent = `${head} ／ AudioContext: ${ctxState} ／ 音声セッション: ${sess}${a.skipped?.length ? ` ／ 先に試して失敗: ${a.skipped.join(' ／ ')}` : ''}`;
    info.dataset.state = a.state;
    btn.hidden = a.state !== 'failed';
  }

  pause() {
    if (this.state !== 'playing') return;
    this.clock.pause();
    if (this.audio?.state === 'playing') { this.audio.state = 'paused'; this.renderAudioInfo(); }
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
    const rec = { auto, ...s, gameVersion: this.version, at: new Date().toISOString() };
    window.__lastResult = { ...rec, log: this.log };
    if (!auto) {
      const best = JSON.parse(store.get(this.keys.best) || 'null');
      if (!best || s.score > best.score) store.set(this.keys.best, JSON.stringify(rec));
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
    // 効果音を先に鳴らし、その最も強い瞬間が聞こえる時刻（時間軸）に演出の山を合わせる。判定と画像の再生は止めない
    const peakCtx = this.sfx.play(src.action === 'kick' ? 'kick' : kind, e.grade, { pan: kind === 'turn' ? this.turnDirection(frameIndex) : 0 });
    const peakT = peakCtx != null ? this.clock.timelineAtCtx(peakCtx) : null;
    const t0 = peakT != null && peakT >= this.t && peakT < this.t + 0.2 ? peakT : this.t;
    if (kind === 'breath') this.breathTailUntil = t0;
    this.fx.trigger(kind, {
      t: t0, grade: e.grade, frameIndex, action: src.action, anchor: ef.anchor, direction: ef.direction,
      intensity: ef.intensity ?? 1, seed: this.generation * 101 + this.judge.notes.indexOf(n),
    });
  }

  /** 旋回の向き（画面の左へ回る -1 ／ 右へ 1）: 前後のコマで、鼻が肩の中心に対して動く向き */
  turnDirection(i) {
    const F = this.store.frames, a = F[Math.max(0, i - 2)]?.joints, b = F[Math.min(F.length - 1, i + 2)]?.joints;
    if (!a || !b || !a.nose || !b.nose) return 1;
    const rel = (j) => j.nose[0] - (j.left_shoulder[0] + j.right_shoulder[0]) / 2;
    return rel(b) - rel(a) < 0 ? -1 : 1;
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
    // 設定の小窓を操作パネルのすぐ上に出すため（パネルの中に入れるとスクロール領域で切れる）
    document.documentElement.style.setProperty('--panel-h', `${Math.round($('#panel').getBoundingClientRect().height)}px`);
    // ノッチ（安全域）の幅。横向きのレーン・HUD をその内側に置く
    const cs = getComputedStyle($('#safeProbe'));
    this.safe = { l: parseFloat(cs.paddingLeft) || 0, r: parseFloat(cs.paddingRight) || 0 };
  }

  /**
   * 画面配置。縦向き: 背景全体を収め（contain）、その矩形を基準にレーン・人物を置く（従来どおり）。
   * 横向き: 背景は表示領域を余白なく埋め（cover、上下左右は切れてよい）、レーン・人物・HUD は
   * 表示領域（ノッチの安全域を除く）を基準にする。人物は背景とは別の前景で、全コマ共通の大きさ。
   */
  geometry() {
    const bgDef = BACKGROUNDS[this.orient];
    const ext = this.manifest.fitExtents || this.manifest.extents;
    if (this.orient === 'landscape') {
      const bgDraw = coverRect(this.cssW, this.cssH, bgDef.w, bgDef.h);
      const sl = this.safe?.l || 0, sr = this.safe?.r || 0;
      const bg = { x: sl, y: 0, w: this.cssW - sl - sr, h: this.cssH };
      const L = laneRect(bg, { compact: true });
      L.panelAlpha = 0.42;
      const { standH, anchor } = landscapeSubject({ x: 0, y: 0, w: this.cssW, h: this.cssH }, this.chart.display, ext);
      return { bgDef, bg, bgDraw, L, standH, anchor };
    }
    const bg = containRect(this.cssW, this.cssH, bgDef.w, bgDef.h);
    const L = laneRect(bg);
    const standH = standingHeight(bg, L, this.chart.display, ext);
    return { bgDef, bg, bgDraw: bg, L, standH, anchor: null };
  }

  transformFor(i, G = this.geometry()) {
    return subjectTransform(this.store.frames[i], G.bg, G.standH, this.chart.display, G.anchor);
  }

  /** コマ i の実際の人物領域（透明余白を除く bbox）の画面上の矩形 */
  visibleBox(i, G = this.geometry()) {
    const T = this.transformFor(i, G), [x, y, w, h] = this.store.frames[i].bbox;
    const [X, Y] = T.toScreen(x, y);
    return { x: X, y: Y, w: w * T.s, h: h * T.s };
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
      this.checkAudioSignal(t);
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
    ctx.drawImage(img, G.bgDraw.x, G.bgDraw.y, G.bgDraw.w, G.bgDraw.h);
    // 表示順（奥 → 手前）: 背景 → レーンの背景・枠 → 人物（とエフェクト） → ノーツ・判定線
    const held = {};
    for (const b of ['Y', 'X', 'A', 'B']) held[b] = this.held[b] || t - this.flash[b] < 0.08;
    this.lanes.drawBack(ctx, L, { held });
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
    if (holding) {
      const hp = this.judge.holdProgress(holding, t);
      this.fx.renderHold(ctx, S, hp);
      if (this.state === 'playing') this.sfx.breathUpdate(hp); // 息の音も進み具合で滑らかに変わる
    } else if (this.breathTailUntil != null && t < this.breathTailUntil) {
      this.fx.renderHold(ctx, S, 1); // 完了の効果音が最も強くなるまで呼吸の光を保つ（途切れずに収束へつなぐ）
    }
    this.fx.renderOver(ctx, S);
    // レーンの手前側（ラベル・判定線・ノーツ・判定）と HUD
    const lanesInfo = this.lanes.draw(ctx, L, t, this.judge ? this.judge.notes : [], {
      lead: this.chart.settings.laneLeadSeconds, held, selected: this.editor?.selected,
    });
    for (const b of ['Y', 'X', 'A', 'B']) if (this.padEls[b].classList.contains('down') !== held[b]) this.padEls[b].classList.toggle('down', held[b]);
    this.drawHud(ctx, G, t, fi);
    this.editor?.drawOverlay(ctx, G, t, fi);
    window.__debug = {
      t, frame: fi, shown, state: this.state, orient: this.orient, bg, lanes: L, standH, lanesInfo: { jx: lanesInfo.jx },
      bgDraw: G.bgDraw, subject: g ? this.transformFor(g.index, G).crop() : null, visible: g ? this.visibleBox(g.index, G) : null, anchor: g ? [this.transformFor(g.index, G).ox, this.transformFor(g.index, G).oy] : null,
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
      ctx.fillText(`${Math.max(0, t).toFixed(2)} 秒 ／ コマ ${fi}${this.state === 'paused' ? ' ／ 一時停止中' : ''}`, bg.x + bg.w - 10, L.y + L.h + 6);
    }
    ctx.restore();
  }

  // ---------- UI ----------
  updateUi() {
    const st = this.state;
    const playBtn = $('#btnPlay');
    playBtn.textContent = st === 'playing' ? '❚❚ 一時停止' : st === 'paused' ? '▶ 再開' : '▶ 開始';
    playBtn.disabled = st === 'loading' || st === 'error' || this.needsBgm;
    this.renderBgm();
    $('#btnRetry').disabled = st === 'loading' || st === 'error';
    $('#btnAuto').setAttribute('aria-pressed', String(this.autoMode));
    $('#btnEdit').setAttribute('aria-pressed', String(this.editMode));
    document.documentElement.dataset.state = st;
    document.documentElement.dataset.auto = String(this.autoMode);
    document.documentElement.dataset.edit = String(this.editMode);
    this.editor?.syncState();
  }

  // ---------- BGM（ver2） ----------
  /** 選んだ曲を読み込む（AAC → 予備の Opus の順に試す）。読み込み中・失敗中は開始できない */
  async loadBgmTrack(id) {
    const t = this.ver.bgm.find((x) => x.id === id) || this.ver.bgm[0];
    const token = ++this._bgmToken;
    this.clock.clearBgm(); // 前の曲は二度と鳴らさない
    this.bgmState = { id: t.id, label: t.label, status: 'loading', error: '', src: null };
    this.updateUi();
    const errs = [];
    for (const src of t.src) {
      try {
        const r = await fetch(new URL(src, location.href).href);
        if (!r.ok) { errs.push(`${src.split('/').pop()}: HTTP ${r.status}`); continue; }
        const buf = await this.clock.decode(await r.arrayBuffer());
        if (token !== this._bgmToken) return; // 読み込み中に別の曲が選ばれた
        this.clock.setBgm(buf, { gain: 10 ** (t.gainDb / 20), fade: 1.5, label: t.label });
        this.bgmState = { ...this.bgmState, status: 'ready', src, codec: /opus/i.test(src) ? 'Opus（予備）' : 'AAC' };
        this.updateUi();
        return;
      } catch (e) {
        if (token !== this._bgmToken) return;
        errs.push(`${src.split('/').pop()}: ${String(e.message).split('\n')[0]}`);
      }
    }
    if (token !== this._bgmToken) return;
    this.bgmState = { ...this.bgmState, status: 'error', error: errs.join(' ／ ') };
    this.updateUi();
  }

  /** 曲を選び直す。再生中は選べない（一時停止中・終了後は先頭に戻してから） */
  chooseBgm(id) {
    if (!this.mixMode || this.state === 'playing' || this.state === 'loading') return;
    if (this.state === 'paused' || this.state === 'ended') {
      const from = -this.chart.settings.leadInSeconds;
      this.clock.stop(from);
      this.newJudge(from);
      this.log = [];
      $('#result').hidden = true;
      this.state = 'ready';
    }
    this.audioPrefs.bgm = id;
    this.saveAudioPrefs();
    this.loadBgmTrack(id);
  }

  saveAudioPrefs() { if (this.mixMode) store.set(this.keys.audio, JSON.stringify(this.audioPrefs)); }

  renderBgm() {
    const panel = $('#bgmPanel');
    if (!this.mixMode) { panel.hidden = true; return; }
    const st = this.state;
    panel.hidden = this.editMode || !(st === 'ready' || st === 'paused' || st === 'ended');
    const b = this.bgmState;
    const sel = $('#bgmSel');
    if (sel.value !== this.audioPrefs.bgm) sel.value = this.audioPrefs.bgm;
    const msg = $('#bgmStatus');
    if (!b) { msg.textContent = ''; return; }
    msg.dataset.kind = b.status === 'error' ? 'error' : '';
    msg.textContent = b.status === 'loading' ? `「${b.label}」を読み込み中…`
      : b.status === 'error' ? `「${b.label}」を読み込めませんでした（${b.error}）`
      : st === 'paused' ? '曲を変えると先頭からになります' : `読み込み済み（${b.codec}）`;
    $('#bgmRetry').hidden = b.status !== 'error';
    const start = $('#bgmStart');
    start.textContent = st === 'paused' ? '▶ 再開' : '▶ 開始';
    start.disabled = this.needsBgm;
  }

  savePrefs() { store.set(PREFS_KEY, JSON.stringify(this.prefs)); }

  bindUi() {
    $('#btnPlay').addEventListener('click', () => this.togglePlay());
    $('#btnAudio').addEventListener('click', () => this.retryAudio());
    window.addEventListener('pagehide', () => this.clock?.shutdown());
    if (this.mixMode) {
      $('#bgmSel').innerHTML = this.ver.bgm.map((t) => `<option value="${t.id}">${t.label}</option>`).join('');
      $('#bgmSel').value = this.audioPrefs.bgm;
      $('#bgmSel').addEventListener('change', (e) => this.chooseBgm(e.target.value));
      $('#bgmRetry').addEventListener('click', () => this.loadBgmTrack(this.audioPrefs.bgm));
      $('#bgmStart').addEventListener('click', () => this.play());
      // 3 系統の音量とミュート
      for (const [k, id, mute] of [['bgm', '#mixBgm', '#muteBgm'], ['voice', '#mixVoice', '#muteVoice'], ['sfx', '#mixSfx', '#muteSfx']]) {
        const el = $(id), m = $(mute);
        el.value = this.audioPrefs.levels[k];
        m.checked = this.audioPrefs.mutes[k];
        el.addEventListener('input', () => this.clock.setLevel(k, Number(el.value)));
        el.addEventListener('change', () => { this.audioPrefs.levels[k] = Number(el.value); this.clock.setLevel(k, Number(el.value)); this.saveAudioPrefs(); });
        m.addEventListener('change', () => { this.audioPrefs.mutes[k] = m.checked; this.clock.setMute(k, m.checked); this.saveAudioPrefs(); });
      }
    }

    // iOS の割り込み（着信・画面ロックなど）で音声が止まったら、音なしで進めずに一時停止する
    this.clock.onStateChange = (st) => {
      if (st !== 'running' && this.state === 'playing' && this.clock._audioMode) {
        this.pause();
        this.status(`音声が中断されました（AudioContext: ${st}）。▶ 再開で続きから再生します`, 'error');
      }
      this.renderAudioInfo();
    };
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
