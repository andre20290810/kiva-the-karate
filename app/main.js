// KIVA THE KARATE — セーパイ 2D（背景透過の実写連続画像）。
// 読み込み → 再生（共通の再生時計）→ 入力 → 判定 → 描画（背景・人物・エフェクト・レーン）。

import { TimelineClock } from './clock.js';
import { Judge } from './judge.js';
import { AutoPlayer } from './auto.js';
import { Input } from './input.js';
import { FrameStore } from './frames.js';
import { Effects } from './fx.js';
import { LaneRenderer, LANE_STYLE } from './lanes.js';
import { loadBrushFont } from './glyphfire.js';
import { BACKGROUNDS, orientationOf, containRect, coverRect, laneRect, standingHeight, landscapeSubject, subjectTransform } from './layout.js';
import { normalizeChart, validateChart, exportChart, BUTTON_INFO, TIMING_KEYS, validateTiming, DEFAULT_SETTINGS } from './chart.js';
import { buildRecord } from './score.js';
import { ScoreHistory } from './history.js';
import { ResultsView } from './results.js';
import { resolveEffect } from './effects-catalog.js';
import { Editor } from './editor.js';
import { simulate, applyEvent, eventClock, replayable, snapshotNotes, JUDGE_VERSION, LOG_VERSION } from './replay.js';
import { OfficialView } from './official-view.js';
import { GAME } from './config.js';

