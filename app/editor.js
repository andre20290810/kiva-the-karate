// 編集モード: 実写の型を見ながら、ノーツを 1 つずつ直す。
// 再生・シーク・1 コマ送り・速度・A–B ループ・タイムライン（ドラッグ）・追加／複製／削除・まとめてずらす・
// 連続コマンドのまとまりと並べ替え・ノーツごとのコマンド種別と視覚エフェクト（番号・発生位置・向き・大きさ・強さ・持続時間）・
// 人物の位置と倍率の補正・元に戻す／やり直す・自動保存（下書き）・この端末のデフォルトとして保存・JSON 書き出し／読み込み。

import { FRAME, timeTicks } from './timeline.js';
import { BUTTONS, BUTTON_INFO, ACTION_LABEL, exportChart, parseChartText, makeNote, normalizeChart, validateChart } from './chart.js';
import { LANE_ORDER, LANE_STYLE, GLYPH } from './lanes.js';
import { EFFECTS, EFFECT_BY_ID, ORIGINS, RANGES, DEFAULT_EFFECT_ID, effectIdOf, resolveEffect, effectForId, angleOf } from './effects-catalog.js';
import { Effects } from './fx.js';

const r2 = (v) => Math.round(v * 100) / 100;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Editor {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.selected = new Set();
    this.frameDraft = null; // 補正欄の未適用の入力 {frame, dx, dy, scale}
    this.undoStack = [];
    this.redoStack = [];
    this.snap = false;
    this.zoom = 10; // タイムラインに見える秒数
    this.pick = null; // 'anchor' | 'direction' | null（画面で位置を指定中）
    this.build();
    this.bindStagePick();
  }

  get chart() { return this.app.chart; }

  // ---------- 変更の記録 ----------
  /** 譜面を変更する唯一の入口。fn(chart) で書き換え → 検証 → 履歴・自動保存・判定の作り直し */
  apply(fn, label = '編集', { rejudge = true } = {}) {
    const before = structuredClone(this.chart);
    const next = structuredClone(this.chart);
    fn(next);
    const v = validateChart(next, { frameCount: this.app.manifest.frameCount, gameVersion: this.app.version });
    if (v.errors.length) {
      this.message(`変更できません: ${v.errors[0]}`, 'error');
      return false;
    }
    this.undoStack.push({ chart: before, label });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.app.chart = normalizeChart(next);
    this.afterChange(label, { rejudge });
    return true;
  }

  afterChange(label, { rejudge = true } = {}) {
    if (rejudge) this.app.chartChanged(); // タイミング判定の設定だけの変更はプレイ中の判定を作り直さない（次のプレイから）
    for (const id of [...this.selected]) if (!this.chart.notes.some((n) => n.id === id)) this.selected.delete(id);
    this.autosave();
    this.refresh();
    this.app.syncSettingsUi?.();
    if (label) this.message(`${label}（元に戻す: Ctrl+Z）`);
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push({ chart: structuredClone(this.chart), label: s.label });
    this.app.chart = s.chart;
    this.afterChange(null);
    this.message(`元に戻しました: ${s.label}`);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push({ chart: structuredClone(this.chart), label: s.label });
    this.app.chart = s.chart;
    this.afterChange(null);
    this.message(`やり直しました: ${s.label}`);
  }

  autosave() {
    clearTimeout(this._saveT);
    this._savePending = true;
    this._saveT = setTimeout(() => this.writeAutosave(), 300);
  }

  writeAutosave() {
    clearTimeout(this._saveT);
    this._savePending = false;
    const ok = (() => { try { localStorage.setItem(this.app.keys.autosave, exportChart(this.chart)); localStorage.setItem(this.app.keys.chartBase, this.app.distributedFingerprint); return true; } catch { return false; } })();
    this.saveFailed = !ok;
    this.root.querySelector('#edSaved').textContent = ok ? `自動保存（下書き） ${new Date().toLocaleTimeString()}` : '自動保存できません（ブラウザの保存領域が使えません。JSON を書き出してください）';
    this.refreshSource();
    return ok;
  }

  /** この端末のデフォルトとして保存（通常プレイと AUTO が次からもこの設定で起動する。公開版は変わらない） */
  saveDefault() {
    if (this.frameDraft) this.root.querySelector('[data-f=apply]')?.click();
    const text = exportChart(this.chart);
    try {
      localStorage.setItem(this.app.keys.deviceDefault, text);
      localStorage.removeItem(this.app.keys.autosave); // 下書きはデフォルトに入った
      localStorage.setItem(this.app.keys.chartBase, this.app.distributedFingerprint);
    } catch {
      this.message('保存できませんでした（ブラウザの保存領域が使えません）。JSON を書き出してください', 'error');
      return false;
    }
    clearTimeout(this._saveT); this._savePending = false; this.saveFailed = false;
    this.app.deviceDefault = normalizeChart(JSON.parse(text));
    this.app.deviceDefaultSavedAt = new Date().toISOString();
    try { localStorage.setItem(this.app.keys.deviceDefault + '.savedAt', this.app.deviceDefaultSavedAt); } catch { /* 表示用 */ }
    this.refreshSource();
    this.message('この端末のデフォルトとして保存しました（通常プレイと AUTO で使われます。公開版は変わりません）');
    return true;
  }

  /** 今の設定がどこから来ているか（配布時の初期設定／この端末のデフォルト／未保存の編集） */
  sourceState() {
    const cur = exportChart(this.chart);
    const def = this.app.deviceDefault ? exportChart(this.app.deviceDefault) : null;
    const init = exportChart(this.app.initialChart);
    if (def && cur === def) return 'default';
    if (!def && cur === init) return 'distributed';
    return 'edited';
  }

  refreshSource() {
    this.app.refreshChartSource?.();
    const el = this.root.querySelector('#edSource');
    if (!el) return;
    const st = this.sourceState();
    const at = this.app.deviceDefaultSavedAt ? new Date(this.app.deviceDefaultSavedAt).toLocaleString() : '';
    el.dataset.state = st;
    el.textContent = st === 'default' ? `使用中: この端末のデフォルト（保存 ${at}）`
      : st === 'distributed' ? '使用中: 配布時の初期設定（公開版の譜面）'
        : `使用中: 未保存の編集（下書き）${this.app.deviceDefault ? ' ／ この端末のデフォルトあり' : ''}。「この端末のデフォルトとして保存」で確定します`;
  }

  /** 保存されていない編集（補正欄の未適用の入力・自動保存の待ち・保存の失敗） */
  unsavedSummary() {
    const items = [];
    if (this.frameDraft) items.push(`コマ ${this.frameDraft.frame} の未適用の補正`);
    if (this._savePending) items.push('自動保存の前の編集');
    if (this.saveFailed) items.push('自動保存に失敗した編集（JSON の書き出しを推奨）');
    return items;
  }

  /** 未保存の編集を保存する（未適用の補正は適用してから保存）。保存できたら true */
  saveAll() {
    if (this.frameDraft) this.root.querySelector('[data-f=apply]')?.click();
    return this.writeAutosave();
  }

  /** 未保存の編集を捨てる（未適用の補正と、自動保存の前の編集）。保存済みの内容は変えない */
  discardUnsaved() {
    clearTimeout(this._saveT);
    this._savePending = false;
    this.frameDraft = null;
  }

  message(msg, kind = 'info') {
    const el = this.root.querySelector('#edMsg');
    el.textContent = msg;
    el.dataset.kind = kind;
  }

  // ---------- UI ----------
  build() {
    const r = this.root;
    r.innerHTML = `
    <div class="ed-row ed-transport">
      <button data-act="prevF" title="1 コマ戻る（←）">◀ 1コマ</button>
      <button data-act="play" id="edPlay">▶</button>
      <button data-act="nextF" title="1 コマ進む（→）">1コマ ▶</button>
      <span class="ed-time" id="edTime">0.00 秒 / コマ 0</span>
      <label>速度 <select id="edSpeed"><option value="1">1×</option><option value="0.5">0.5×</option><option value="0.25">0.25×</option></select></label>
      <label><input type="checkbox" id="edSnap"> コマにスナップ</label>
      <span class="ed-sep"></span>
      <button data-act="loopA" title="現在位置をループ開始に">ループ開始</button>
      <button data-act="loopB" title="現在位置をループ終了に">ループ終了</button>
      <label><input type="checkbox" id="edLoopOn"> 区間ループ</label>
      <span id="edLoop" class="ed-dim">未設定</span>
      <button data-act="loopSelect" title="ループ区間内のノーツを選択">区間内を選択</button>
    </div>
    <input type="range" id="edSeek" min="0" max="1" step="0.01" value="0" aria-label="再生位置">
    <div class="ed-tl-wrap">
      <canvas id="edTimeline" aria-label="編集タイムライン（ノーツをドラッグで移動、空いている所をクリックでシーク、ドラッグで範囲選択）"></canvas>
      <div class="ed-zoom"><button data-act="zoomIn" title="拡大">＋</button><button data-act="zoomOut" title="縮小">－</button></div>
    </div>
    <div class="ed-row">
      <span class="ed-label">追加（現在位置）</span>
      ${BUTTONS.map((b) => `<button data-add="${b}" class="ed-add" style="--c:${LANE_STYLE[b].color}">＋${b} ${BUTTON_INFO[b].meaning}</button>`).join('')}
      <button data-act="dup">複製</button>
      <button data-act="del">削除</button>
      <span class="ed-sep"></span>
      <label>まとめてずらす <input type="number" id="edShift" value="0.10" step="0.01" min="0" style="width:5em"> 秒</label>
      <button data-act="shiftL">← 早く</button><button data-act="shiftR">遅く →</button>
    </div>
    <div class="ed-cols">
      <section class="ed-box" id="edNote"><h3>ノーツ</h3><div id="edNoteBody"></div></section>
      <section class="ed-box" id="edSeq"><h3>連続コマンド</h3><div id="edSeqBody"></div></section>
      <section class="ed-box" id="edFrame"><h3>人物の位置・倍率（コマ単位の補正）</h3><div id="edFrameBody"></div></section>
      <section class="ed-box" id="edFile"><h3>保存・読み込み</h3>
        <div class="ed-row">
          <button data-act="undo">元に戻す</button><button data-act="redo">やり直す</button>
          <button data-act="saveDefault" class="ed-primary">この端末のデフォルトとして保存</button>
        </div>
        <p id="edSource" class="ed-src"></p>
        <div class="ed-row">
          <button data-act="revert" title="最後に「この端末のデフォルトとして保存」した状態（保存が無ければ配布時の初期設定）に戻す">編集前に戻す</button>
          <button data-act="reset" title="公開版に入っている譜面（charts/seipai_v2.json）に戻す">配布時の初期設定に戻す</button>
          <button data-act="dropDefault">この端末のデフォルトを消す</button>
        </div>
        <div class="ed-row">
          <button data-act="export">JSON を書き出す</button>
          <label class="ed-filebtn">JSON を読み込む<input type="file" id="edImport" accept="application/json,.json"></label>
        </div>
        <p class="ed-dim ed-note">「この端末のデフォルト」はこのブラウザにだけ保存され、保存後すぐに通常プレイと AUTO で使われます。<b>公開版は変わりません。</b>
          ほかの端末でも同じ設定で起動するには、JSON を書き出し、公開版の <code>charts/seipai_v2.json</code> に取り込んで公開し直してください（README「設定を公開版へ反映」）。</p>
        <p id="edSaved" class="ed-dim">自動保存（下書き）: まだ変更なし</p>
        <h3>編集メモ</h3>
        <textarea id="edMemo" rows="5"></textarea>
      </section>
    </div>
    <p id="edMsg" class="ed-msg" role="status"></p>`;
    r.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.add) this.addNote(b.dataset.add);
      else if (b.dataset.act) this.act(b.dataset.act, b);
    });
    const seek = r.querySelector('#edSeek');
    seek.max = String(this.app.duration);
    seek.addEventListener('input', () => this.app.seek(this.snapT(Number(seek.value))));
    r.querySelector('#edSpeed').addEventListener('change', (e) => this.app.setRate(Number(e.target.value)));
    r.querySelector('#edSnap').addEventListener('change', (e) => { this.snap = e.target.checked; });
    r.querySelector('#edLoopOn').addEventListener('change', (e) => {
      if (e.target.checked && (this.app.loop.a == null || this.app.loop.b == null)) {
        e.target.checked = false;
        this.message('ループ開始と終了を先に設定してください', 'error');
        return;
      }
      this.app.loop.on = e.target.checked;
      this.refreshLoop();
    });
    r.querySelector('#edImport').addEventListener('change', (e) => this.importFile(e.target.files?.[0], e.target));
    const memo = r.querySelector('#edMemo');
    memo.addEventListener('change', () => this.apply((c) => { c.memo = memo.value.split('\n').filter((l) => l.trim()); }, 'メモを変更'));
    this.tl = r.querySelector('#edTimeline');
    this.bindTimeline();
    window.addEventListener('keydown', (e) => {
      if (!this.app.editMode || e.target?.closest?.('input, select, textarea')) return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); this.redo(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); this.step(-1); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); this.step(1); }
      else if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); this.act('del'); }
    });
  }

  setOpen(on) {
    this.root.hidden = !on;
    if (on) this.refresh();
    this.pick = null;
  }

  syncState() {
    const p = this.root.querySelector('#edPlay');
    if (p) p.textContent = this.app.state === 'playing' ? '❚❚' : '▶';
  }

  syncRate(r) { const s = this.root.querySelector('#edSpeed'); if (s) s.value = String(r); }

  snapT(t) { return this.snap ? Math.round(t / FRAME) * FRAME : r2(t); }

  step(k) {
    this.app.pause();
    const fi = this.app.store.indexAt(Math.max(0, this.app.t));
    const to = Math.max(0, Math.min(this.app.store.count - 1, fi + k));
    this.app.seek(this.app.store.frames[to].t);
  }

  act(a) {
    const app = this.app;
    const t = Math.max(0, app.t);
    switch (a) {
      case 'play': app.togglePlay(); break;
      case 'prevF': this.step(-1); break;
      case 'nextF': this.step(1); break;
      case 'loopA': app.loop.a = this.snapT(t); if (app.loop.b != null && app.loop.b <= app.loop.a) app.loop.b = null; this.refreshLoop(); break;
      case 'loopB':
        if (app.loop.a == null || t <= app.loop.a) { this.message('ループ終了は開始より後にしてください', 'error'); break; }
        app.loop.b = this.snapT(t); this.refreshLoop(); break;
      case 'loopSelect':
        if (app.loop.a == null || app.loop.b == null) { this.message('ループ区間がありません', 'error'); break; }
        this.selected = new Set(this.chart.notes.filter((n) => n.time >= app.loop.a && n.time <= app.loop.b).map((n) => n.id));
        this.refresh(); break;
      case 'zoomIn': this.zoom = Math.max(2, this.zoom / 1.5); break;
      case 'zoomOut': this.zoom = Math.min(90, this.zoom * 1.5); break;
      case 'dup': this.duplicate(); break;
      case 'del':
        if (!this.selected.size) break;
        this.apply((c) => { c.notes = c.notes.filter((n) => !this.selected.has(n.id)); }, `${this.selected.size} 個のノーツを削除`);
        this.selected.clear(); this.refresh(); break;
      case 'shiftL': case 'shiftR': this.shiftSelected((a === 'shiftL' ? -1 : 1) * Number(this.root.querySelector('#edShift').value || 0)); break;
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'export': this.exportFile(); break;
      case 'saveDefault': this.saveDefault(); break;
      case 'revert': {
        const base = this.app.deviceDefault || this.app.initialChart;
        this.apply((c) => { const b = structuredClone(base); for (const k of Object.keys(c)) delete c[k]; Object.assign(c, b); }, this.app.deviceDefault ? '編集前（この端末のデフォルト）に戻す' : '編集前（配布時の初期設定）に戻す');
        break;
      }
      case 'reset':
        if (!confirm('配布時の初期設定（公開版の譜面）に戻しますか？\n今の編集内容は「元に戻す」で戻せます。この端末のデフォルトは、保存し直すまで残ります。')) break;
        this.apply((c) => { const init = structuredClone(this.app.initialChart); for (const k of Object.keys(c)) delete c[k]; Object.assign(c, init); }, '配布時の初期設定に戻す');
        break;
      case 'dropDefault':
        if (!this.app.deviceDefault) { this.message('この端末のデフォルトはありません'); break; }
        if (!confirm('この端末のデフォルトを消しますか？（次に開いたときは、下書きが無ければ配布時の初期設定で起動します）')) break;
        try { localStorage.removeItem(this.app.keys.deviceDefault); } catch { /* 保存領域なし */ }
        this.app.deviceDefault = null;
        this.refreshSource();
        this.message('この端末のデフォルトを消しました');
        break;
      default: break;
    }
  }

  addNote(button) {
    const t = this.snapT(Math.max(0, this.app.t));
    let id;
    const ok = this.apply((c) => {
      const n = makeNote(c.notes, button, t);
      if (button === 'A') n.effect = this.defaultStrikeEffect(t, n.action); // ほかはコマンドの既定のエフェクト（effect なし）
      // 選択中のノーツと同じ連続コマンドに入れる
      const sel = c.notes.find((x) => this.selected.has(x.id));
      if (sel?.sequenceId) n.sequenceId = sel.sequenceId;
      if (n.input === 'hold') n.duration = Math.max(0.2, Math.min(2.0, this.app.duration - t));
      id = n.id;
      c.notes.push(n);
    }, `${button} を ${t.toFixed(2)} 秒に追加`);
    if (ok) { this.selected = new Set([id]); this.refresh(); }
  }

  /** そのコマの手首・足首から、胴体から最も遠いものを打撃点にする */
  defaultStrikeEffect(t, action) {
    const fr = this.app.store.frames[this.app.store.indexAt(t)];
    const J = fr.joints;
    if (!J) return { id: 3 };
    const [ax, ay] = fr.anchor;
    // 蹴り: 高い方の足首（支持脚は床）／ 突き・打ち: 胴体の中心から最も遠い手首
    const best = action === 'kick'
      ? (J.left_ankle[1] < J.right_ankle[1] ? 'left_ankle' : 'right_ankle')
      : ['left_wrist', 'right_wrist'].reduce((a, b) => (Math.hypot(J[b][0] - ax, J[b][1] - ay) > Math.hypot(J[a][0] - ax, J[a][1] - ay) ? b : a));
    const base = { left_wrist: 'left_elbow', right_wrist: 'right_elbow', left_ankle: 'left_knee', right_ankle: 'right_knee' }[best];
    let dx = J[best][0] - J[base][0], dy = J[best][1] - J[base][1];
    const n = Math.hypot(dx, dy) || 1;
    dx /= n; dy /= n;
    const W = this.app.manifest.width, H = this.app.manifest.height;
    return { id: 3, origin: 'point', anchor: { x: r2(J[best][0] / W * 10) / 10, y: r2(J[best][1] / H * 10) / 10 }, angle: Math.round(Math.atan2(dy, dx) * 180 / Math.PI) };
  }

  duplicate() {
    if (!this.selected.size) return;
    const ids = [];
    const off = Number(this.root.querySelector('#edShift').value || 0.2) || 0.2;
    this.apply((c) => {
      for (const n of c.notes.filter((x) => this.selected.has(x.id))) {
        const d = makeNote(c.notes, n.button, Math.min(this.app.duration - (n.duration || 0), n.time + off), {
          action: n.action, label: n.label, sequenceId: n.sequenceId, ...(n.effect ? { effect: structuredClone(n.effect) } : {}),
          ...(n.input === 'hold' ? { duration: n.duration } : {}),
        });
        c.notes.push(d);
        ids.push(d.id);
      }
    }, `${this.selected.size} 個のノーツを複製`) && (this.selected = new Set(ids));
    this.refresh();
  }

  shiftSelected(dt) {
    if (!this.selected.size || !dt) return;
    this.apply((c) => {
      for (const n of c.notes) if (this.selected.has(n.id)) n.time = r2(Math.max(0, n.time + dt));
    }, `${this.selected.size} 個を ${dt > 0 ? '+' : ''}${dt.toFixed(2)} 秒ずらす`);
  }

  // ---------- タイムライン ----------
  view() {
    const t = Math.max(0, this.app.t);
    const w = this.zoom;
    let t0 = t - w * 0.35;
    t0 = Math.max(-0.5, Math.min(this.app.duration - w + 0.5, t0));
    return { t0, t1: t0 + w };
  }

  tlGeom() {
    const c = this.tl, r = c.getBoundingClientRect();
    const head = 18, labelW = 34;
    return { W: r.width, H: r.height, head, labelW, rowH: (r.height - head) / 4, rect: r };
  }

  bindTimeline() {
    const c = this.tl;
    let drag = null;
    const pos = (e) => { const g = this.tlGeom(); return { x: e.clientX - g.rect.left, y: e.clientY - g.rect.top, g }; };
    const timeAt = (x, g, v = this.view()) => v.t0 + ((x - g.labelW) / (g.W - g.labelW)) * (v.t1 - v.t0);
    const hit = (p) => {
      const v = this.view();
      for (const n of [...this.chart.notes].reverse()) {
        const row = LANE_ORDER.indexOf(n.button);
        const y0 = p.g.head + row * p.g.rowH;
        if (p.y < y0 || p.y > y0 + p.g.rowH) continue;
        const x0 = p.g.labelW + ((n.time - v.t0) / (v.t1 - v.t0)) * (p.g.W - p.g.labelW);
        const x1 = n.input === 'hold' ? p.g.labelW + ((n.time + n.duration - v.t0) / (v.t1 - v.t0)) * (p.g.W - p.g.labelW) : x0;
        if (p.x >= x0 - 8 && p.x <= x1 + 8) return { n, edge: n.input === 'hold' && Math.abs(p.x - x1) < 8 ? 'end' : 'start' };
      }
      return null;
    };
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const p = pos(e);
      const h = hit(p);
      const v = this.view();
      if (h) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          if (this.selected.has(h.n.id)) this.selected.delete(h.n.id); else this.selected.add(h.n.id);
        } else if (!this.selected.has(h.n.id)) this.selected = new Set([h.n.id]);
        drag = { kind: h.edge === 'end' ? 'dur' : 'move', x0: p.x, v, id: h.n.id, moved: false, orig: new Map(this.chart.notes.map((n) => [n.id, { time: n.time, duration: n.duration }])) };
        this.refresh();
      } else {
        drag = { kind: 'box', x0: p.x, y0: p.y, x1: p.x, y1: p.y, v, moved: false, add: e.shiftKey };
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = pos(e);
      if (Math.abs(p.x - drag.x0) > 3) drag.moved = true;
      if (drag.kind === 'box') { drag.x1 = p.x; drag.y1 = p.y; this.drawTimeline(drag); return; }
      if (!drag.moved) return;
      const dt = timeAt(p.x, p.g, drag.v) - timeAt(drag.x0, p.g, drag.v);
      drag.dt = dt;
      this.drawTimeline(drag);
    });
    const end = (e) => {
      if (!drag) return;
      const p = pos(e);
      const d = drag;
      drag = null;
      if (d.kind === 'box') {
        if (!d.moved) { this.app.pause(); this.app.seek(this.snapT(Math.max(0, timeAt(p.x, p.g, d.v)))); if (!d.add) this.selected.clear(); this.refresh(); return; }
        const ta = timeAt(Math.min(d.x0, d.x1), p.g, d.v), tb = timeAt(Math.max(d.x0, d.x1), p.g, d.v);
        const ra = Math.floor((Math.min(d.y0, d.y1) - p.g.head) / p.g.rowH), rb = Math.floor((Math.max(d.y0, d.y1) - p.g.head) / p.g.rowH);
        const sel = d.add ? new Set(this.selected) : new Set();
        for (const n of this.chart.notes) {
          const row = LANE_ORDER.indexOf(n.button);
          if (n.time >= ta && n.time <= tb && row >= ra && row <= rb) sel.add(n.id);
        }
        this.selected = sel;
        this.refresh();
        return;
      }
      if (!d.moved || !d.dt) { const n = this.chart.notes.find((x) => x.id === d.id); if (n) { this.app.pause(); this.app.seek(n.time); } this.refresh(); return; }
      if (d.kind === 'dur') {
        this.apply((c) => { const n = c.notes.find((x) => x.id === d.id); n.duration = Math.max(0.2, this.snapT(d.orig.get(d.id).duration + d.dt)); }, '長押し時間を変更');
      } else {
        this.apply((c) => {
          for (const n of c.notes) if (this.selected.has(n.id)) n.time = Math.max(0, this.snapT(d.orig.get(n.id).time + d.dt));
        }, `${this.selected.size} 個のノーツを移動`);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', () => { drag = null; this.drawTimeline(); });
    c.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (e.ctrlKey) this.zoom = Math.max(2, Math.min(90, this.zoom * (e.deltaY > 0 ? 1.2 : 1 / 1.2)));
      else this.app.seek(Math.max(0, this.app.t + e.deltaX / 200));
    }, { passive: false });
  }

  drawTimeline(drag = null) {
    const c = this.tl;
    if (!c || this.root.hidden) return;
    const g = this.tlGeom();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(g.W * dpr) || c.height !== Math.round(g.H * dpr)) { c.width = Math.round(g.W * dpr); c.height = Math.round(g.H * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.W, g.H);
    ctx.fillStyle = '#17110c';
    ctx.fillRect(0, 0, g.W, g.H);
    const v = this.view();
    const X = (t) => g.labelW + ((t - v.t0) / (v.t1 - v.t0)) * (g.W - g.labelW);
    // ループ区間
    const L = this.app.loop;
    if (L.a != null) {
      ctx.fillStyle = L.on ? 'rgba(80,160,255,0.18)' : 'rgba(80,160,255,0.08)';
      ctx.fillRect(X(L.a), 0, (L.b != null ? X(L.b) : X(L.a) + 2) - X(L.a), g.H);
    }
    // 目盛り（1 秒・コマ）
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const pxPerS = (g.W - g.labelW) / (v.t1 - v.t0);
    for (const tk of timeTicks(v.t0, v.t1, pxPerS)) { // 成績画面の照合タイムラインと同じ目盛り（timeline.js）
      const x = X(tk.t);
      ctx.fillStyle = tk.whole ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.08)';
      ctx.fillRect(x, tk.whole ? 0 : g.head - 4, 1, tk.whole ? g.H : g.H - g.head + 4);
      if (tk.label) { ctx.fillStyle = '#cbb9a3'; ctx.fillText(tk.label, x + 2, 2); }
    }
    LANE_ORDER.forEach((b, k) => {
      const y = g.head + k * g.rowH;
      ctx.fillStyle = k % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)';
      ctx.fillRect(g.labelW, y, g.W - g.labelW, g.rowH);
      ctx.fillStyle = LANE_STYLE[b].color;
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(b, 6, y + g.rowH / 2);
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#a8957f';
      ctx.fillText(BUTTON_INFO[b].meaning, 17, y + g.rowH / 2);
    });
    // ノーツ（ドラッグ中はずらした位置で表示）
    for (const n of this.chart.notes) {
      let t = n.time, dur = n.duration || 0;
      if (drag?.dt && drag.kind === 'move' && this.selected.has(n.id)) t = Math.max(0, this.snapT(n.time + drag.dt));
      if (drag?.dt && drag.kind === 'dur' && n.id === drag.id) dur = Math.max(0.2, this.snapT(n.duration + drag.dt));
      if (t + dur < v.t0 - 1 || t > v.t1 + 1) continue;
      const k = LANE_ORDER.indexOf(n.button), y = g.head + k * g.rowH, st = LANE_STYLE[n.button];
      const sel = this.selected.has(n.id);
      const x = X(t);
      if (n.input === 'hold') {
        ctx.fillStyle = `rgba(${st.rgb},0.45)`;
        ctx.fillRect(x, y + g.rowH * 0.25, X(t + dur) - x, g.rowH * 0.5);
        ctx.fillStyle = st.color;
        ctx.fillRect(X(t + dur) - 3, y + g.rowH * 0.15, 3, g.rowH * 0.7);
      }
      ctx.fillStyle = st.color;
      ctx.fillRect(x - 4, y + 3, 8, g.rowH - 6);
      if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(x - 6, y + 1, 12, g.rowH - 2); }
      if (pxPerS > 25) {
        ctx.fillStyle = '#f2e6d8';
        ctx.font = '10px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif';
        ctx.fillText(n.label, x + 7, y + g.rowH / 2);
      }
    }
    // 範囲選択
    if (drag?.kind === 'box' && drag.moved) {
      ctx.strokeStyle = '#fff'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.setLineDash([]);
    }
    // 再生位置
    const px = X(Math.max(0, this.app.t));
    ctx.fillStyle = '#ff5a3c';
    ctx.fillRect(px - 1, 0, 2, g.H);
  }

  // ---------- 右側の各欄 ----------
  refresh() {
    if (this.root.hidden) return;
    this.renderNoteBox();
    this.renderSeqBox();
    this.renderFrameBox();
    this.refreshLoop();
    this.refreshSource();
    const memo = this.root.querySelector('#edMemo');
    if (document.activeElement !== memo) memo.value = (this.chart.memo || []).join('\n');
    this.drawTimeline();
  }

  refreshLoop() {
    const L = this.app.loop;
    this.root.querySelector('#edLoop').textContent = L.a == null ? '未設定' : `${L.a.toFixed(2)} 〜 ${L.b != null ? L.b.toFixed(2) : '?'} 秒${L.on ? '（ループ中）' : ''}`;
    this.root.querySelector('#edLoopOn').checked = L.on;
  }

  selNotes() { return this.chart.notes.filter((n) => this.selected.has(n.id)); }

  renderNoteBox() {
    const box = this.root.querySelector('#edNoteBody');
    const sel = this.selNotes();
    if (sel.length !== 1) {
      box.innerHTML = sel.length ? `<p>${sel.length} 個を選択中。「まとめてずらす」「複製」「削除」、または右の欄で連続コマンドにまとめられます。</p>`
        : '<p class="ed-dim">タイムラインのノーツをクリックして選択（Shift で追加選択、空いている所をドラッグで範囲選択）。</p>';
      return;
    }
    const n = sel[0];
    const info = BUTTON_INFO[n.button];
    const fx = resolveEffect(n), def = fx.def;
    const fi = this.app.store.indexAt(n.time);
    const custom = n.effect?.id != null;
    const rng = (id, k, v, step, unit = '') => `<input id="${id}" type="range" min="${RANGES[k][0]}" max="${RANGES[k][1]}" step="${step}" value="${v}"><output for="${id}">${(+v).toFixed(2)}${unit}</output>`;
    box.innerHTML = `
      <p class="ed-noteid"><b>${esc(n.id)}</b>　${n.time.toFixed(2)} 秒${n.input === 'hold' ? `〜${(n.time + n.duration).toFixed(2)} 秒` : ''}　コマ ${fi}　<span class="ed-glyph" style="color:${LANE_STYLE[n.button].color}">${GLYPH[n.button]}</span>／${n.button}</p>
      <h4>コマンド</h4>
      <div class="ed-grid">
        <label for="nButton">コマンド種別</label><span><select id="nButton">${BUTTONS.map((b) => `<option value="${b}" ${b === n.button ? 'selected' : ''}>${GLYPH[b]}（${b}・${BUTTON_INFO[b].meaning}）</option>`).join('')}</select>
          <small class="ed-dim">変えると文字・入力ボタンがそろって変わり、エフェクトはそのコマンドの既定に戻ります</small></span>
        <label for="nAction">動作</label><span><select id="nAction">${info.actions.map((a) => `<option value="${a}" ${a === n.action ? 'selected' : ''}>${ACTION_LABEL[a]}（${a}）</option>`).join('')}</select></span>
        <label for="nTime">時刻（秒）</label><span><input id="nTime" type="number" step="0.01" min="0" value="${n.time}"> <button data-n="toHere">現在位置へ</button> <button data-n="seek">ここへ移動</button></span>
        <label for="nLabel">表示名</label><span><input id="nLabel" type="text" value="${esc(n.label)}" maxlength="20"></span>
        ${n.input === 'hold' ? `<label for="nDur">長押し時間（秒）</label><span><input id="nDur" type="number" step="0.01" min="0.2" value="${n.duration}"></span>` : ''}
        <label for="nSeq">連続コマンド</label><span><select id="nSeq"><option value="">（なし）</option>${this.chart.sequences.map((s) => `<option value="${esc(s.id)}" ${s.id === n.sequenceId ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
          <button data-n="earlier" title="同じまとまりの前のノーツとコマンドを入れ替え（時刻はそのまま）">◀ 順番</button><button data-n="later" title="同じまとまりの次のノーツとコマンドを入れ替え">順番 ▶</button></span>
      </div>
      <h4>視覚エフェクト <small class="ed-dim">${custom ? 'このノーツで個別に指定' : `コマンドの既定（No.${fx.id}）`}</small></h4>
      <div class="ed-fxlist" role="listbox" aria-label="エフェクト（番号＋名称＋プレビュー）">${EFFECTS.map((e) => `
        <button class="ed-fx ${e.id === fx.id ? 'on' : ''}" data-fx="${e.id}" role="option" aria-selected="${e.id === fx.id}" title="${esc(e.desc)}">
          <canvas width="96" height="112" data-pv="${e.id}"></canvas><span>No.${e.id} ${esc(e.name)}</span></button>`).join('')}
      </div>
      <div class="ed-row"><button data-n="try" class="ed-primary">この動作で試す</button><button data-n="loop">前後を繰り返し再生</button>
        <button data-n="fxDefault" ${custom ? '' : 'disabled'}>このノーツのエフェクトを既定に戻す</button></div>
      <div class="ed-grid">
        <label for="eOrigin">発生位置</label><span><select id="eOrigin" ${fx.id === 0 ? 'disabled' : ''}>${ORIGINS.map((o) => `<option value="${o.key}" ${o.key === fx.origin ? 'selected' : ''} ${o.key === 'point' && !fx.anchor ? 'disabled' : ''}>${esc(o.name)}</option>`).join('')}</select>
          <button data-n="pickAnchor" ${fx.id === 0 ? 'disabled' : ''}>画面で指定</button></span>
        <label>位置の調整</label><span>左右 ${rng('eOx', 'offset', fx.offset.x, 0.01)}　上下 ${rng('eOy', 'offset', fx.offset.y, 0.01)}</span>
        <label for="eAng">方向・角度</label><span>${def.directional
          ? `<input id="eAng" type="range" min="-180" max="180" step="1" value="${fx.angle ?? 0}"><output for="eAng">${fx.angle != null ? `${fx.angle}°` : '自動'}</output>
             <button data-n="pickDir">画面で指定</button>${def.key === 'strike' ? '<button data-n="autoFx">関節から自動</button>' : ''}<button data-n="angAuto">自動に戻す</button>`
          : '<span class="ed-dim">このエフェクトは向きを使いません</span>'}</span>
        <label>大きさ</label><span>${rng('eSize', 'size', fx.size, 0.05, '×')}</span>
        <label>強さ</label><span>${rng('eInt', 'intensity', fx.intensity, 0.05)}</span>
        <label>持続時間</label><span>${rng('eDur', 'duration', fx.duration, 0.05, ' 秒')}</span>
      </div>
      ${this.pick ? `<p class="ed-pick">${this.pick === 'anchor' ? 'ステージ上の発生位置（拳・足など）をクリック' : '向きの先をクリック'}（Esc で中止）</p>` : ''}`;
    const q = (s) => box.querySelector(s);
    const upd = (fn, label) => this.apply((c) => fn(c.notes.find((x) => x.id === n.id), c), label);
    /** effect を変える（保存値に番号を入れて「個別に指定」にする）。変更後に試す */
    const setFx = (fn, label) => { if (upd((x) => { x.effect = { id: effectIdOf(x), ...(x.effect || {}) }; delete x.effect.preset; fn(x.effect, x); }, label)) this.tryEffect(); };
    q('#nTime').addEventListener('change', (e) => upd((x) => { x.time = this.snapT(Number(e.target.value)); }, '時刻を変更'));
    q('#nButton').addEventListener('change', (e) => upd((x) => {
      const b = e.target.value, bi = BUTTON_INFO[b];
      x.button = b; x.action = bi.defaultAction; x.input = bi.input; x.label = ACTION_LABEL[x.action];
      if (bi.input === 'hold') x.duration = x.duration || 2; else delete x.duration;
      // 前のコマンドの方向・打撃点などを残さない（撃は関節から打撃点を作る。ほかはコマンドの既定）
      if (b === 'A') x.effect = this.defaultStrikeEffect(x.time, x.action); else delete x.effect;
    }, `コマンドを ${GLYPH[e.target.value]} に変更`));
    q('#nAction').addEventListener('change', (e) => upd((x) => {
      const wasDefault = x.label === ACTION_LABEL[x.action];
      x.action = e.target.value;
      if (wasDefault) x.label = ACTION_LABEL[x.action];
    }, '動作を変更'));
    q('#nLabel').addEventListener('change', (e) => upd((x) => { x.label = e.target.value.trim() || ACTION_LABEL[x.action]; }, '表示名を変更'));
    q('#nDur')?.addEventListener('change', (e) => upd((x) => { x.duration = Math.max(0.2, r2(Number(e.target.value))); }, '長押し時間を変更'));
    q('#nSeq').addEventListener('change', (e) => upd((x) => { x.sequenceId = e.target.value || null; }, '連続コマンドを変更'));
    box.querySelectorAll('[data-fx]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.fx);
      if (upd((x) => {
        // 種類を変えたら、前の種類の方向・位置・大きさなどは残さない（打撃へ変えたときは関節から打撃点を作る）
        const keep = EFFECT_BY_ID.get(id).key === 'strike' ? (x.effect?.anchor ? { anchor: x.effect.anchor, angle: angleOf(x.effect) } : this.defaultStrikeEffect(x.time, x.action)) : {};
        x.effect = effectForId(id, keep);
      }, `エフェクトを No.${id} ${EFFECT_BY_ID.get(id).name} に変更`)) this.tryEffect();
    }));
    q('#eOrigin').addEventListener('change', (e) => setFx((ef) => { ef.origin = e.target.value; }, '発生位置を変更'));
    const slider = (id, label, fn, fmt = (v) => v.toFixed(2)) => {
      const el = q(id);
      if (!el) return;
      const out = el.nextElementSibling;
      el.addEventListener('input', () => { if (out) out.textContent = fmt(Number(el.value)); });
      el.addEventListener('change', () => setFx((ef) => fn(ef, Number(el.value)), label));
    };
    slider('#eOx', '位置（左右）を調整', (ef, v) => { ef.offset = { x: v, y: ef.offset?.y ?? 0 }; });
    slider('#eOy', '位置（上下）を調整', (ef, v) => { ef.offset = { x: ef.offset?.x ?? 0, y: v }; });
    slider('#eAng', '向きを変更', (ef, v) => { ef.angle = v; delete ef.direction; }, (v) => `${v}°`);
    slider('#eSize', '大きさを変更', (ef, v) => { ef.size = v; }, (v) => `${v.toFixed(2)}×`);
    slider('#eInt', '強さを変更', (ef, v) => { ef.intensity = v; });
    slider('#eDur', '持続時間を変更', (ef, v) => { ef.duration = v; }, (v) => `${v.toFixed(2)} 秒`);
    box.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.n;
      if (k === 'toHere') upd((x) => { x.time = this.snapT(Math.max(0, this.app.t)); }, '時刻を現在位置へ');
      else if (k === 'seek') { this.app.pause(); this.app.seek(n.time); }
      else if (k === 'try') this.tryEffect();
      else if (k === 'loop') this.loopAround(n);
      else if (k === 'fxDefault') upd((x) => { if (x.button === 'A') x.effect = this.defaultStrikeEffect(x.time, x.action); else delete x.effect; }, 'エフェクトを既定に戻す');
      else if (k === 'pickAnchor' || k === 'pickDir') { this.app.pause(); this.app.seek(n.time); this.pick = k === 'pickAnchor' ? 'anchor' : 'direction'; this.renderNoteBox(); }
      else if (k === 'autoFx') setFx((ef, x) => { const d = this.defaultStrikeEffect(x.time, x.action); ef.origin = d.origin; ef.anchor = d.anchor; ef.angle = d.angle; delete ef.direction; }, '打撃点と向きを関節から設定');
      else if (k === 'angAuto') setFx((ef) => { delete ef.angle; delete ef.direction; }, '向きを自動に戻す');
      else if (k === 'earlier' || k === 'later') this.reorder(n, k === 'earlier' ? -1 : 1);
    }));
    this.drawThumbs(n);
  }

  // ---------- エフェクトのプレビュー ----------
  /** 一覧の小さなプレビュー: このノーツのコマに、各エフェクトの見え方（最も強い頃）を重ねる */
  async drawThumbs(n) {
    const fi = this.app.store.indexAt(n.time);
    const token = (this._thumbToken = (this._thumbToken || 0) + 1);
    await this.app.store.warm(fi);
    if (token !== this._thumbToken) return;
    this.thumbFx ||= new Effects();
    const store = this.app.store, fr = store.frames[fi];
    for (const cv of this.root.querySelectorAll('canvas[data-pv]')) {
      const id = Number(cv.dataset.pv), e = EFFECT_BY_ID.get(id);
      const W = cv.width, H = cv.height, standH = H * 0.62;
      const s = standH * fr.k, ox = W / 2, oy = H * 0.52;
      const T = (f) => ({
        s, ox, oy, toScreen: (x, y) => [ox + (x - f.anchor[0]) * s, oy + (y - f.anchor[1]) * s], toSource: (X, Y) => [f.anchor[0] + (X - ox) / s, f.anchor[1] + (Y - oy) / s],
        crop() { const [x, y, w, h] = f.crop; const [X, Y] = this.toScreen(x, y); return { x: X, y: Y, w: w * s, h: h * s }; },
      });
      const fxv = resolveEffect({ ...n, effect: { ...(n.effect || {}), id } });
      if (id !== effectIdOf(n)) { fxv.offset = { x: 0, y: 0 }; fxv.size = 1; fxv.origin = e.key === 'strike' && n.effect?.anchor ? 'point' : 'auto'; }
      const S = { t: 50, store, frameIndex: fi, transformFor: (i) => T(store.frames[i]), standH, canvas: null, dpr: 1 };
      const g = cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#3a2a1c'); bg.addColorStop(1, '#1a120c');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      const F = this.thumbFx;
      F.clear();
      const dir = fxv.direction ?? n.effect?.direction ?? (e.key === 'turn' ? { x: 1, y: 0 } : null);
      if (e.key !== 'none') F.trigger(e.key, { t: 50 - (e.key === 'breath' ? 0.15 : 0.08) * fxv.duration, grade: 'PERFECT', frameIndex: fi, action: n.action, fx: fxv, direction: dir, seed: 3, hold: true });
      try {
        F.renderUnder(g, S);
        const b = store.get(fi);
        if (b) { const r = T(store.frames[b.index]).crop(); g.drawImage(b.bmp, r.x, r.y, r.w, r.h); }
        F.renderOver(g, S);
      } catch (err) { console.warn('preview', err); }
      F.clear();
    }
  }

  /** 選んだエフェクトを、そのノーツの動作の画像に重ねてすぐ試す（一時停止のまま、そのコマで演出だけ動かす） */
  tryEffect() {
    const n = this.selNotes()[0];
    if (!n) return;
    this.app.pause();
    if (Math.abs(this.app.t - n.time) > 0.01) this.app.seek(n.time);
    this.previewFx ||= new Effects();
    this.previewFx.clear();
    const fx = resolveEffect(n);
    this.preview = { id: n.id, fx, key: fx.key, fi: this.app.store.indexAt(n.time), start: performance.now(), grow: n.input === 'hold' && fx.key === 'breath' ? 0.9 : 0 /* 長押し: 保持中 → 成功（プレイと同じ表現） */, action: n.action, direction: fx.direction ?? n.effect?.direction ?? null, fired: false };
    this.message(`No.${fx.id} ${fx.def.name} を ${n.id}（${n.time.toFixed(2)} 秒）で試しています`);
  }

  /** ノーツの前後の短い区間を繰り返し再生（A–B ループを使う） */
  loopAround(n) {
    const a = Math.max(0, n.time - 1.0), b = Math.min(this.app.duration, n.time + (n.duration || 0) + 1.2);
    this.app.loop.a = r2(a); this.app.loop.b = r2(b); this.app.loop.on = true;
    this.refreshLoop();
    this.app.seek(a);
    if (this.app.state !== 'playing') this.app.togglePlay();
    this.message(`${n.id} の前後（${a.toFixed(2)}〜${b.toFixed(2)} 秒）を繰り返し再生中（区間ループを外すと止まります）`);
  }

  /** ステージにプレビューを描く（main の draw から。人物の前後） */
  drawPreview(ctx, S, side) {
    const pv = this.preview;
    if (!pv || !this.app.editMode) return;
    if (this.app.state === 'playing') { this.preview = null; this.previewFx?.clear(); return; }
    const el = (performance.now() - pv.start) / 1000;
    if (el > pv.grow + pv.fx.duration + 0.4) { this.preview = null; this.previewFx.clear(); return; }
    const F = this.previewFx, T0 = 1000, t = T0 + el;
    if (side === 'under') {
      if (pv.grow && el < pv.grow) F.setHold({ id: 'pv', key: pv.key, fx: pv.fx, progress: el / pv.grow }, t);
      else {
        if (pv.grow) F.holdDone('pv');
        F.setHold(null, t);
        if (!pv.fired && pv.key !== 'none') { pv.fired = true; F.trigger(pv.key, { t: T0 + pv.grow, grade: 'PERFECT', frameIndex: pv.fi, action: pv.action, fx: pv.fx, direction: pv.direction, seed: 5, hold: !!pv.grow }); }
      }
    }
    const S2 = { ...S, t };
    if (side === 'under') F.renderUnder(ctx, S2);
    else { F.renderHold(ctx, S2); F.renderOver(ctx, S2); }
  }

  /** 同じ連続コマンドの隣のノーツとコマンドの内容を入れ替える（時刻の並びはそのまま） */
  reorder(n, dir) {
    if (!n.sequenceId) { this.message('連続コマンドに入っていないノーツです', 'error'); return; }
    const seq = this.chart.notes.filter((x) => x.sequenceId === n.sequenceId).sort((a, b) => a.time - b.time);
    const k = seq.findIndex((x) => x.id === n.id), j = k + dir;
    if (j < 0 || j >= seq.length) return;
    const other = seq[j];
    this.apply((c) => {
      const a = c.notes.find((x) => x.id === n.id), b = c.notes.find((x) => x.id === other.id);
      const ta = a.time, tb = b.time;
      a.time = tb; b.time = ta;
      if (a.input === 'hold' && a.time + a.duration > this.app.duration) a.duration = Math.max(0.2, this.app.duration - a.time);
      if (b.input === 'hold' && b.time + b.duration > this.app.duration) b.duration = Math.max(0.2, this.app.duration - b.time);
    }, 'コマンドの順番を入れ替え');
  }

  renderSeqBox() {
    const box = this.root.querySelector('#edSeqBody');
    const seqs = this.chart.sequences;
    const count = (id) => this.chart.notes.filter((n) => n.sequenceId === id).length;
    box.innerHTML = `
      <div class="ed-row"><button data-s="group">選択中のノーツを新しいまとまりに</button><button data-s="ungroup">選択中をまとまりから外す</button></div>
      <ol class="ed-seqlist">${seqs.map((s, i) => `<li data-id="${esc(s.id)}">
        <input type="text" value="${esc(s.label)}" data-s="label" aria-label="まとまりの名前">
        <span class="ed-dim">${count(s.id)} 個</span>
        <button data-s="sel" title="このまとまりのノーツを選択">選択</button>
        <button data-s="up" ${i === 0 ? 'disabled' : ''} title="一覧で上へ">↑</button><button data-s="down" ${i === seqs.length - 1 ? 'disabled' : ''} title="一覧で下へ">↓</button>
        <button data-s="rm" title="まとまりを削除（ノーツは残る）">×</button></li>`).join('')}</ol>`;
    box.querySelectorAll('button[data-s]').forEach((b) => b.addEventListener('click', () => {
      const id = b.closest('li')?.dataset.id;
      const k = b.dataset.s;
      if (k === 'group') {
        if (!this.selected.size) { this.message('まとめるノーツを選択してください', 'error'); return; }
        let nid = 'seq-01', i = 1;
        while (seqs.some((s) => s.id === nid)) nid = `seq-${String(++i).padStart(2, '0')}`;
        this.apply((c) => { c.sequences.push({ id: nid, label: `連続コマンド ${i}` }); for (const n of c.notes) if (this.selected.has(n.id)) n.sequenceId = nid; }, '連続コマンドを作成');
      } else if (k === 'ungroup') this.apply((c) => { for (const n of c.notes) if (this.selected.has(n.id)) n.sequenceId = null; }, 'まとまりから外す');
      else if (k === 'sel') { this.selected = new Set(this.chart.notes.filter((n) => n.sequenceId === id).map((n) => n.id)); this.refresh(); }
      else if (k === 'up' || k === 'down') this.apply((c) => {
        const i = c.sequences.findIndex((s) => s.id === id), j = i + (k === 'up' ? -1 : 1);
        [c.sequences[i], c.sequences[j]] = [c.sequences[j], c.sequences[i]];
      }, 'まとまりの順番を変更');
      else if (k === 'rm') this.apply((c) => { c.sequences = c.sequences.filter((s) => s.id !== id); for (const n of c.notes) if (n.sequenceId === id) n.sequenceId = null; }, 'まとまりを削除');
    }));
    box.querySelectorAll('input[data-s=label]').forEach((inp) => inp.addEventListener('change', () => {
      const id = inp.closest('li').dataset.id;
      this.apply((c) => { c.sequences.find((s) => s.id === id).label = inp.value.trim() || id; }, 'まとまりの名前を変更');
    }));
  }

  /**
   * 人物の位置・倍率の補正欄。
   * 入力を始めた時点で「下書き」（対象のコマ番号と入力中の値）を作り、再生を一時停止する。
   * 下書きがある間は、コマが変わっても欄を作り直さず、値も対象のコマも変えない（適用か取り消しで終わる）。
   */
  renderFrameBox() {
    const box = this.root.querySelector('#edFrameBody');
    const cur = this.app.store.indexAt(Math.max(0, this.app.t));
    const draft = this.frameDraft;
    const fi = draft ? draft.frame : cur;
    const d = this.chart.display;
    const ov = d.frameOverrides[fi] || d.frameOverrides[String(fi)] || {};
    const val = (k, def) => (draft ? draft[k] : String(ov[k] ?? def));
    this._frameShown = cur;
    box.innerHTML = `
      <p>補正の対象: コマ <b>${fi}</b>（${this.app.store.frames[fi].t.toFixed(1)} 秒）${Object.keys(ov).length ? '：<b>補正あり</b>' : ''}　補正のあるコマ: ${Object.keys(d.frameOverrides).length}</p>
      <p class="ed-pick ed-draft" id="fDraft" style="visibility:${draft ? 'visible' : 'hidden'}">未適用の補正があります（コマ ${fi}）。「このコマに適用」か「取り消し」を押してください。<span id="fShown"></span></p>
      <div class="ed-grid">
        <label for="fDx">左右（背景の高さ比）</label><span><input id="fDx" data-k="dx" type="number" step="0.005" value="${esc(val('dx', 0))}"></span>
        <label for="fDy">上下（背景の高さ比）</label><span><input id="fDy" data-k="dy" type="number" step="0.005" value="${esc(val('dy', 0))}"></span>
        <label for="fSc">倍率</label><span><input id="fSc" data-k="scale" type="number" step="0.01" min="0.3" max="3" value="${esc(val('scale', 1))}"></span>
      </div>
      <div class="ed-row"><button data-f="apply">このコマに適用</button><button data-f="cancel" ${draft ? '' : 'disabled'}>取り消し</button>
        <button data-f="goto" ${draft ? '' : 'disabled'}>対象のコマを表示</button>
        <button data-f="copyPrev">前のコマの補正をコピー</button><button data-f="clear">このコマの補正を消す</button></div>
      <hr>
      <div class="ed-grid">
        <label for="dRef">直立時の高さ（背景の高さ比）</label><span><input id="dRef" type="number" step="0.01" min="0.2" max="1" value="${d.referenceHeightRatio}"></span>
        <label for="dAx">人物の中心 x / y</label><span><input id="dAx" type="number" step="0.01" min="0" max="1" value="${d.subjectAnchor.x}"> <input id="dAy" type="number" step="0.01" min="0" max="1" value="${d.subjectAnchor.y}"></span>
      </div>`;
    this.updateFrameShown();
    const q = (s) => box.querySelector(s);
    const startDraft = () => {
      if (this.frameDraft) return;
      this.app.pause(); // 編集を始めたら背景の再生を止める
      const now = this.app.store.indexAt(Math.max(0, this.app.t));
      this.frameDraft = { frame: now, dx: q('#fDx').value, dy: q('#fDy').value, scale: q('#fSc').value };
      q('#fDraft').style.visibility = 'visible'; // 場所は最初から確保（入力欄の位置がずれないように）
      q('[data-f=cancel]').disabled = false;
      q('[data-f=goto]').disabled = false;
    };
    for (const inp of box.querySelectorAll('input[data-k]')) {
      inp.addEventListener('focus', startDraft);
      inp.addEventListener('input', () => { startDraft(); this.frameDraft[inp.dataset.k] = inp.value; });
    }
    box.querySelectorAll('button[data-f]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.f;
      const target = this.frameDraft ? this.frameDraft.frame : this.app.store.indexAt(Math.max(0, this.app.t));
      if (k === 'apply') {
        const v = { dx: Number(q('#fDx').value) || 0, dy: Number(q('#fDy').value) || 0, scale: Number(q('#fSc').value) || 1 };
        this.frameDraft = null;
        this.apply((c) => {
          delete c.display.frameOverrides[String(target)];
          if (v.dx || v.dy || v.scale !== 1) c.display.frameOverrides[target] = v;
        }, `コマ ${target} の位置・倍率を補正`);
        this.renderFrameBox();
      } else if (k === 'cancel') {
        this.frameDraft = null;
        this.renderFrameBox();
        this.message(`コマ ${target} の未適用の補正を取り消しました`);
      } else if (k === 'goto') {
        this.app.pause();
        this.app.seek(this.app.store.frames[target].t);
      } else if (k === 'copyPrev') {
        const pv = d.frameOverrides[target - 1];
        if (!pv) { this.message('前のコマに補正がありません', 'error'); return; }
        this.frameDraft = null;
        this.apply((c) => { c.display.frameOverrides[target] = { ...pv }; }, `コマ ${target - 1} の補正をコピー`);
      } else if (k === 'clear') {
        this.frameDraft = null;
        this.apply((c) => { delete c.display.frameOverrides[target]; delete c.display.frameOverrides[String(target)]; }, `コマ ${target} の補正を消す`);
      }
    }));
    q('#dRef').addEventListener('change', (e) => this.apply((c) => { c.display.referenceHeightRatio = Math.max(0.2, Math.min(1, Number(e.target.value) || 0.55)); }, '人物の大きさを変更'));
    for (const id of ['#dAx', '#dAy']) q(id).addEventListener('change', () => this.apply((c) => {
      c.display.subjectAnchor = { x: Math.max(0, Math.min(1, Number(q('#dAx').value))), y: Math.max(0, Math.min(1, Number(q('#dAy').value))) };
    }, '人物の中心を変更'));
  }

  /** 下書き中に表示しているコマが対象と違うときの案内（欄は作り直さない） */
  updateFrameShown() {
    const el = this.root.querySelector('#fShown');
    if (!el) return;
    const cur = this.app.store.indexAt(Math.max(0, this.app.t));
    el.textContent = this.frameDraft && cur !== this.frameDraft.frame ? ` 現在表示しているのはコマ ${cur} です。` : '';
  }

  // ---------- 画面で位置を指定 ----------
  bindStagePick() {
    const cv = this.app.canvas;
    cv.addEventListener('pointerdown', (e) => {
      if (!this.app.editMode || !this.pick) return;
      const sel = this.selNotes();
      if (sel.length !== 1) { this.pick = null; return; }
      const r = cv.getBoundingClientRect();
      const X = e.clientX - r.left, Y = e.clientY - r.top;
      const n = sel[0];
      const fi = this.app.store.indexAt(n.time);
      const T = this.app.transformFor(fi);
      const [sx, sy] = T.toSource(X, Y);
      const W = this.app.manifest.width, H = this.app.manifest.height;
      const fixed = (x) => { x.effect = { id: effectIdOf(x), ...(x.effect || {}) }; delete x.effect.preset; return x.effect; };
      if (this.pick === 'anchor') {
        this.apply((c) => { const ef = fixed(c.notes.find((k) => k.id === n.id)); ef.origin = 'point'; ef.anchor = { x: r2(Math.max(0, Math.min(1, sx / W)) * 1000) / 1000, y: r2(Math.max(0, Math.min(1, sy / H)) * 1000) / 1000 }; delete ef.offset; }, '発生位置を画面で指定');
        const directional = resolveEffect(this.chart.notes.find((k) => k.id === n.id)).def.directional;
        this.pick = directional ? 'direction' : null;
        if (directional) this.message('続けて、向きの先をクリックしてください（Esc で中止）');
      } else {
        // 向き: 発生位置（画面上）からクリックした点へ
        const [ox, oy] = this.originScreen(n);
        const ang = Math.round(Math.atan2(Y - oy, X - ox) * 180 / Math.PI);
        this.apply((c) => { const ef = fixed(c.notes.find((k) => k.id === n.id)); ef.angle = ang; delete ef.direction; }, '向きを画面で指定');
        this.pick = null;
      }
      this.tryEffect();
      this.renderNoteBox();
    });
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && this.pick) { this.pick = null; this.renderNoteBox(); } });
  }

  /** 選択中ノーツのエフェクトの発生位置（画面上。ノーツの時刻のコマで） */
  originScreen(n, G) {
    const fx = resolveEffect(n), fi = this.app.store.indexAt(n.time);
    const T = this.app.transformFor(fi, G), fr = this.app.store.frames[fi], m = this.app.manifest;
    const J = { head: 'nose', left_wrist: 'left_wrist', right_wrist: 'right_wrist', left_ankle: 'left_ankle', right_ankle: 'right_ankle' }[fx.origin];
    let p = [T.ox, T.oy];
    if (J && fr.joints?.[J]) p = T.toScreen(fr.joints[J][0], fr.joints[J][1]);
    else if ((fx.origin === 'point' || (fx.origin === 'auto' && fx.key === 'strike')) && fx.anchor) p = T.toScreen(fx.anchor.x * m.width, fx.anchor.y * m.height);
    const standH = (G || this.app.geometry()).standH;
    return [p[0] + fx.offset.x * standH, p[1] + fx.offset.y * standH];
  }

  /** ステージ上の編集用の表示（選択中ノーツの ID・エフェクト番号・発生位置と向き） */
  drawOverlay(ctx, G, t, fi) {
    if (!this.app.editMode) return;
    const sel = this.selNotes();
    if (sel.length !== 1) return;
    const n = sel[0], fx = resolveEffect(n);
    const [x, y] = this.originScreen(n, G);
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y); ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14); ctx.stroke();
    if (fx.def.directional && fx.direction) {
      ctx.strokeStyle = '#ffcf6a';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + fx.direction.x * 60, y + fx.direction.y * 60); ctx.stroke();
    }
    ctx.font = '600 12px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.fillStyle = '#fff';
    const label = `${n.id}（${n.time.toFixed(2)} 秒・コマ ${this.app.store.indexAt(n.time)}）No.${fx.id} ${fx.def.name}`;
    const lw = ctx.measureText(label).width, lx = Math.max(4, Math.min(x + 12, this.app.cssW - lw - 4)), ly = Math.max(14, y - 12);
    ctx.strokeText(label, lx, ly); ctx.fillText(label, lx, ly);
    ctx.restore();
    void t; void fi;
  }

  // ---------- 毎フレーム ----------
  tick(t) {
    if (this.root.hidden) return;
    const fi = this.app.store.indexAt(Math.max(0, t));
    this.root.querySelector('#edTime').textContent = `${Math.max(0, t).toFixed(2)} 秒 / コマ ${fi}`;
    const seek = this.root.querySelector('#edSeek');
    if (document.activeElement !== seek) seek.value = String(Math.max(0, t));
    if (fi !== this._frameShown) {
      // 下書き中・入力中は作り直さない（入力した値と対象のコマを保つ）
      if (this.frameDraft || this.root.querySelector('#edFrameBody').contains(document.activeElement)) { this._frameShown = fi; this.updateFrameShown(); }
      else this.renderFrameBox();
    }
    this.drawTimeline();
  }

  // ---------- JSON ----------
  exportFile() {
    const text = exportChart(this.chart);
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    a.href = URL.createObjectURL(blob);
    a.download = `seipai-${this.app.version}-chart-${stamp}.json`; // 例: seipai-v2-chart-2026-10-21-09-30.json
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    window.__lastExport = text;
    this.message(`JSON を書き出しました（${a.download}）`);
  }

  async importFile(file, input) {
    if (!file) return;
    const text = await file.text();
    input.value = '';
    this.importText(text, file.name);
  }

  importText(text, name = 'JSON') {
    const r = parseChartText(text, { frameCount: this.app.manifest.frameCount, gameVersion: this.app.version });
    if (!r.ok) {
      this.message(`読み込めませんでした（今の編集内容はそのままです）: ${r.errors.slice(0, 3).join(' ／ ')}`, 'error');
      return false;
    }
    this.apply((c) => { for (const k of Object.keys(c)) delete c[k]; Object.assign(c, r.chart); }, `${name} を読み込み`);
    if (r.warnings.length) this.message(`読み込みました（注意 ${r.warnings.length} 件: ${r.warnings[0]}）`);
    this.selected.clear();
    this.refresh();
    return true;
  }
}