const $ = (s) => document.querySelector(s);
const PREFS_KEY = 'kiva2d.prefs.v1';
/** 文字列の指紋（FNV-1a 32bit。公開版の譜面が変わったかの判定だけに使う） */
const fingerprint = (text) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
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
      // BGM の選択と、元動画の音声・BGM の音量・ミュートだけを読む（効果音は廃止。古い保存内容の効果音の項目は読まずに消す）
      const pick = (o, def) => ({ voice: o?.voice ?? def.voice, bgm: o?.bgm ?? def.bgm });
      this.audioPrefs = {
        bgm: this.ver.bgm.some((t) => t.id === saved.bgm) ? saved.bgm : this.ver.defaultBgm,
        levels: pick(saved.levels, this.ver.defaultLevels),
        mutes: pick(saved.mutes, { voice: false, bgm: false }),
      };
      if (saved.levels?.sfx != null || saved.mutes?.sfx != null || 'sfxReset' in saved) store.set(this.keys.audio, JSON.stringify(this.audioPrefs));
    }
    this.bgmState = null;
    this._bgmToken = 0;
    this.state = 'loading';
    this.autoMode = this.params.get('auto') === '1';
    this.editMode = false;
    this.loop = { a: null, b: null, on: false };
    this.generation = 0;
    this.lastT = 0;
    this.prefs = { volume: 0.8, fxStrength: 1, lowFx: false, ...JSON.parse(store.get(PREFS_KEY) || '{}') };
    if ('sfx' in this.prefs) { delete this.prefs.sfx; store.set(PREFS_KEY, JSON.stringify(this.prefs)); } // 廃止した効果音の音量
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
    this.session = null;   // 1 回のプレイ（開始〜終了・リトライ）。判定の設定はこの開始時に確定する
    this.history = new ScoreHistory(this.keys.history);
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

  /** 公式データ（/api/official）。サーバーがない環境（ローカル）や失敗時は null */
  async fetchOfficial() {
    try {
      const r = await fetch(new URL('api/official', location.href), { cache: 'no-store' });
      if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
      const d = await r.json();
      return d?.chart?.notes ? d : null;
    } catch { return null; }
  }

  /** 公式データが更新された（公開・復元の直後）: 配布の初期設定と公式デモを差し替える。個人用に保存した譜面・成績は変えない */
  async applyOfficial(doc) {
    if (!doc?.chart) return;
    const v = validateChart(doc.chart, { frameCount: this.manifest.frameCount, gameVersion: this.version });
    if (v.errors.length) return;
    this.initialChart = normalizeChart(doc.chart);
    this.distributedFingerprint = fingerprint(exportChart(this.initialChart));
    this.official = { version: doc.version, updatedAt: doc.updatedAt, source: 'server' };
    this.history.setOfficial(doc.demos || []);
    this.editor?.refreshSource();
  }

  openOfficial() {
    if (!this.officialView) this.officialView = new OfficialView(this);
    this.officialView.open();
  }

  // ---------- 読み込み ----------
  async load() {
    try {
      this.progress(0, '譜面を読み込み中…');
      const chartUrl = new URL(this.params.get('chart') || this.ver.chart, location.href).href;
      // 公式データ（サーバーの最新版。全利用者に配布）→ 取れなければ公開ビルドに同梱の初期データ
      const off = this.params.has('chart') ? null : await this.fetchOfficial();
      let initial, demos;
      if (off) {
        initial = off.chart; demos = off.demos || [];
        this.official = { version: off.version, updatedAt: off.updatedAt, source: 'server' };
      } else {
        initial = await fetchJson(chartUrl, '初期譜面');
        demos = await fetch(new URL('charts/official-demos.json', location.href), { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((j) => j?.records || []).catch(() => []);
        this.official = { version: null, updatedAt: null, source: 'bundle' };
      }
      this.history.setOfficial(demos);
      const v0 = validateChart(initial, { gameVersion: this.version });
      if (v0.errors.length) throw new Error('初期譜面にエラーがあります:\n' + v0.errors.join('\n'));
      this.initialChart = normalizeChart(initial);
      this.distributedFingerprint = fingerprint(exportChart(this.initialChart)); // 公開版の譜面が更新されたかの判定
      const manifestUrl = new URL(this.initialChart.source.frameManifest, location.href).href;
      this.progress(0.02, '画像の一覧を読み込み中…');
      this.manifest = await fetchJson(manifestUrl, '連続画像の一覧（manifest.json）');
      if (this.manifest.frameCount !== this.initialChart.source.frameCount) {
        throw new Error(`連続画像の枚数が譜面と一致しません（画像 ${this.manifest.frameCount} 枚、譜面 ${this.initialChart.source.frameCount} 枚）`);
      }
      this.duration = this.manifest.durationSeconds || this.initialChart.source.durationSeconds;
      // 起動する譜面: 編集中の下書き（自動保存）→ この端末のデフォルト → 配布時の初期設定（公開版の譜面）。壊れていれば次へ
      const readSaved = (key) => {
        if (this.params.has('fresh')) return null;
        try {
          const obj = JSON.parse(store.get(key) || 'null');
          if (!obj) return null;
          const v = validateChart(obj, { frameCount: this.manifest.frameCount, gameVersion: this.version });
          return v.errors.length ? null : normalizeChart(obj);
        } catch { return null; }
      };
      this.deviceDefault = readSaved(this.keys.deviceDefault);
      this.deviceDefaultSavedAt = this.deviceDefault ? store.get(this.keys.deviceDefault + '.savedAt') : null;
      const draft = readSaved(this.keys.autosave);
      const chart = draft || this.deviceDefault || this.initialChart;
      this.chartSource = draft ? 'draft' : this.deviceDefault ? 'default' : 'distributed';
      const restored = this.chartSource !== 'distributed';
      // 下書き・デフォルトを保存した後に公開版の譜面が更新されたか（記録のない古い保存も「更新あり」）
      this.distributedUpdated = restored && store.get(this.keys.chartBase) !== this.distributedFingerprint;
      this.chart = chart;
      this.clock = new TimelineClock({ duration: this.duration, mix: this.mixMode });
      this.clock.volume = this.prefs.volume;
      if (this.mixMode) {
        Object.assign(this.clock.levels, this.audioPrefs.levels);
        Object.assign(this.clock.mutes, this.audioPrefs.mutes);
      }
      const bgP = Promise.all([loadImage(BACKGROUNDS.landscape.src), loadImage(BACKGROUNDS.portrait.src)]);
      this.store = new FrameStore(this.manifest, manifestUrl);
      const framesP = this.store.fetchAll((d, n) => this.progress(0.05 + 0.85 * d / n, `人物画像を読み込み中… ${d}/${n}`));
      const audioP = this.loadAudio();
      // 文字のノーツの行書体（読み込み後に寸法を測り直す。失敗しても端末の字体で遊べる）
      const fontP = loadBrushFont().then((ok) => { this.brushFont = ok; this.lanes.glyph.resetFont(); return ok; });
      [this.bgImages] = await Promise.all([bgP, framesP, fontP]);
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
      this.status(`${legacy}準備完了: ノーツ ${this.chart.notes.length}、画像 ${this.store.count} 枚（0〜${this.duration.toFixed(1)} 秒）。${this.audioNote}${restored ? (this.chartSource === 'draft' ? ' ／ 編集中の下書き（自動保存）で起動しました' : ' ／ この端末のデフォルトの設定で起動しました') : ''}${this.distributedUpdated ? '（公開版の初期設定が更新されています。⚙設定の「公開版の設定に切り替える」で切り替えられます）' : ''}${stand}`, 'ok');
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
    if (!list.length) return '音源なし（画像とノーツだけで進行）';
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
    return `音源を使えません（${errs.join(' ／ ')}）。音声なしで進行します`;
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
    window.addEventListener('pagehide', () => { this.pause(); this.endSession('aborted'); });
    this.editor = new Editor(this, $('#editor'));
    this.bindUi();
    this.raf();
  }

  // ---------- 再生 ----------
  get t() { return this.clock ? this.clock.position() : 0; }

  newJudge(t) {
    if (this.replay) { this.replayRebuild(t); return; } // リプレイ中は記録の入力ログから作り直す
    this.generation++;
    if (this.session) this.session.judges = (this.session.judges || 0) + 1; // 1 回のプレイで判定を作り直した（シーク・編集）なら入力ログは残さない
    // 判定の設定はプレイの開始時に確定した値（プレイ中に設定を変えても次のプレイから）
    this.judge = new Judge(this.chart.notes, this.session?.settings ?? this.chart.settings);
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
  }

  /** この端末の下書き・デフォルトの有無と、公開版の設定へ切り替えるボタン（⚙設定） */
  refreshChartSource() {
    const box = $('#chartSrc');
    if (!box) return;
    const draft = !!store.get(this.keys.autosave), def = !!store.get(this.keys.deviceDefault);
    box.hidden = !draft && !def;
    $('#chartSrcText').textContent = `この端末に保存した${[def && 'デフォルト', draft && '編集中の下書き'].filter(Boolean).join('と')}の譜面で起動しています。`
      + (this.distributedUpdated ? '公開版の初期設定はその後に更新されています。' : '')
      + '切り替えても、今の設定は控えとして残ります（編集モードで JSON を書き出すこともできます）。';
  }

  /** 公開版の初期設定（charts/seipai_v2.json）に切り替える。この端末の下書き・デフォルトは控えに移す（消さない） */
  useDistributed() {
    if (!confirm('公開版の初期設定に切り替えますか？\nこの端末の下書き・デフォルトは控えとして保存し、次からは公開版の設定で起動します。')) return;
    const backup = { at: new Date().toISOString(), draft: store.get(this.keys.autosave), deviceDefault: store.get(this.keys.deviceDefault) };
    store.set(this.keys.chartBackup, JSON.stringify(backup));
    store.del(this.keys.autosave); store.del(this.keys.deviceDefault);
    this.deviceDefault = null;
    this.chartSource = 'distributed';
    this.distributedUpdated = false;
    this.chart = structuredClone(this.initialChart);
    this.chartChanged();
    this.editor?.refresh();
    this.syncSettingsUi?.();
    this.refreshChartSource();
    this.status(`公開版の初期設定に切り替えました（ノーツ ${this.chart.notes.length}）。前の設定は控えとして保存しています`, 'ok');
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
    if (this.replay) {
      // リプレイ: 記録の開始時刻から（成績には記録しない）
      if (this.state === 'ready' || this.state === 'ended') { this.clock.stop(this.replay.startT); this.replayRebuild(this.replay.startT); this.results?.hide(); }
    } else if (this.state === 'ready' || this.state === 'ended') {
      const from = this.loop.on && this.loop.a != null ? this.loop.a : -this.chart.settings.leadInSeconds;
      this.startSession(from);
      this.clock.stop(from);
      this.newJudge(from);
      this.log = [];
      this.results?.hide();
    } else if (!this.session) {
      // シーク・編集の後など、途中から再生を始めた（練習）
      this.startSession(this.t);
      this.newJudge(this.t);
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
    this.state = 'paused';
    this.updateUi();
  }

  togglePlay() { if (this.state === 'playing') this.pause(); else this.play(); }

  retry() {
    if (!this.clock) return;
    const from = this.replay ? this.replay.startT : this.loop.on && this.loop.a != null ? this.loop.a : -this.chart.settings.leadInSeconds;
    const wasPlaying = this.state === 'playing';
    this.endSession('aborted'); // 途中のプレイは「途中終了」として残す（判定したノーツがあるとき）
    this.session = null;
    this.clock.stop(from);
    this.newJudge(from);
    this.log = [];
    this.results?.hide();
    this.state = 'ready';
    if (wasPlaying || !this.editMode) this.play(); else this.updateUi();
  }

  /** シーク（画像・ノーツ・音声を同じ時刻へ。判定状態とエフェクトを初期化） */
  seek(t) {
    if (!this.clock) return;
    const to = Math.max(-this.chart.settings.leadInSeconds, Math.min(t, this.duration));
    this.markPractice(this.loop.on && Math.abs(to - (this.loop.a ?? NaN)) < 1e-6 ? 'loop' : 'seek');
    this.clock.seek(to);
    this.newJudge(to);
    if (this.state === 'ended') this.state = 'paused';
    if (this.state === 'ready') this.state = 'paused';
    this.updateUi();
  }

  setRate(r) {
    if (this.session && this.session.rate !== r && this.judge?.notes.some((n) => n.result && n.result !== 'SKIP')) this.markPractice('rate-change');
    else if (this.session) this.session.rate = r;
    this.clock?.setRate(r);
    $('#speed').value = String(r);
    this.editor?.syncRate(r);
  }

  setAuto(on) {
    if (this.replay && on) { this.status('リプレイ中は AUTO を使えません（「再現を終える」で通常に戻ります）', 'error'); return; }
    this.autoMode = on;
    if (this.judge) {
      // 切替時: 押しっぱなしの長押しは成績に数えず、過去のノーツはまとめて成立させない
      this.judge.cancelHolds();
      const t = this.t;
      this.auto = on ? new AutoPlayer(this.judge, { generation: ++this.generation }) : null;
      if (this.auto) {
        this.auto.reset(t);
        this.auto.onPress = (b) => { this.flash[b] = this.t; this.held[b] = true; };
        this.auto.onRelease = (b) => { this.held[b] = false; };
      }
      for (const b of Object.keys(this.held)) this.held[b] = this.input.isDown(b);
      if (this.session && on) this.session.autoUsed = true;
    }
    this.updateUi();
  }

  // ---------- リプレイ（保存した入力ログの再現。通常の AUTO とは別） ----------
  /** 履歴のプレイを再現する（公式デモ・入力ログのある自分の記録）。記録時の譜面・判定条件・入力補正・再生速度で */
  startReplay(rec) {
    const can = replayable(rec);
    if (!can.ok) { this.status(can.reason, 'error'); return can; }
    if (this.state === 'playing') this.pause();
    this.endSession('aborted');
    this.session = null;
    if (this.autoMode) this.setAuto(false);
    if (this.editMode) this.setEdit(false);
    const r = rec.replay;
    // 判定は記録の譜面の写し。見た目（エフェクト・表示名）は今の譜面の同じノーツ（時刻・コマンドが同じとき）から
    const cur = new Map(this.chart.notes.map((n) => [n.id, n]));
    const notes = r.notes.map((n) => {
      const c = cur.get(n.id);
      const same = c && c.time === n.time && c.button === n.button && (c.duration || 0) === (n.duration || 0);
      return same ? { ...n, effect: c.effect, label: c.label, action: c.action, sequenceId: c.sequenceId } : { ...n };
    });
    const prev = this.replay;
    this.replay = { rec, notes, settings: { ...rec.settings }, events: r.events, startT: r.startT, endT: r.endT, next: 0,
      kind: rec.mode === 'demo' ? 'demo' : 'history', prevRate: prev ? prev.prevRate : this.clock.rate };
    this.setRate(rec.rate);
    this.results?.hide();
    this.state = 'ready';
    this.clock.stop(r.startT);
    this.replayRebuild(r.startT);
    this.renderReplayBanner();
    this.updateUi();
    this.play();
    return { ok: true };
  }

  /** time までの入力ログで判定を作り直す（シーク・最初から。判定済み・長押し・スコアを再構築し、二重加点しない） */
  replayRebuild(t) {
    const R = this.replay;
    const to = Math.max(R.startT, t);
    const { judge, next } = simulate({ notes: R.notes, settings: R.settings, startT: R.startT, events: R.events, until: to, prefix: `rp${++this.generation}` });
    this.judge = judge;
    this.judge.on((e) => this.onJudge(e));
    R.next = next;
    this.auto = null;
    this.fx.clear();
    this.lanes.clear();
    for (const b of Object.keys(this.held)) this.held[b] = false;
    // 押したままの長押し（再構築した時点）
    for (const n of judge.notes) if (n.holding) this.held[n.button] = true;
  }

  /** 1 コマ分: その時刻までの入力を記録した順に判定へ渡す。判定を進める時刻は、次の入力の直前の時刻を越えない */
  replayStep(t) {
    const R = this.replay, ev = R.events;
    while (R.next < ev.length && eventClock(ev[R.next]) <= t) {
      const e = ev[R.next];
      applyEvent(this.judge, e, R.next, `rp${this.generation}`);
      if (e[0] === 'd') { this.held[e[1]] = true; this.flash[e[1]] = this.t; } else if (e[0] === 'u') this.held[e[1]] = false;
      R.next++;
    }
    const nextAt = ev[R.next]?.[4];
    this.judge.update(nextAt != null ? Math.min(t, nextAt) : t);
    if (R.endT != null && R.next >= ev.length && t >= R.endT && R.endT < this.duration - 1e-3) this.finish(); // 途中で終えた記録はその時刻まで
  }

  replayEnded() {
    this.status(`${this.replay.kind === 'demo' ? '公式デモ' : '履歴'}の再現が終わりました（成績・自己ベストには記録しません）。「最初から」で再生、「再現を終える」で通常に戻ります`, 'ok');
    window.__replayEnded = { at: new Date().toISOString(), id: this.replay.rec.id };
    this.updateUi();
  }

  /** リプレイの結果（判定・スコア・コンボ）を記録と同じ形で（確認用） */
  replayRecord() {
    const R = this.replay;
    if (!R) return null;
    return buildRecord(this.judge, { chart: { title: R.rec.chart.title, gameVersion: R.rec.chart.gameVersion, notes: R.notes }, settings: R.settings, rate: R.rec.rate, mode: R.rec.mode, kind: R.rec.kind, startT: R.startT, endT: R.endT, duration: R.rec.chart.duration, id: R.rec.id });
  }

  stopReplay() {
    const R = this.replay;
    if (!R) return;
    if (this.state === 'playing') this.pause();
    this.replay = null;
    this.setRate(R.prevRate ?? 1);
    this.state = 'ready';
    const from = -this.chart.settings.leadInSeconds;
    this.clock.stop(from);
    this.newJudge(from);
    this.renderReplayBanner();
    this.status('再現を終えました。通常のプレイに戻りました', 'ok');
    this.updateUi();
  }

  renderReplayBanner() {
    const el = $('#replayBanner');
    if (!el) return;
    const R = this.replay;
    el.hidden = !R;
    document.documentElement.dataset.replay = R ? R.kind : '';
    if (!R) return;
    const rec = R.rec, ok = rec.summary.perfect + rec.summary.good;
    $('#replayLabel').textContent = R.kind === 'demo'
      ? `公式デモ再現中: ${rec.demo?.label ?? rec.id}（シミュレーション・成功 ${ok}/${rec.summary.total}）`
      : `履歴リプレイ中: ${new Date(rec.at).toLocaleString('ja-JP')} のプレイ（成功 ${ok}/${rec.summary.total}）`;
    $('#replaySub').textContent = `記録時の条件で再生: 判定幅 P±${rec.settings.perfectWindowMs}/G±${rec.settings.goodWindowMs}/M±${rec.settings.missWindowMs}・入力補正 ${rec.settings.inputOffsetMs}ms・速度 ${rec.rate}×。手動の入力は判定に入りません。成績には記録しません`;
  }

  // ---------- 1 回のプレイ（成績の記録） ----------
  /** プレイの開始: 判定の設定（判定幅・入力補正）・速度・BGM をここで確定する */
  startSession(from) {
    const st = structuredClone(this.chart.settings);
    const reasons = [];
    if (this.loop.on) reasons.push('loop');
    if (this.editMode) reasons.push('edit');
    if (from > -this.chart.settings.leadInSeconds + 1e-3) reasons.push('mid-start');
    this.session = {
      settings: st, startedAt: new Date().toISOString(), startT: from, rate: this.clock?.rate ?? 1,
      autoUsed: this.autoMode, practiceReasons: reasons, saved: false,
      bgm: this.mixMode ? { id: this.audioPrefs.bgm, label: this.ver.bgm.find((t) => t.id === this.audioPrefs.bgm)?.label ?? '', muted: !!this.audioPrefs.mutes.bgm } : null,
      chartSource: this.chartSource,
    };
    if (this.settingsPending) { this.settingsPending = false; this.renderTimingState?.(); }
  }

  /** 練習として扱う（シーク・区間ループ・途中の速度変更・編集） */
  markPractice(reason) {
    const s = this.session;
    if (!s || s.saved) return;
    if (!s.practiceReasons.includes(reason)) s.practiceReasons.push(reason);
  }

  /** プレイの終わり: 記録を作って履歴に保存（判定したノーツが 1 つも無ければ残さない） */
  endSession(reason) {
    const s = this.session;
    if (!s || s.saved || !this.judge) return null;
    if (!this.judge.notes.some((n) => n.result && n.result !== 'SKIP') && !this.judge.strays.length) return null;
    s.saved = true;
    const kind = s.practiceReasons.length ? 'practice' : reason === 'end' ? 'full' : 'aborted';
    const rec = buildRecord(this.judge, {
      chart: this.chart, settings: s.settings, rate: s.rate, mode: s.autoUsed || this.autoMode ? 'auto' : 'manual', kind,
      practiceReasons: s.practiceReasons, bgm: s.bgm, startedAt: s.startedAt, endedAt: new Date().toISOString(),
      chartSource: s.chartSource, startT: s.startT, endT: this.t, duration: this.duration,
      frameAt: (t) => { const i = this.store.indexAt(Math.max(0, t)); return { i, t: this.store.frames[i].t }; },
      // 再現に必要な記録: 判定への入力の呼び出し（順番どおり）・譜面のノーツの写し・判定ロジックの版。判定を作り直したプレイには残さない
      replay: s.judges === 1 ? { v: LOG_VERSION, judgeVersion: JUDGE_VERSION, startT: s.startT, endT: this.judge.lastUpdate, notes: snapshotNotes(this.judge.notes), events: this.judge.log.map((e) => e.slice()) } : null,
    });
    const saved = this.history.add(rec);
    this.lastRecord = rec;
    this.lastSave = saved;
    window.__lastRecord = rec;
    return rec;
  }

  finish() {
    this.state = 'ended';
    this.clock.pause();
    if (this.replay) { this.replayEnded(); return; } // リプレイは成績・自己ベストに記録しない
    const s = this.judge.summary();
    const rec = this.endSession('end');
    const auto = rec ? rec.mode === 'auto' : this.autoMode;
    window.__lastResult = { auto, ...s, gameVersion: this.version, at: new Date().toISOString(), log: this.log };
    if (!auto && rec?.kind === 'full') {
      const best = JSON.parse(store.get(this.keys.best) || 'null');
      if (!best || s.score > best.score) store.set(this.keys.best, JSON.stringify({ auto, ...s, gameVersion: this.version, at: rec.at }));
    }
    if (rec) this.results.show(rec, { saved: this.lastSave });
    this.updateUi();
  }

  // ---------- 入力と判定 ----------
  onPress(b, perfMs, o) {
    this.held[b] = true;
    if (this.state !== 'playing') { this.flash[b] = this.t; return; }
    this.flash[b] = this.clock.position(perfMs);
    if (this.autoMode || this.replay) return; // AUTO・リプレイ中の手動入力は判定に混ぜない
    // 判定・記録は同じ時間軸。raw = 補正前の時刻、t = 入力補正（プレイ開始時に確定した値）を引いた判定用の時刻
    const raw = this.clock.position(perfMs);
    const t = raw - (this.session?.settings ?? this.chart.settings).inputOffsetMs / 1000;
    this.judge.press(b, t, { id: o.id, source: o.source, raw, device: o.device });
  }

  onRelease(b, perfMs, o) {
    this.held[b] = false;
    if (this.state !== 'playing' || this.autoMode || this.replay) return;
    const raw = this.clock.position(perfMs);
    const t = raw - (this.session?.settings ?? this.chart.settings).inputOffsetMs / 1000;
    this.judge.release(b, t, { source: o.source, raw, device: o.device });
  }

  onJudge(e) {
    if (e.type === 'stray') { this.lanes.mark('—', this.t, e.button); return; }
    const n = e.note, src = n.src;
    if (e.type === 'holdStart' || e.type === 'holdRelease') return; // 押し始め・完了後に離した記録は判定ではない
    this.log.push({ id: n.id, time: n.time, grade: e.grade, delta: n.delta, source: e.source, reason: e.reason });
    const shownAt = e.grade === 'MISS' ? this.t : Math.min(this.t, e.time ?? this.t);
    this.lanes.mark(e.grade, Math.max(shownAt, this.t - 0.05), n.button, n.delta);
    if (e.grade === 'MISS') return;
    // 成功: 人物のエフェクトはノーツごとに選んだ番号で（app/effects-catalog.js）。効果音はない（2026-10-21 に廃止）
    const ef = src.effect || {};
    const fx = resolveEffect(src);
    const frameIndex = this.store.indexAt(Math.max(0, n.time));
    const t0 = this.t; // 演出の山 = 判定した瞬間
    if (n.input === 'hold') this.fx.holdDone(n.id);
    // 判定位置の文字に赤い火を灯す（MISS・早すぎる解除では呼ばれない）
    this.lanes.ignite(n.button, t0, e.grade, n.input === 'hold');
    this.fx.trigger(fx.key, {
      t: t0, grade: e.grade, frameIndex, action: src.action, fx, hold: n.input === 'hold',
      direction: fx.direction ?? ef.direction, seed: this.generation * 101 + this.judge.notes.indexOf(n),
    });
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
      if (this.replay) this.replayStep(t);
      else { this.auto?.update(t); this.judge.update(t); }
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
    // 表示順（奥 → 手前）: 背景 → レーンの背景・枠 → 背面のエフェクト → 流れるノーツ → 人物（と手前のエフェクト） → 見出し・判定線・判定位置の火
    const held = {};
    for (const b of ['Y', 'X', 'A', 'B']) held[b] = this.held[b] || t - this.flash[b] < 0.08;
    this.lanes.drawBack(ctx, L, { held });
    // 人物
    const fi = this.store.indexAt(Math.max(0, t));
    this.store.prefetch(fi);
    const S = { t, store: this.store, frameIndex: fi, transformFor: (i) => this.transformFor(i, G), standH, canvas: this.canvas, dpr };
    // 長押し中のエフェクト（ノーツで選んだ番号。息の既定は呼吸の気）
    const holding = this.judge?.notes.find((n) => n.holding);
    const hn = holding;
    if (hn) { const r = resolveEffect(hn.src); this.fx.setHold({ id: hn.id, key: r.key, fx: r, progress: this.judge.holdProgress(holding, t) }, t); } else this.fx.setHold(null, t);
    this.fx.renderUnder(ctx, S);
    this.editor?.drawPreview(ctx, S, 'under');
    // 流れるノーツ（文字・長押しの線・終端・光）は人物より奥（人物の透明な部分からは見える）
    const lead = this.chart.settings.laneLeadSeconds;
    this.lanes.drawNotes(ctx, L, t, this.judge ? this.judge.notes : [], { lead, selected: this.editor?.selected });
    const g = this.store.get(fi);
    let shown = null;
    if (g) {
      const r = this.transformFor(g.index, G).crop();
      ctx.drawImage(g.bmp, r.x, r.y, r.w, r.h);
      shown = g.index;
    }
    // 長押し中（人物の手前側の光）
    if (hn) this.fx.renderHold(ctx, S);
    this.fx.renderOver(ctx, S);
    this.editor?.drawPreview(ctx, S, 'over');
    // レーンの手前側（ラベル・判定線・ノーツ・判定）と HUD
    const holdNote = holding;
    const lanesInfo = this.lanes.draw(ctx, L, t, this.judge ? this.judge.notes : [], {
      lead, held, selected: this.editor?.selected,
      holdFire: holdNote ? { button: holdNote.button, progress: this.judge.holdProgress(holdNote, t) } : null, // 正しく保持している間だけ火が育つ
    });
    for (const b of ['Y', 'X', 'A', 'B']) if (this.padEls[b].classList.contains('down') !== held[b]) this.padEls[b].classList.toggle('down', held[b]);
    this.drawHud(ctx, G, t, fi);
    this.editor?.drawOverlay(ctx, G, t, fi);
    window.__debug = {
      t, frame: fi, shown, state: this.state, orient: this.orient, bg, lanes: L, standH, lanesInfo: { jx: lanesInfo.jx },
      bgDraw: G.bgDraw, subject: g ? this.transformFor(g.index, G).crop() : null, visible: g ? this.visibleBox(g.index, G) : null, anchor: g ? [this.transformFor(g.index, G).ox, this.transformFor(g.index, G).oy] : null,
      decoded: this.store.bitmaps.size, brushFont: !!this.brushFont, fx: this.fx.stats, auto: this.autoMode, rate: this.clock.rate,
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
      this.endSession('aborted');
      this.session = null;
      this.clock.stop(from);
      this.newJudge(from);
      this.log = [];
      this.results?.hide();
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
    $('#btnUseDistributed').addEventListener('click', () => this.useDistributed());
    this.refreshChartSource();
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
      for (const [k, id, mute] of [['bgm', '#mixBgm', '#muteBgm'], ['voice', '#mixVoice', '#muteVoice']]) {
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
    $('#replayRestart').addEventListener('click', () => { if (this.replay) { this.retry(); } });
    $('#replayStop').addEventListener('click', () => this.stopReplay());
    $('#btnAuto').addEventListener('click', () => this.setAuto(!this.autoMode));
    $('#btnEdit').addEventListener('click', () => this.setEdit(!this.editMode));
    $('#speed').addEventListener('change', (e) => this.setRate(Number(e.target.value)));
    this.results = new ResultsView(this);
    $('#btnScores').addEventListener('click', () => this.results.openHistory());
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
    this.bindTimingUi();
    void s;
    window.addEventListener('keydown', (e) => {
      if (e.target?.closest?.('input, select, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
      else if (e.code === 'KeyR' && !e.repeat && !e.ctrlKey && !e.metaKey) this.retry();
    });
  }

  // ---------- タイミング判定の設定（譜面 JSON の settings。編集モード・JSON 入出力と同じ値） ----------
  /** 設定欄の入力 → 値（数値にできないものは NaN） */
  timingDraft() {
    const out = {};
    for (const k of TIMING_KEYS) { const el = $(`[data-timing="${k}"]`); out[k] = el.value.trim() === '' ? NaN : Number(el.value); }
    return out;
  }

  bindTimingUi() {
    for (const k of TIMING_KEYS) $(`[data-timing="${k}"]`).addEventListener('input', () => this.renderTimingState());
    $('#timingSave').addEventListener('click', () => this.saveTiming(this.timingDraft()));
    $('#timingReset').addEventListener('click', () => {
      const def = Object.fromEntries(TIMING_KEYS.map((k) => [k, DEFAULT_SETTINGS[k]]));
      for (const k of TIMING_KEYS) $(`[data-timing="${k}"]`).value = def[k];
      this.saveTiming(def, '判定の設定を初期設定に戻しました');
    });
    this.syncSettingsUi();
  }

  /** 検証して保存（不正なら保存しない）。プレイ中は判定を作り直さず、次のプレイ（開始・リトライ）から適用 */
  saveTiming(vals, msg = '判定の設定を保存しました') {
    const errs = validateTiming(vals);
    if (errs.length) { this.renderTimingState(); return false; }
    const ok = this.editor.apply((c) => { for (const k of TIMING_KEYS) c.settings[k] = vals[k]; }, '判定の設定を変更', { rejudge: false });
    if (!ok) return false;
    const active = this.session && !this.session.saved && this.state !== 'ready' && this.state !== 'ended';
    if (active) this.settingsPending = true;
    else this.newJudge(this.t); // プレイしていないときはすぐ使う
    this.status(active ? `${msg}。今のプレイは開始時の設定のまま判定し、次のプレイ（開始・リトライ）から適用します` : msg, 'ok');
    this.syncSettingsUi();
    return true;
  }

  /** 設定欄の表示: 意味（±ms ＝ 秒）・エラー・保存の可否 */
  renderTimingState() {
    const v = this.timingDraft(), cur = this.chart.settings;
    const errs = validateTiming(v);
    const sec = (ms) => (Math.abs(ms) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    const ok = (x) => Number.isFinite(x);
    const mean = {
      perfectWindowMs: ok(v.perfectWindowMs) ? `±${v.perfectWindowMs}ms＝正解時刻の ${sec(v.perfectWindowMs)} 秒前〜${sec(v.perfectWindowMs)} 秒後で PERFECT` : '',
      goodWindowMs: ok(v.goodWindowMs) ? `±${v.goodWindowMs}ms＝PERFECT の外側から ${sec(v.goodWindowMs)} 秒前〜${sec(v.goodWindowMs)} 秒後まで GOOD` : '',
      missWindowMs: ok(v.missWindowMs) ? `±${v.missWindowMs}ms＝GOOD の外側〜${sec(v.missWindowMs)} 秒は MISS（そのノーツを使う）。それより外の入力は「余分な入力」` : '',
      holdStartWindowMs: ok(v.holdStartWindowMs) ? `息の押し始め: ±${v.holdStartWindowMs}ms（${sec(v.holdStartWindowMs)} 秒）以内で GOOD（PERFECT は PERFECT の幅）` : '',
      holdReleaseWindowMs: ok(v.holdReleaseWindowMs) ? `息: 終わりの ${sec(v.holdReleaseWindowMs)} 秒前より後に離せば成功。それより前に離すと早離し（MISS）` : '',
      inputOffsetMs: ok(v.inputOffsetMs) ? (v.inputOffsetMs === 0 ? '補正なし' : `${v.inputOffsetMs > 0 ? '+' : ''}${v.inputOffsetMs}ms＝押した時刻を ${sec(v.inputOffsetMs)} 秒${v.inputOffsetMs > 0 ? '早い' : '遅い'}時刻として判定`) : '',
    };
    for (const k of TIMING_KEYS) $(`[data-mean="${k}"]`).textContent = mean[k];
    $('#timingErr').innerHTML = errs.map((e) => `<li>${e}</li>`).join('');
    const changed = TIMING_KEYS.some((k) => v[k] !== cur[k]);
    $('#timingSave').disabled = !!errs.length || !changed;
    $('#timingState').textContent = errs.length ? '保存できません（上のエラーを直してください）'
      : changed ? '未保存の変更があります' : this.settingsPending ? '保存済み（次のプレイから適用）' : '保存済み';
  }

  syncSettingsUi() {
    for (const k of TIMING_KEYS) { const el = $(`[data-timing="${k}"]`); if (el) el.value = this.chart.settings[k]; }
    if ($('#timingSave')) this.renderTimingState();
  }

  setEdit(on) {
    if (on && this.replay) this.stopReplay(); // 編集はリプレイを終えてから
    this.editMode = on;
    if (on) this.markPractice('edit');
    if (on) this.pause();
    this.editor.setOpen(on);
    this.updateUi();
    requestAnimationFrame(() => this.resize());
  }
}

export { LANE_STYLE, BUTTON_INFO };

const app = new App();
app.load();
