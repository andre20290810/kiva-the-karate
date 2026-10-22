// 成績画面: 概要・入力タイミングのグラフ・ノーツごとの詳細・過去との比較・履歴（書き出し・読み込み・削除）。
// 表示する数値はすべて記録（score.js の buildRecord / summarize）から計算する（画面と記録が食い違わない）。
// ずれは譜面の時間軸の ms（判定と同じ基準）。マイナス = 早い、プラス = 遅い。入力のない MISS は 0ms に描かず別に示す。

import { CMD, DEVICE_LABEL, KIND_LABEL, HOLD_STATUS_LABEL, comparisonTargets, compareRecords, conditionDiffs, chartHash } from './score.js';
import { LANE_STYLE } from './lanes.js';
import { timeTicks } from './timeline.js';
import { CompareView } from './compare-view.js';
import { replayable } from './replay.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sMs = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}ms`);
const aMs = (v) => (v == null ? '—' : `${v.toFixed(1)}ms`);
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const sec = (v) => (v == null ? '—' : `${v.toFixed(2)} 秒`);
const sgn = (v, unit = '', digits = 1) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)}${unit}`);
const when = (iso) => { try { return new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'medium' }); } catch { return iso; } };
const t3 = (v) => (v == null ? '—' : v.toFixed(3));

/**
 * 表示の約束（グラフ・凡例・カードで共通）。色は CSS のクラス（.g-perfect など）、形は markShape、文字は mark・label。
 * 凡例もグラフもここから作るので、色・形・意味が食い違わない
 */
export const VIS = Object.freeze({
  grades: Object.freeze({
    PERFECT: { mark: '●', cls: 'g-perfect', label: 'PERFECT', desc: 'PERFECT の範囲内' },
    GOOD: { mark: '▲', cls: 'g-good', label: 'GOOD', desc: 'GOOD の範囲内' },
    MISS: { mark: '✕', cls: 'g-miss', label: 'MISS（入力あり）', desc: '範囲外の入力・息の早離し' },
  }),
  bands: Object.freeze({
    perfect: { cls: 'band-perfect', label: (s) => `PERFECT の範囲（±${s.perfectWindowMs}ms）` },
    good: { cls: 'band-good', label: (s) => `GOOD の範囲（±${s.goodWindowMs}ms）` },
  }),
  series: Object.freeze({ cur: '今回（塗りつぶし）', base: '比較する記録（白抜き）' }),
});
const MARK = Object.fromEntries(Object.entries(VIS.grades).map(([k, v]) => [k, v.mark]));
const GRADE_CLASS = { ...Object.fromEntries(Object.entries(VIS.grades).map(([k, v]) => [k, v.cls])), SKIP: 'g-skip' };

/** 点の形（グラフ・凡例・カードで共通）: PERFECT = 丸、GOOD = 三角、MISS = ×、採用していない入力 = ひし形 */
export function markShape(grade, x, y, k = 1) {
  const r = 5 * k;
  if (grade === 'PERFECT') return `<circle cx="${x}" cy="${y}" r="${r}"/>`;
  if (grade === 'GOOD') return `<path d="M${x} ${y - r * 1.2}L${x + r * 1.2} ${y + r * 0.9}L${x - r * 1.2} ${y + r * 0.9}Z"/>`;
  if (grade === 'EXTRA') return `<path d="M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z"/>`;
  return `<path d="M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}"/>`;
}
const BTN = ['Y', 'X', 'A', 'B'];
/** 照合タイムラインの寸法（px）: 目盛りの段・正解の段・入力の段・余分な入力の段・左端の見出しの幅・両端の余白 */
const TL = Object.freeze({ head: 20, noteH: 28, inH: 34, gap: 4, exH: 40, labW: 92, pad: 12 });
/** 拡大・縮小の段階（1 秒あたりの px）。最大で 10ms = 10px */
const TL_ZOOM = Object.freeze([4, 6, 10, 16, 25, 40, 60, 100, 160, 250, 400, 640, 1000]);
const REASON = { early: '早すぎ', late: '遅すぎ', timeout: '入力なし', 'early-release': '早離し', released: '終了の許容内で離した', completed: '保持して完了', skipped: '対象外', cancelled: '取り消し' };
const PRACTICE = { seek: 'シーク', loop: '区間ループ', 'rate-change': '途中で速度変更', edit: '編集', 'mid-start': '途中から開始' };

export class ResultsView {
  constructor(app) {
    this.app = app;
    this.root = document.querySelector('#result');
    this.rec = null;
    this.tab = 'summary';
    this.filter = new Set(BTN);
    this.gradeFilter = 'all';
    this.selected = new Set();
    this.selNote = null;   // 照合タイムライン・カードで選んだノーツ
    this.selExtra = null;  // 選んだ余分な入力（extras の番号）
    this.tlPps = null;     // 照合タイムラインの拡大率（1 秒あたりの px）
    this.cmp = new CompareView(this); // 比較（記録の比較・期間平均の比較）
    this.root.innerHTML = `
      <div class="card results" tabindex="-1">
        <div class="res-head">
          <h2 id="resultTitle">成績</h2>
          <span class="res-head-btns"><button type="button" id="btnResultRetry" class="tbtn">リトライ</button><button type="button" id="btnResultClose" class="tbtn">閉じる</button></span>
        </div>
        <div class="res-tabs" role="tablist">
          ${[['summary', '概要'], ['timing', 'タイミング'], ['detail', '照合・ノーツ詳細'], ['compare', '比較'], ['history', '履歴']]
            .map(([k, l]) => `<button type="button" role="tab" data-tab="${k}">${l}</button>`).join('')}
        </div>
        <div id="resultBody" class="res-body"></div>
      </div>`;
    this.body = this.root.querySelector('#resultBody');
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => this.onChange(e));
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && !this.root.hidden) this.hide(); });
    // 画面の回転・大きさの変更: 図の幅を合わせ直す
    let raf = 0;
    window.addEventListener('resize', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (!this.root.hidden && ['timing', 'compare'].includes(this.tab)) this.render(); else if (!this.root.hidden && this.tab === 'detail') { this.keepTlCenter(); this.render(); } }); });
  }

  get history() { return this.app.history; }

  show(rec, { saved = null, tab = 'summary' } = {}) {
    if (rec !== this.rec) { this.selNote = null; this.selExtra = null; this.tlPps = null; }
    this.rec = rec;
    this.saveState = saved;
    this.tab = tab;
    this.root.hidden = false; // 先に表示してから描く（図の幅を画面に合わせる）
    this.render();
    this.root.querySelector('.card').scrollTop = 0;
  }

  openHistory() {
    this.show(this.rec || this.app.lastRecord || this.history.records.at(-1) || null, { saved: this.saveState, tab: this.rec || this.app.lastRecord || this.history.records.length ? 'summary' : 'history' });
  }

  hide() { this.root.hidden = true; }

  render() {
    for (const b of this.root.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === this.tab));
    const r = this.rec;
    this.root.querySelector('#resultTitle').textContent = !r ? '成績' : r.mode === 'demo' ? `${r.demo?.label ?? '公式デモ'}（公式デモ／シミュレーション）` : r.mode === 'auto' ? 'AUTO 再生の記録（手動の成績・自己ベストには含めません）' : `成績（${KIND_LABEL[r.kind]}）`;
    if (this.tab === 'history') { this.body.innerHTML = this.historyHtml(); return; }
    if (this.tab === 'compare') { this.body.innerHTML = this.cmp.html(); this.cmp.after(); return; } // 比較は今の記録がなくてもよい（過去の記録同士）
    if (!r) { this.body.innerHTML = '<p class="hint">まだ記録がありません。プレイを最後まで終えるか、「履歴」から過去の記録を開いてください。</p>'; return; }
    this.body.innerHTML = this.tab === 'summary' ? this.summaryHtml(r) : this.tab === 'timing' ? this.timingHtml(r) : this.tab === 'detail' ? this.detailHtml(r) : this.compareHtml(r);
    if (this.tab === 'detail') this.afterDetail();
  }

  // ---------- 概要 ----------
  conditionsHtml(r) {
    const s = r.settings;
    return `<dl class="res-cond">
      <dt>日時</dt><dd>${esc(when(r.at))}</dd>
      <dt>区分</dt><dd>${r.mode === 'auto' ? 'AUTO' : '手動'}・${KIND_LABEL[r.kind]}${r.practiceReasons?.length ? `（${r.practiceReasons.map((x) => PRACTICE[x] || x).join('・')}）` : ''}</dd>
      <dt>入力方法</dt><dd>${r.devices.length ? r.devices.map((d) => DEVICE_LABEL[d] || d).join('・') : '—'}</dd>
      <dt>判定幅</dt><dd>PERFECT ±${s.perfectWindowMs} ／ GOOD ±${s.goodWindowMs} ／ 許容限界 ±${s.missWindowMs} ／ 息の押し始め ±${s.holdStartWindowMs} ／ 早離しの許容 ${s.holdReleaseWindowMs} ms</dd>
      <dt>入力補正</dt><dd>${s.inputOffsetMs} ms</dd>
      <dt>再生速度</dt><dd>${r.rate}×</dd>
      <dt>BGM</dt><dd>${r.bgm ? `${esc(r.bgm.label)}${r.bgm.muted ? '（ミュート）' : ''}` : '—'}</dd>
      <dt>譜面</dt><dd>${esc(r.chart.title)}（${r.chart.notes} ノーツ・識別 ${esc(r.chart.hash)}）</dd>
    </dl>${this.rateNote(r)}`;
  }

  rateNote(r) {
    return r.rate !== 1 ? `<p class="hint res-rate">ずれ・判定幅は譜面の時間軸の ms です（判定と同じ基準）。再生速度 ${r.rate}× のため、実際に経過した時間はこの ${(1 / r.rate).toFixed(r.rate === 0.25 ? 0 : 1)} 倍です。</p>` : '';
  }

  summaryHtml(r) {
    const m = r.summary;
    const save = this.saveState && !this.saveState.ok && r === this.app.lastRecord
      ? `<div class="res-warn" role="alert">この記録をブラウザに保存できませんでした（${esc(this.saveState.error)}）。<button type="button" data-act="exportOne">成績を JSON で保存</button></div>` : '';
    return `${save}${this.replayBoxHtml(r)}
      <div class="res-grid">
        <div><span>スコア</span><b>${m.score.toLocaleString()}</b></div>
        <div><span>最大コンボ</span><b>${m.maxCombo}</b></div>
        <div><span>成功率</span><b>${pct(m.successRate)}</b><small>${m.perfect + m.good} / ${m.total}</small></div>
        <div><span>${MARK.PERFECT} PERFECT</span><b>${m.perfect}</b></div>
        <div><span>${MARK.GOOD} GOOD</span><b>${m.good}</b></div>
        <div><span>${MARK.MISS} MISS</span><b>${m.miss}</b><small>入力なし ${m.missNoInput}・範囲外の入力 ${m.missWithInput}</small></div>
        <div><span>平均絶対誤差</span><b>${aMs(m.maeMs)}</b><small>ずれの大きさの平均</small></div>
        <div><span>平均符号付き誤差</span><b>${sMs(m.meanMs)}</b><small>${m.meanMs == null ? '' : m.meanMs < 0 ? '早押しの傾向' : m.meanMs > 0 ? '遅押しの傾向' : '偏りなし'}</small></div>
        <div><span>誤差の標準偏差</span><b>${aMs(m.sdMs)}</b><small>ばらつき</small></div>
      </div>
      <p class="hint">誤差の集計対象: 入力のあった ${m.timed} 件（早い ${m.early}・遅い ${m.late}）。入力のない MISS ${m.missNoInput} 件は集計から除外。余分な入力（どのノーツにも当たらない） ${m.extras} 件${m.skipped ? `、対象外（シーク前など） ${m.skipped} 件` : ''}。</p>
      <div class="res-scroll"><table class="res-table"><caption>技ごとの成績</caption>
        <thead><tr><th>技</th><th>件数</th><th>成功率</th><th>P / G / M</th><th>平均絶対誤差</th><th>平均符号付き</th><th>標準偏差</th></tr></thead>
        <tbody>${BTN.map((b) => { const c = m.byCmd[b]; return `<tr><th>${CMD[b]}／${b}</th><td>${c.total}</td><td>${pct(c.successRate)}</td><td>${c.perfect} / ${c.good} / ${c.miss}</td><td>${aMs(c.maeMs)}</td><td>${sMs(c.meanMs)}</td><td>${aMs(c.sdMs)}</td></tr>`; }).join('')}</tbody>
      </table></div>
      ${this.conditionsHtml(r)}
      <p class="note">入力タイミングの成績です。空手の技能評価ではありません。</p>`;
  }

  /** 公式デモの説明と「このプレイを再現」（入力ログがない記録は理由を表示し、推測で作らない） */
  replayBoxHtml(r) {
    const can = replayable(r);
    const ok = r.summary.perfect + r.summary.good;
    const demo = r.mode === 'demo' ? `<p class="res-demo"><em class="rec-demo-tag">公式デモ／シミュレーション</em>${esc(r.demo?.note || '公式に用意したシミュレーションデータです（実際の利用者の実績ではありません）')}
      実際の正答率 ${pct(ok / r.summary.total)}（成功 ${ok}／${r.summary.total} ノーツ）。入力ログを通常の判定処理に通した結果です。自己ベスト・期間平均には含めません。</p>` : '';
    return `<div class="res-replay">${demo}<button type="button" data-replay="${esc(r.id)}" class="tbtn" ${can.ok ? '' : 'disabled'}>▶ このプレイを再現</button>
      <span class="hint">${can.ok ? '保存された入力（ボタン・時刻）どおりに押下・解除して、判定・コンボ・スコア・エフェクトを再現します（記録時の譜面・判定条件・入力補正・速度。成績には記録しません）。通常の AUTO（全成功）とは別の機能です。' : esc(can.reason)}</span></div>`;
  }

  // ---------- タイミングのグラフ ----------
  filterHtml() {
    return `<div class="res-filter" role="group" aria-label="技で絞り込み">${BTN.map((b) => `<button type="button" data-filter="${b}" aria-pressed="${this.filter.has(b)}">${CMD[b]}</button>`).join('')}</div>`;
  }

  /** 入力タイミングの図（SVG）。series: [{notes, style:'cur'|'base'}]。pairs があれば同じノーツを線で結ぶ */
  graphSvg(r, series, pairs = null) {
    const s = r.settings, R = Math.max(s.missWindowMs, ...series.flatMap((x) => x.notes.map((n) => Math.abs(n.d ?? 0)))) * 1.05;
    const rows = BTN.filter((b) => this.filter.has(b));
    // 幅は表示領域いっぱい（1:1 で描くので、広い画面でも文字は大きくならず、目盛りの間隔が広がる）
    const W = Math.max(340, Math.min(1800, Math.round(this.body.clientWidth || 640))), L = 48, Rm = 12, top = 30, rowH = 46, H = top + rows.length * rowH + 34;
    const cx = L + (W - L - Rm) / 2, half = (W - L - Rm) / 2;
    const X = (v) => cx + (v / R) * half;
    const rowY = (b) => top + rows.indexOf(b) * rowH + rowH / 2;
    const jit = (i) => ((i * 37) % 9 - 4) * 3.2;
    const step = R > 250 ? 100 : R > 120 ? 50 : 20, every = W < 480 && step === 50 ? 2 : 1; // 狭い画面では目盛りの数字を間引く
    let g = `<svg class="res-graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="入力タイミング（中央が正解 0ms、左が早い、右が遅い）">`;
    g += `<rect x="${X(-s.goodWindowMs)}" y="${top - 6}" width="${X(s.goodWindowMs) - X(-s.goodWindowMs)}" height="${rows.length * rowH + 6}" class="${VIS.bands.good.cls}"/>`;
    g += `<rect x="${X(-s.perfectWindowMs)}" y="${top - 6}" width="${X(s.perfectWindowMs) - X(-s.perfectWindowMs)}" height="${rows.length * rowH + 6}" class="${VIS.bands.perfect.cls}"/>`;
    for (let v = -Math.floor(R / step) * step; v <= R; v += step) {
      g += `<line x1="${X(v)}" x2="${X(v)}" y1="${top - 6}" y2="${top + rows.length * rowH}" class="${v === 0 ? 'axis0' : 'tick'}"/>`;
      if ((v / step) % every === 0) g += `<text x="${X(v)}" y="${H - 18}" class="tick-l">${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}</text>`;
    }
    g += `<text x="${X(0)}" y="${top - 12}" class="axis-l">正解 0ms</text>`;
    g += `<text x="${L}" y="${H - 4}" class="dir-l" text-anchor="start">← 早い</text><text x="${W - Rm}" y="${H - 4}" class="dir-l" text-anchor="end">遅い →</text>`;
    g += `<text x="${X(s.perfectWindowMs)}" y="${top - 12}" class="band-l" text-anchor="start">P±${s.perfectWindowMs}</text><text x="${X(-s.goodWindowMs)}" y="${top - 12}" class="band-l" text-anchor="end">G±${s.goodWindowMs}</text>`;
    for (const b of rows) {
      const y = rowY(b);
      g += `<line x1="${L}" x2="${W - Rm}" y1="${y + rowH / 2}" y2="${y + rowH / 2}" class="rowsep"/><text x="6" y="${y + 5}" class="row-l">${CMD[b]}／${b}</text>`;
    }
    if (pairs) {
      pairs.forEach((p, i) => {
        if (!rows.includes(p.button) || p.cur == null || p.base == null) return;
        g += `<line x1="${X(p.base)}" x2="${X(p.cur)}" y1="${rowY(p.button) + jit(i)}" y2="${rowY(p.button) + jit(i)}" class="pair"/>`;
      });
    }
    for (const ser of series) {
      ser.notes.forEach((n) => {
        if (!rows.includes(n.button) || n.d == null) return;
        const x = X(n.d), y = rowY(n.button) + jit(n.i), cls = `${GRADE_CLASS[n.result]} ${ser.style}`;
        const tip = `${ser.label ? `${ser.label} ` : ''}${n.id} ${CMD[n.button]} ${n.time.toFixed(2)}秒 ${sMs(n.d)} ${n.result}`;
        const shape = markShape(n.result, x, y);
        g += `<g class="${cls}" data-note="${esc(n.id)}"><title>${esc(tip)}</title>${shape}</g>`;
      });
    }
    return `${g}</svg>`;
  }

  points(r) {
    const idx = new Map(r.notes.map((n, i) => [n.id, i]));
    return r.notes.filter((n) => n.input && n.input.deltaMs != null).map((n) => ({ id: n.id, button: n.button, time: n.time, d: n.input.deltaMs, result: n.result, i: idx.get(n.id) }));
  }

  timingHtml(r) {
    const pts = this.points(r).filter((p) => this.filter.has(p.button));
    const none = r.notes.filter((n) => n.result === 'MISS' && !n.input && this.filter.has(n.button));
    return `${this.filterHtml()}
      ${this.rateNote(r)}
      ${this.legendHtml(r)}
      ${this.graphSvg(r, [{ notes: pts, style: 'cur' }])}
      <p class="hint">点の位置がずれの大きさです。息は押し始めのずれで、早離しの ${MARK.MISS} は押し始めが範囲内でも MISS（離した時刻は「ノーツ詳細」）。点にカーソル・長押しで ID と値。</p>
      <p>表示中の入力: ${pts.length} 件</p>
      <div class="res-none"><b>入力なしの MISS（0ms には描きません）: ${none.length} 件</b>
        ${none.length ? `<ul>${none.map((n) => `<li>${MARK.MISS} ${esc(n.id)} ${n.cmd}（${sec(n.time)}）</li>`).join('')}</ul>` : ''}</div>`;
  }

  /** 凡例（グラフと同じ VIS・markShape・CSS クラスから作る） */
  legendHtml(r, { compare = false } = {}) {
    const s = r.settings;
    const icon = (inner, w = 22) => `<svg class="res-graph res-legend-icon" viewBox="0 0 ${w} 16" width="${w}" height="16" aria-hidden="true">${inner}</svg>`;
    const item = (svg, text) => `<li>${svg}<span>${text}</span></li>`;
    const items = [
      ...Object.entries(VIS.grades).map(([k, v]) => item(icon(`<g class="${v.cls} cur">${markShape(k, 11, 8)}</g>`), `${v.mark} ${v.label}`)),
      item(icon(`<rect x="1" y="2" width="20" height="12" class="${VIS.bands.perfect.cls}"/>`), VIS.bands.perfect.label(s)),
      item(icon(`<rect x="1" y="2" width="20" height="12" class="${VIS.bands.good.cls}"/>`), VIS.bands.good.label(s)),
      item(icon('<line x1="11" x2="11" y1="0" y2="16" class="axis0"/>'), '中央の線 = 正解の時刻（0ms）'),
      item(icon('<text x="11" y="12" class="dir-l" text-anchor="middle">←</text>'), '左 = 早押し（マイナス）'),
      item(icon('<text x="11" y="12" class="dir-l" text-anchor="middle">→</text>'), '右 = 遅押し（プラス）'),
    ];
    if (compare) {
      items.push(item(icon(`<g class="g-perfect cur">${markShape('PERFECT', 11, 8)}</g>`), VIS.series.cur));
      items.push(item(icon(`<g class="g-perfect base">${markShape('PERFECT', 11, 8)}</g>`), VIS.series.base));
      items.push(item(icon('<line x1="2" x2="20" y1="8" y2="8" class="pair"/>'), '同じノーツを結ぶ線'));
    } else items.push(item(icon(''), `入力なしの ${MARK.MISS} MISS は点にしない（下の一覧）`));
    return `<ul class="res-legend" aria-label="凡例">${items.join('')}</ul>`;
  }

  // ---------- ノーツ詳細（画像つきカード。時間順に横へ並べる） ----------
  /** 時間軸の時刻 → コマ（実際のフレーム時刻表。その時刻に画面に出ていた画像 = その時刻以前で最も新しいコマ） */
  frameAt(t) {
    const st = this.app.store;
    if (!st || t == null) return null;
    const i = st.indexAt(Math.max(0, t));
    return { i, t: st.frames[i].t };
  }

  /** ノーツに関係する入力（時刻順）: 判定に採用した入力と、近くの余分な入力（採用していない。付け替えない） */
  relatedInputs(r, n) {
    const span = (r.settings.missWindowMs * 1.5) / 1000;
    const out = [];
    if (n.input) out.push({ ...n.input, adopted: true, note: '判定に採用' });
    if (Array.isArray(r.extras)) {
      for (const x of r.extras) {
        if (Math.abs(x.time - n.time) > span) continue;
        const d = Math.round((x.time - n.time) * 1e4) / 10;
        const why = x.button !== n.button ? `ボタン違い（要求は ${CMD[n.button]}／${n.button}）`
          : Math.abs(d) > r.settings.missWindowMs ? '判定範囲の外' : '判定が済んだ後の入力';
        out.push({ ...x, deltaMs: d, adopted: false, note: `${why}・判定に使っていない` });
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  cardFilterHtml(r, withCmd = true) {
    const g = this.gradeFilter;
    const count = (k) => r.notes.filter((n) => (k === 'all' || n.result === k) && this.filter.has(n.button)).length;
    return `<div class="res-filter" role="group" aria-label="判定で絞り込み">${[['all', 'すべて'], ['PERFECT', `${VIS.grades.PERFECT.mark} PERFECT`], ['GOOD', `${VIS.grades.GOOD.mark} GOOD`], ['MISS', `${VIS.grades.MISS.mark} MISS`]]
      .map(([k, l]) => `<button type="button" data-grade="${k}" aria-pressed="${g === k}">${l}（${count(k)}）</button>`).join('')}</div>${withCmd ? this.filterHtml() : ''}`;
  }

  /** 文字の幅（px）。照合タイムライン・小さな時間軸で文字を重ねないための実測 */
  textW(text, px = 11, weight = 400) {
    const c = (this._mc ||= document.createElement('canvas').getContext('2d'));
    c.font = `${weight} ${px}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
    return c.measureText(text).width;
  }

  /** 小さな時間軸: 正解（0）・判定の範囲・採用した入力・採用していない入力。文字は印の上の 2 段に重ならないように置く */
  miniTimeline(r, n, inputs) {
    // 幅はカードの実際の幅（1:1。カードが広いほど目盛りが広がり、文字の大きさは同じ）
    const s = r.settings, W = Math.max(200, Math.round(this.miniW || 280)), H = 84, L = 10, Rm = 10, cy = 50;
    const R = Math.max(s.missWindowMs * 1.15, ...inputs.map((x) => Math.abs(x.deltaMs ?? 0) + 15));
    const X = (v) => L + ((v + R) / (2 * R)) * (W - L - Rm);
    let g = `<svg class="res-graph nc-axis" viewBox="0 0 ${W} ${H}" data-w="${W}" role="img" aria-label="正解の時刻と入力の位置（ms）">`;
    g += `<rect x="${X(-s.missWindowMs)}" y="${cy - 11}" width="${X(s.missWindowMs) - X(-s.missWindowMs)}" height="22" class="band-miss"/>`;
    g += `<rect x="${X(-s.goodWindowMs)}" y="${cy - 11}" width="${X(s.goodWindowMs) - X(-s.goodWindowMs)}" height="22" class="${VIS.bands.good.cls}"/>`;
    g += `<rect x="${X(-s.perfectWindowMs)}" y="${cy - 11}" width="${X(s.perfectWindowMs) - X(-s.perfectWindowMs)}" height="22" class="${VIS.bands.perfect.cls}"/>`;
    g += `<line x1="${X(0)}" x2="${X(0)}" y1="${cy - 14}" y2="${cy + 14}" class="axis0"/>`;
    // 軸の文字は下の段（印の文字とは別の段）
    g += `<text x="${X(0)}" y="${H - 4}" class="tick-l">正解 0</text><text x="${L}" y="${H - 4}" class="tick-l" text-anchor="start">← 早い</text><text x="${W - Rm}" y="${H - 4}" class="tick-l" text-anchor="end">遅い →</text>`;
    const lanes = [[], []]; // 印の文字の 2 段（y = 12, 26）。入らないときは番号だけ
    const fit = (x0, x1) => lanes.findIndex((ls) => ls.every(([a, b]) => x1 < a - 3 || x0 > b + 3));
    inputs.forEach((x, k) => {
      if (x.deltaMs == null) return;
      const px = X(x.deltaMs), no = k + 1;
      g += x.adopted
        ? `<g class="${VIS.grades[n.result]?.cls || 'g-miss'} cur"><title>${no} 採用: ${sMs(x.deltaMs)}</title>${markShape(n.result, px, cy, 1.1)}</g>`
        : `<g class="g-extra"><title>${no} 不採用: ${sMs(x.deltaMs)} ${x.button}</title>${markShape('EXTRA', px, cy, 1)}</g>`;
      for (const txt of [`${no} ${x.adopted ? '採用' : '不採用'}`, `${no}`]) {
        const w = this.textW(txt, 9) + 2, x0 = Math.max(1, Math.min(W - 1 - w, px - w / 2)), li = fit(x0, x0 + w);
        if (li < 0) continue;
        lanes[li].push([x0, x0 + w]);
        const ty = li ? 26 : 12;
        g += `<line x1="${px}" x2="${px}" y1="${ty + 3}" y2="${cy - 12}" class="nc-lead"/><text x="${x0 + w / 2}" y="${ty}" class="tick-l nc-lab">${txt}</text>`;
        break;
      }
    });
    return `${g}</svg>`;
  }

  /** カード: 行の数を固定（空の行も置く）して、横に並ぶカードの見出し・画像・正解・入力・判定の位置をそろえる */
  cardHtml(r, n, no) {
    const v = VIS.grades[n.result] || { mark: '', cls: 'g-skip', label: n.result };
    const inp = n.input;
    const inputs = this.relatedInputs(r, n);
    const wrong = !inp ? inputs.filter((x) => x.button !== n.button) : [];
    const late = inp && inp.deltaMs > 0, early = inp && inp.deltaMs < 0;
    const amount = inp ? (inp.deltaMs === 0 ? 'ずれ 0ms（ぴったり）' : `${Math.abs(inp.deltaMs).toFixed(1)}ms ${early ? '早い' : '遅い'}`) : '';
    const reason = n.reason && REASON[n.reason] ? REASON[n.reason] : null;
    const verdict = inp ? `${amount} → ${v.mark} ${n.result}${reason && n.result === 'MISS' ? `（${reason}）` : ''}`
      : `入力なし → ${v.mark} ${n.result}${wrong.length ? '（ボタン違いの入力あり）' : ''}`;
    const ft = n.frames?.target ?? this.frameAt(n.time), fi = inp ? (n.frames?.input ?? this.frameAt(inp.time)) : null;
    const fig = (label, t, f) => `<figure class="nc-fig"><canvas width="132" height="176" data-frame="${f ? f.i : ''}" aria-label="${label}の主人公の画像"></canvas>
      <figcaption><b>${label}</b> ${t3(t)} 秒<br><small>${f ? `コマ ${f.i}（${t3(f.t)} 秒の画像）` : '画像なし'}</small></figcaption></figure>`;
    const h = n.hold;
    const empty = '<div class="nc-empty"></div>';
    const holdHtml = !h ? empty : `<dl class="nc-hold">
      <dt>正解の開始・終了</dt> <dd>${t3(n.time)} 〜 ${h.end != null ? t3(h.end) : '記録なし'} 秒（${h.duration != null ? `${h.duration.toFixed(2)} 秒` : '記録なし'}）</dd> 
      <dt>押下</dt> <dd>${h.pressedAt === undefined ? '記録なし' : h.pressedAt == null ? '押していない' : `${t3(h.pressedAt)} 秒（${inp ? sMs(inp.deltaMs) : '—'}）`}</dd> 
      <dt>解除</dt> <dd>${h.releasedAt === undefined ? '記録なし' : h.releasedAt == null ? (h.status === 'completed-held' ? '離す前に終了' : '—') : `${t3(h.releasedAt)} 秒（終了から ${sMs(h.releaseDeltaMs)}）`}</dd> 
      <dt>保持時間</dt> <dd>必要 ${h.requiredSec != null ? `${h.requiredSec.toFixed(2)} 秒` : '記録なし'} ／ 実際 ${h.heldSec === undefined ? '記録なし' : h.heldSec == null ? '—' : `${h.heldSec.toFixed(2)} 秒`}</dd> 
      <dt>早離し</dt> <dd>${h.status === undefined ? '記録なし' : h.status === 'early-release' ? 'あり（途中解除）' : 'なし'}${h.completedAt != null ? `（${t3(h.completedAt)} 秒に保持して成功）` : ''}</dd> 
    </dl>`;
    const sel = this.selNote === n.id ? ' is-sel' : '';
    return `<article class="nc ${v.cls}${sel}" data-note="${esc(n.id)}" data-grade="${n.result}" tabindex="-1" aria-label="${no} 番目 ${esc(n.id)} ${CMD[n.button]}">
      <header><span class="nc-no">${no}</span><span class="nc-id">${esc(n.id)}</span><span class="nc-grade">${v.mark} ${n.result}</span></header>
      <div class="nc-imgs">${fig('正解時', n.time, ft)}${inp ? fig('入力時', inp.time, fi) : '<figure class="nc-fig nc-none"><div>入力なし</div><figcaption><b>入力時</b> —<br><small>入力がないので画像は作りません</small></figcaption></figure>'}</div>
      ${inp && ft && fi && ft.i === fi.i ? '<p class="nc-small">2 枚は同じ画像です（素材は 0.2 秒間隔）。ずれは下の数値が正確です。</p>' : empty}
      <p class="nc-line"><span class="nc-k">正解</span> <b class="nc-cmd" data-b="${n.button}">${CMD[n.button]}／${n.button}</b> <span>${t3(n.time)} 秒</span></p>
      <p class="nc-line"><span class="nc-k">入力</span> ${inp ? `<b class="nc-cmd" data-b="${inp.button}">${inp.button}</b> を <span>${t3(inp.time)} 秒</span> <small>${DEVICE_LABEL[inp.device] || inp.device || '入力方法の記録なし'}</small>` : '<b>入力なし</b>'}</p>
      ${wrong.length ? `<p class="nc-line nc-wrong"><span class="nc-k">押したボタン</span> ${wrong.map((x) => `<b class="nc-cmd" data-b="${x.button}">${CMD[x.button]}／${x.button}</b> ${t3(x.time)} 秒`).join('、')}<small>（要求は ${CMD[n.button]}／${n.button}・判定に使っていない）</small></p>` : empty}
      <p class="nc-verdict">${verdict}</p>
      ${inp && inp.rawDeltaMs !== undefined && inp.rawDeltaMs !== inp.deltaMs ? `<p class="nc-small">入力補正 ${r.settings.inputOffsetMs}ms の後のずれ。補正前は ${sMs(inp.rawDeltaMs)}</p>` : inp && inp.rawDeltaMs === undefined ? '<p class="nc-small">補正前の時刻: 記録なし</p>' : empty}
      ${this.miniTimeline(r, n, inputs)}
      ${holdHtml}
      ${inputs.length ? `<ol class="nc-inputs" aria-label="関係する入力（時刻順。番号は上の図の番号）">${inputs.map((x) => `<li class="${x.adopted ? 'adopted' : ''}">${t3(x.time)} 秒 <b>${CMD[x.button]}／${x.button}</b> ${sMs(x.deltaMs)} ${DEVICE_LABEL[x.device] || x.device || ''} — ${x.adopted ? '<b>判定に採用</b>' : esc(x.note)}</li>`).join('')}</ol>` : '<p class="nc-small">関係する入力: なし</p>'}
    </article>`;
  }

  // ---------- 照合タイムライン（編集画面と同じ時間軸。主表示） ----------
  /** 時間軸の長さ: 記録した長さ（演武の終わり）。古い記録は、同じ譜面なら今の長さ、違えば記録の最後の時刻から */
  tlDuration(r) {
    if (r.chart?.duration) return r.chart.duration;
    if (this.app.chart && this.app.duration && r.chart?.hash === chartHash(this.app.chart)) return this.app.duration;
    const ends = [...r.notes.map((n) => n.time + (n.hold?.duration || 0)), ...(r.extras || []).map((x) => x.time), r.range?.to || 0];
    return Math.ceil(Math.max(...ends, 1) + 1);
  }

  /** 行の配置: 技ごとに「正解」と「入力」の 2 段（上から Y・X・A・B = 編集画面と同じ順）、最後に「不採用・余分な入力」 */
  tlRows() {
    const rows = [];
    let y = TL.head;
    for (const b of BTN) {
      if (!this.filter.has(b)) continue;
      rows.push({ key: `n:${b}`, b, kind: 'note', y, h: TL.noteH, label: `${CMD[b]}／${b}`, sub: '正解' }); y += TL.noteH;
      rows.push({ key: `i:${b}`, b, kind: 'input', y, h: TL.inH, label: '', sub: '入力' }); y += TL.inH + TL.gap;
    }
    rows.push({ key: 'x', kind: 'extra', y, h: TL.exH, label: '不採用', sub: '余分な入力' }); y += TL.exH;
    return { rows, H: y + 4 };
  }

  tlHtml(r) {
    return `<section class="tl" aria-label="照合タイムライン">
      <div class="tl-tools">
        <span class="tl-zoom" role="group" aria-label="拡大・縮小"><button type="button" data-zoom="-1" aria-label="縮小">－</button><button type="button" data-zoom="1" aria-label="拡大">＋</button><button type="button" data-zoom="fit">全体</button></span>
        <span class="tl-scale" aria-live="polite"></span>
      </div>
      <p class="hint">編集画面のタイムラインと同じ時間軸です（0 秒〜${this.tlDuration(r).toFixed(1)} 秒、左から右へ時間が進む。目盛りは 1 秒・0.2 秒）。横にスクロール、＋で拡大。ノーツや入力を押すと、下の画像とカードに移ります。</p>
      ${this.tlLegendHtml(r)}
      <div class="tl-wrap"><div class="tl-labels"></div><div class="tl-scroll" tabindex="0" aria-label="照合タイムライン（横にスクロール）"></div></div>
      <div class="tl-sel" aria-live="polite"></div>
    </section>`;
  }

  tlLegendHtml(r) {
    const s = r.settings;
    const icon = (inner, w = 26) => `<svg class="res-graph res-legend-icon" viewBox="0 0 ${w} 16" width="${w}" height="16" aria-hidden="true">${inner}</svg>`;
    const item = (svg, text) => `<li>${svg}<span>${text}</span></li>`;
    return `<ul class="res-legend tl-legend" aria-label="照合タイムラインの凡例">${[
      item(icon('<rect x="9" y="2" width="6" height="12" class="tl-nmark" fill="#ffc531"/>'), '正解のノーツ（「正解」の段。技の字と色）'),
      item(icon('<rect x="2" y="5" width="22" height="6" fill="#ffc53177"/><rect x="21" y="2" width="3" height="12" fill="#ffc531"/>'), '息の正解の保持区間'),
      ...Object.entries(VIS.grades).map(([k, v]) => item(icon(`<g class="${v.cls} cur">${markShape(k, 13, 8)}</g>`), `採用した入力: ${v.mark} ${v.label}（「入力」の段）`)),
      item(icon(`<line x1="4" x2="22" y1="2" y2="14" class="tl-link"/>`), '正解から採用した入力への線（横の距離 = 早い／遅い）'),
      item(icon('<rect x="2" y="5" width="22" height="6" class="tl-held"/>'), '実際に押していた区間（息）'),
      item(icon(`<g class="g-miss">${markShape('MISS', 13, 8)}</g>`), '「正解」の段の ✕ = 入力なしの MISS（入力の段には何も描かない）'),
      item(icon(`<g class="g-extra">${markShape('EXTRA', 13, 8)}</g>`), '不採用・余分な入力（専用の段。判定に使っていない）'),
      item(icon(`<rect x="1" y="2" width="12" height="12" class="${VIS.bands.perfect.cls}"/><rect x="13" y="2" width="12" height="12" class="${VIS.bands.good.cls}"/>`), `拡大時: 判定の範囲（PERFECT ±${s.perfectWindowMs}ms・GOOD ±${s.goodWindowMs}ms）`),
    ].join('')}</ul>`;
  }

  /** 照合タイムラインを描く（拡大・縮小のたびに作り直す。中央の時刻は保つ） */
  renderTimeline(keepT = null) {
    const r = this.rec, sc = this.body.querySelector('.tl-scroll'), lab = this.body.querySelector('.tl-labels');
    if (!r || !sc) return;
    const dur = this.tlDuration(r);
    const fitPps = Math.max(1, (sc.clientWidth - TL.pad * 2) / dur);
    if (this.tlPps == null) this.tlPps = Math.max(fitPps, TL_ZOOM[4]);
    const pps = this.tlPps;
    const centerT = keepT ?? (sc.scrollWidth > 0 ? (sc.scrollLeft + sc.clientWidth / 2 - TL.pad) / (this._lastPps || pps) : 0);
    const { rows, H } = this.tlRows();
    const W = Math.ceil(dur * pps + TL.pad * 2);
    const X = (t) => TL.pad + t * pps;
    const rowOf = (key) => rows.find((x) => x.key === key);
    const s = r.settings;
    const out = [];       // 図形
    const texts = [];     // 文字（重ならないように置いたもの）
    const occ = new Map(); // 行ごとの使っている横の範囲 [x0, x1, y0, y1]
    const take = (key, box) => { const l = occ.get(key) || []; l.push(box); occ.set(key, l); };
    const free = (key, x0, x1, y0, y1) => (occ.get(key) || []).every(([a, b, c, d]) => x1 < a - 2 || x0 > b + 2 || y1 < c || y0 > d);
    /** 文字を置く: 候補（文字と位置）を順に試し、入るものを置く。入らなければ置かない（印だけ残る） */
    const label = (key, cands, cls, sel) => {
      for (const c of cands) {
        const w = this.textW(c.text, 11, c.bold ? 700 : 400);
        const x0 = c.anchor === 'end' ? c.x - w : c.anchor === 'middle' ? c.x - w / 2 : c.x;
        const y0 = c.y - 10, y1 = c.y + 3;
        if (x0 < 1 || x0 + w > W - 1 || !free(key, x0, x0 + w, y0, y1)) continue;
        take(key, [x0, x0 + w, y0, y1]);
        texts.push(`<text x="${x0.toFixed(1)}" y="${c.y}" class="tl-t ${cls}" data-sel="${sel}"${c.bold ? ' font-weight="700"' : ''}>${esc(c.text)}</text>`);
        return true;
      }
      return false;
    };
    // 背景: 行・目盛り（timeline.js の共通の目盛り = 編集画面と同じ）
    for (const row of rows) out.push(`<rect x="0" y="${row.y}" width="${W}" height="${row.h}" class="tl-row tl-row-${row.kind}"/>`);
    for (const tk of timeTicks(0, dur, pps)) {
      const x = X(tk.t).toFixed(1);
      out.push(`<line x1="${x}" x2="${x}" y1="${tk.whole ? 0 : TL.head - 4}" y2="${H}" class="${tk.whole ? 'tl-tick1' : 'tl-tick02'}"/>`);
      if (tk.label) out.push(`<text x="${(+x + 2).toFixed(1)}" y="12" class="tl-sec">${tk.label}</text>`);
    }
    // 選択の縦帯
    const selN = this.selNote ? r.notes.find((n) => n.id === this.selNote) : null;
    const selX = this.selExtra != null ? r.extras?.[this.selExtra] : null;
    if (selN) {
      const a = Math.min(selN.time, selN.input?.time ?? selN.time), b = Math.max(selN.time + (selN.hold?.duration || 0), selN.input?.time ?? 0, selN.hold?.releasedAt ?? 0);
      out.push(`<rect x="${X(a) - 8}" y="${TL.head - 2}" width="${X(b) - X(a) + 16}" height="${H - TL.head}" class="tl-selband"/>`);
    }
    if (selX) out.push(`<rect x="${X(selX.time) - 8}" y="${TL.head - 2}" width="16" height="${H - TL.head}" class="tl-selband"/>`);
    // 正解のノーツ・採用した入力（時刻順）
    const notes = r.notes.filter((n) => this.filter.has(n.button)).slice().sort((a, b) => a.time - b.time);
    const wide = pps >= 100; // 拡大時は判定の範囲を描く
    for (const n of notes) {
      const nr = rowOf(`n:${n.button}`), ir = rowOf(`i:${n.button}`), st = LANE_STYLE[n.button];
      const x = X(n.time), sel = `note:${n.id}`, isSel = n.id === this.selNote ? ' is-sel' : '';
      const ny = nr.y + nr.h / 2;
      const g = [];
      // 押しやすい範囲（正解の段〜入力の段、印の左右 10px。指でも選べる）
      const hx0 = Math.min(x, n.input ? X(n.input.time) : x) - 10, hx1 = Math.max(x, n.input ? X(n.input.time) : x) + 10;
      g.push(`<rect x="${hx0}" y="${nr.y}" width="${hx1 - hx0}" height="${ir.y + ir.h - nr.y}" class="tl-hit"/>`);
      if (wide) {
        g.push(`<rect x="${X(n.time - s.goodWindowMs / 1000)}" y="${ir.y + 2}" width="${(2 * s.goodWindowMs / 1000) * pps}" height="${ir.h - 4}" class="${VIS.bands.good.cls}"/>`);
        g.push(`<rect x="${X(n.time - s.perfectWindowMs / 1000)}" y="${ir.y + 2}" width="${(2 * s.perfectWindowMs / 1000) * pps}" height="${ir.h - 4}" class="${VIS.bands.perfect.cls}"/>`);
      }
      // 正解の位置（入力の段にも細い線）
      g.push(`<line x1="${x}" x2="${x}" y1="${ir.y + 2}" y2="${ir.y + ir.h - 2}" class="tl-target"/>`);
      if (n.hold) {
        const xe = X(n.hold.end ?? n.time + n.hold.duration);
        g.push(`<rect x="${x}" y="${ny - 5}" width="${Math.max(1, xe - x)}" height="10" fill="${st.color}" fill-opacity="0.45"/><rect x="${xe - 3}" y="${nr.y + 4}" width="3" height="${nr.h - 8}" fill="${st.color}"/>`);
      }
      g.push(`<rect x="${x - 4}" y="${nr.y + 3}" width="8" height="${nr.h - 6}" rx="2" fill="${st.color}" class="tl-nmark"/>`);
      take(nr.key, [x - 4, x + 4, nr.y, nr.y + nr.h]);
      if (!n.input && n.result === 'MISS') {
        g.push(`<g class="g-miss tl-nomiss">${markShape('MISS', x, ny, 1.15)}</g>`);
      }
      const inp = n.input;
      if (inp) {
        const ix = X(inp.time), iy = ir.y + ir.h / 2 + 3;
        if (n.hold && n.hold.pressedAt != null) {
          const endT = n.hold.releasedAt ?? n.hold.completedAt ?? n.hold.end;
          if (endT != null) g.push(`<rect x="${X(n.hold.pressedAt)}" y="${iy - 4}" width="${Math.max(1, X(endT) - X(n.hold.pressedAt))}" height="8" class="tl-held${n.hold.status === 'early-release' ? ' early' : ''}"/>`);
          if (n.hold.releasedAt != null) g.push(`<line x1="${X(n.hold.releasedAt)}" x2="${X(n.hold.releasedAt)}" y1="${iy - 8}" y2="${iy + 8}" class="tl-release"/>`);
        }
        g.push(`<line x1="${x}" y1="${nr.y + nr.h - 3}" x2="${ix}" y2="${iy - 6}" class="tl-link"/>`);
        if (Math.abs(ix - x) > 2) g.push(`<line x1="${x}" x2="${ix}" y1="${iy}" y2="${iy}" class="tl-dist"/>`);
        g.push(`<g class="${GRADE_CLASS[n.result]} cur">${markShape(n.result, ix, iy, 1.05)}</g>`);
        take(ir.key, [ix - 6, ix + 6, ir.y, ir.y + ir.h]);
      }
      out.push(`<g class="tl-item${isSel}" data-sel="${sel}"><title>${esc(this.tlTip(r, n))}</title>${g.join('')}</g>`);
    }
    // 不採用・余分な入力（専用の段。上下 2 段で重ならないように）
    const xr = rowOf('x');
    const exLanes = [[], []];
    (Array.isArray(r.extras) ? r.extras : []).forEach((e, k) => {
      if (!this.filter.has(e.button)) return;
      const x = X(e.time);
      const li = exLanes.findIndex((l) => l.every((v) => Math.abs(v - x) > 12));
      const lane = li < 0 ? 0 : li; exLanes[lane].push(x);
      const y = xr.y + (lane ? xr.h * 0.72 : xr.h * 0.32);
      const st = LANE_STYLE[e.button], isSel = k === this.selExtra ? ' is-sel' : '';
      out.push(`<g class="tl-item${isSel}" data-sel="extra:${k}"><rect x="${x - 10}" y="${y - 10}" width="20" height="20" class="tl-hit"/><title>${esc(`不採用 ${t3(e.time)} 秒 ${CMD[e.button]}／${e.button}（判定に使っていない）`)}</title><g class="g-extra">${markShape('EXTRA', x, y, 1)}</g><circle cx="${x}" cy="${y}" r="2.2" fill="${st.color}"/></g>`);
      take('x', [x - 6, x + 6, y - 6, y + 6]);
    });
    // 文字（印を置いたあと。重なるものは短い文字に、入らなければ省く）
    for (const n of notes) {
      const nr = rowOf(`n:${n.button}`), ir = rowOf(`i:${n.button}`);
      const x = X(n.time), sel = `note:${n.id}`, ny = nr.y + nr.h / 2 + 4;
      if (!n.input && n.result === 'MISS') label(nr.key, [{ text: `${CMD[n.button]} 入力なし`, x: x + 10, y: ny }, { text: '入力なし', x: x + 10, y: ny }, { text: CMD[n.button], x: x + 10, y: ny }], 'tl-t-miss', sel);
      else label(nr.key, [{ text: CMD[n.button], x: x + 7, y: ny, bold: true }], `tl-t-cmd b-${n.button}`, sel);
      const inp = n.input;
      if (!inp) continue;
      const ix = X(inp.time), ty = ir.y + 12;
      const d = sMs(inp.deltaMs), gv = VIS.grades[n.result];
      const hold = n.hold?.status === 'early-release' ? ' 早離し' : '';
      const side = inp.deltaMs < 0 ? 'end' : 'start', ox = inp.deltaMs < 0 ? ix - 10 : ix + 10;
      label(ir.key, [
        { text: `${inp.button} ${d} ${gv ? gv.label.replace('（入力あり）', '') : n.result}${hold}`, x: ox, y: ty, anchor: side },
        { text: `${d}${hold}`, x: ox, y: ty, anchor: side },
        { text: `${d}`, x: ix, y: ir.y + ir.h - 1, anchor: 'middle' },
      ], `tl-t-in ${GRADE_CLASS[n.result]}`, sel);
    }
    (Array.isArray(r.extras) ? r.extras : []).forEach((e, k) => {
      if (!this.filter.has(e.button)) return;
      const x = X(e.time);
      label('x', [{ text: `${e.button} 不採用`, x: x + 10, y: xr.y + 13 }, { text: `${e.button} 不採用`, x: x + 10, y: xr.y + xr.h - 4 }, { text: e.button, x: x + 10, y: xr.y + 13 }], `tl-t-ex b-${e.button}`, `extra:${k}`);
    });
    sc.innerHTML = `<svg class="res-graph tl-svg" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="正解のノーツと実際の入力の照合（${dur.toFixed(1)} 秒）">${out.join('')}${texts.join('')}</svg>`;
    lab.innerHTML = `<svg class="res-graph tl-svg" width="${TL.labW}" height="${H}" style="width:${TL.labW}px;height:${H}px" aria-hidden="true">${rows.map((row) => `<rect x="0" y="${row.y}" width="${TL.labW}" height="${row.h}" class="tl-row tl-row-${row.kind}"/>${row.kind === 'extra' ? `<text x="4" y="${row.y + 16}" class="tl-rl">${row.label}</text><text x="4" y="${row.y + 32}" class="tl-rs">${row.sub}</text>` : `${row.label ? `<text x="4" y="${row.y + row.h / 2 + 4}" class="tl-rl${row.b ? ` b-${row.b}` : ''}">${row.label}</text>` : ''}<text x="${TL.labW - 4}" y="${row.y + row.h / 2 + 4}" class="tl-rs" text-anchor="end">${row.sub}</text>`}`).join('')}<text x="4" y="13" class="tl-sec">秒</text></svg>`;
    this._lastPps = pps;
    const sec1 = pps >= 1000 ? `1 秒 = ${pps} px（10ms = ${(pps / 100).toFixed(0)} px）` : `1 秒 = ${Math.round(pps)} px`;
    this.body.querySelector('.tl-scale').textContent = `${sec1}・全 ${dur.toFixed(1)} 秒`;
    sc.scrollLeft = Math.max(0, X(centerT) - sc.clientWidth / 2);
    window.__tl = { pps, W, dur, rows: rows.map((x) => ({ key: x.key, y: x.y, h: x.h })), pad: TL.pad };
  }

  tlTip(r, n) {
    const inp = n.input;
    return `${n.id} ${CMD[n.button]}／${n.button} 正解 ${t3(n.time)} 秒${n.hold ? `〜${t3(n.hold.end)} 秒` : ''} → ${inp ? `${inp.button} を ${t3(inp.time)} 秒（${sMs(inp.deltaMs)}）` : '入力なし'} ${n.result}`;
  }

  /** 作り直す前の照合タイムラインの中央の時刻を覚える（絞り込みで位置が飛ばない） */
  keepTlCenter() {
    const sc = this.body.querySelector('.tl-scroll');
    if (sc && this._lastPps) this._keepT = (sc.scrollLeft + sc.clientWidth / 2 - TL.pad) / this._lastPps;
  }

  tlZoom(z) {
    const sc = this.body.querySelector('.tl-scroll');
    if (!sc || !this.rec) return;
    const centerT = (sc.scrollLeft + sc.clientWidth / 2 - TL.pad) / (this._lastPps || 1);
    const dur = this.tlDuration(this.rec), fit = Math.max(1, (sc.clientWidth - TL.pad * 2) / dur);
    if (z === 'fit') this.tlPps = fit;
    else {
      const cur = this.tlPps;
      const next = z > 0 ? TL_ZOOM.find((v) => v > cur * 1.01) : [...TL_ZOOM].reverse().find((v) => v < cur * 0.99);
      this.tlPps = Math.max(fit, next ?? cur);
    }
    this.renderTimeline(z === 'fit' ? dur / 2 : centerT);
  }

  /** 選択: タイムライン・画像・カードを連動させる。from: 'tl'（タイムラインで選んだ）・'card'（カードで選んだ） */
  select(kind, id, from = 'tl') {
    const r = this.rec;
    this.selNote = kind === 'note' ? id : null;
    this.selExtra = kind === 'extra' ? Number(id) : null;
    const n = this.selNote ? r.notes.find((x) => x.id === id) : null;
    if (n && from === 'tl' && !this.body.querySelector(`.nc[data-note="${CSS.escape(n.id)}"]`)) {
      // 絞り込みで隠れているカードは表示を戻す
      this.gradeFilter = 'all'; this.filter.add(n.button);
      this.render(); return this.select(kind, id, from);
    }
    const t = n ? (n.input ? (n.time + n.input.time) / 2 : n.time) : r.extras?.[this.selExtra]?.time;
    // 選んだ箇所が見えていなければ、照合タイムラインの中央に移す
    const sc = this.body.querySelector('.tl-scroll');
    const x = t != null && this._lastPps ? TL.pad + t * this._lastPps : null;
    const visible = sc && x != null && x > sc.scrollLeft + 20 && x < sc.scrollLeft + sc.clientWidth - 20;
    this.renderTimeline(t != null && (from === 'card' || !visible) ? t : null);
    this.renderSel();
    for (const c of this.body.querySelectorAll('.nc')) c.classList.toggle('is-sel', c.dataset.note === this.selNote);
    if (n && from === 'tl') {
      const c = this.body.querySelector(`.nc[data-note="${CSS.escape(n.id)}"]`), sc = this.body.querySelector('.nc-scroller');
      if (c && sc) {
        sc.scrollTo({ left: c.offsetLeft - sc.offsetLeft - 4, behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' });
        c.querySelectorAll('canvas[data-frame]').forEach((cv) => { if (!cv.dataset.drawn) { cv.dataset.drawn = '1'; this.drawFrame(cv, Number(cv.dataset.frame)); } });
      }
    }
  }

  /** 選択した箇所の説明と主人公の画像（正解時・入力時。余分な入力はその時刻の画像） */
  renderSel() {
    const el = this.body.querySelector('.tl-sel');
    if (!el) return;
    const r = this.rec;
    const n = this.selNote ? r.notes.find((x) => x.id === this.selNote) : null;
    const e = this.selExtra != null ? r.extras?.[this.selExtra] : null;
    if (!n && !e) { el.innerHTML = '<p class="hint">選択なし: タイムラインのノーツや入力を押すと、その時刻の主人公の画像と詳細カードを表示します。</p>'; return; }
    const fig = (label, t, f) => `<figure class="nc-fig"><canvas width="132" height="176" data-frame="${f ? f.i : ''}" aria-label="${label}の主人公の画像"></canvas><figcaption><b>${label}</b> ${t3(t)} 秒<br><small>${f ? `コマ ${f.i}（${t3(f.t)} 秒の画像）` : '画像なし'}</small></figcaption></figure>`;
    if (n) {
      const v = VIS.grades[n.result] || { mark: '', label: n.result };
      const ft = n.frames?.target ?? this.frameAt(n.time), fi = n.input ? (n.frames?.input ?? this.frameAt(n.input.time)) : null;
      el.innerHTML = `<div class="tl-sel-imgs">${fig('正解時', n.time, ft)}${n.input ? fig('入力時', n.input.time, fi) : '<figure class="nc-fig nc-none"><div>入力なし</div><figcaption><b>入力時</b> —</figcaption></figure>'}</div>
        <div class="tl-sel-txt"><b>選択: ${esc(n.id)}</b>（${r.notes.indexOf(n) + 1}／${r.notes.length}）<br>正解 <b class="nc-cmd" data-b="${n.button}">${CMD[n.button]}／${n.button}</b> ${t3(n.time)} 秒${n.hold ? `〜${t3(n.hold.end)} 秒` : ''}<br>
        ${n.input ? `入力 <b>${n.input.button}</b> ${t3(n.input.time)} 秒（${sMs(n.input.deltaMs)}）` : '入力なし'} → <b>${v.mark} ${n.result}</b><br><small>詳細は下のカード（枠が明るいカード）</small></div>`;
    } else {
      const f = this.frameAt(e.time);
      el.innerHTML = `<div class="tl-sel-imgs">${fig('入力時', e.time, f)}</div>
        <div class="tl-sel-txt"><b>選択: 不採用の入力</b><br><b class="nc-cmd" data-b="${e.button}">${CMD[e.button]}／${e.button}</b> を ${t3(e.time)} 秒 ${DEVICE_LABEL[e.device] || e.device || ''}<br>どのノーツの判定にも使っていません（付け替えない）。<br><small>画像は今の画像素材のコマの時刻表から選んでいます</small></div>`;
    }
    el.querySelectorAll('canvas[data-frame]').forEach((cv) => this.drawFrame(cv, Number(cv.dataset.frame)));
  }

  detailHtml(r) {
    const list = r.notes.filter((n) => this.filter.has(n.button) && (this.gradeFilter === 'all' || n.result === this.gradeFilter));
    const total = r.notes.length;
    const order = new Map(r.notes.map((n, i) => [n.id, i + 1]));
    const ex = Array.isArray(r.extras) ? r.extras.filter((x) => this.filter.has(x.button)) : null;
    return `${this.filterHtml()}${this.rateNote(r)}
      ${this.tlHtml(r)}
      <h3 class="res-h3">ノーツの詳細（選んだ箇所の詳細表示）</h3>
      ${this.cardFilterHtml(r, false)}
      <p class="hint">時間順に左から右へ並べています。横にスクロール（スマホはスワイプ、PC は ◀ ▶ かスクロールバー）。時刻・ずれは判定に使った補正後の時間軸（${r.settings.inputOffsetMs ? `入力補正 ${r.settings.inputOffsetMs}ms` : '入力補正なし'}）。カードを押すとタイムラインのその位置に移ります。</p>
      <div class="nc-nav"><button type="button" data-nav="-1" aria-label="前のカード">◀</button><span class="nc-pos" aria-live="polite">${list.length ? `1／${list.length}件` : '0 件'}</span><button type="button" data-nav="1" aria-label="次のカード">▶</button>
        <small>${list.length !== total ? `（全 ${total} ノーツ中）` : ''}</small></div>
      <div class="nc-scroller" tabindex="0" aria-label="ノーツのカード（横にスクロール）">${list.map((n) => this.cardHtml(r, n, `${order.get(n.id)}／${total}`)).join('') || '<p class="hint">該当するノーツはありません</p>'}</div>
      <div class="res-scroll"><table class="res-table"><caption>どのノーツにも対応しない入力（判定範囲外・ボタン違い・判定後の入力。ノーツに付け替えない）: ${ex ? `${ex.length} 件` : '記録なし'}</caption>
        <thead><tr><th>入力時刻</th><th>ボタン</th><th>入力方法</th></tr></thead>
        <tbody>${ex ? ex.map((x) => `<tr><td>${t3(x.time)} 秒</td><td>${CMD[x.button]}／${x.button}</td><td>${DEVICE_LABEL[x.device] || x.device || '記録なし'}</td></tr>`).join('') || '<tr><td colspan="3">なし</td></tr>' : '<tr><td colspan="3">記録なし</td></tr>'}</tbody></table></div>`;
  }

  /** 表示後: 照合タイムライン・選択・カードの位置の表示・◀▶・画像（見えたカードから順に描く） */
  afterDetail() {
    this.renderTimeline(this._keepT ?? null);
    this._keepT = null;
    this.renderSel();
    const tl = this.body.querySelector('.tl-scroll');
    tl?.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); this.tlZoom(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    const sc = this.body.querySelector('.nc-scroller');
    if (!sc) return;
    // 小さな時間軸をカードの実際の幅で描き直す（拡大して文字が大きくならないように）
    const ax = sc.querySelector('.nc-axis');
    if (ax && Math.abs(ax.clientWidth - Number(ax.dataset.w)) > 2) {
      this.miniW = ax.clientWidth;
      const byId = new Map(this.rec.notes.map((n) => [n.id, n]));
      for (const c of sc.querySelectorAll('.nc')) {
        const n = byId.get(c.dataset.note), old = c.querySelector('.nc-axis');
        if (n && old) old.outerHTML = this.miniTimeline(this.rec, n, this.relatedInputs(this.rec, n));
      }
    }
    const cards = [...sc.querySelectorAll('.nc')];
    const pos = this.body.querySelector('.nc-pos');
    const update = () => {
      if (!cards.length) return;
      const left = sc.getBoundingClientRect().left + 8;
      let k = cards.findIndex((c) => c.getBoundingClientRect().left + c.offsetWidth / 2 > left);
      if (sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 4) k = cards.length - 1;
      pos.textContent = `${Math.max(0, k) + 1}／${cards.length}件`;
    };
    sc.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
    this.navStep = (d) => { const c = cards[0]; if (c) sc.scrollBy({ left: d * (c.offsetWidth + 10), behavior: 'smooth' }); };
    const draw = (cv) => { if (cv.dataset.drawn) return; cv.dataset.drawn = '1'; this.drawFrame(cv, Number(cv.dataset.frame)); };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { draw(e.target); io.unobserve(e.target); } }), { root: sc, rootMargin: '0px 600px' });
      sc.querySelectorAll('canvas[data-frame]').forEach((cv) => io.observe(cv));
    } else sc.querySelectorAll('canvas[data-frame]').forEach(draw);
    update();
    if (this.selNote) {
      const c = sc.querySelector(`.nc[data-note="${CSS.escape(this.selNote)}"]`);
      if (c) sc.scrollLeft = c.offsetLeft - sc.offsetLeft - 4;
    }
  }

  /** 主人公の画像（全身が入るように、見えている人物の範囲で合わせる。背景は透過の人物が見やすい中間色） */
  async drawFrame(cv, i) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#6b5a4a'); bg.addColorStop(1, '#3d3127');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const st = this.app.store;
    if (!st || !Number.isInteger(i) || !st.frames[i]) return;
    // 再生用の画像の保持（再生位置の前後だけ）とは別に、その場でデコードする（使い終わったら閉じる）
    let bmp = st.peek(i), own = false;
    if (!bmp && st.blobs?.[i]) { try { bmp = await createImageBitmap(st.blobs[i]); own = true; } catch { bmp = null; } }
    if (!bmp) { cv.dataset.error = '1'; return; }
    const f = st.frames[i], [cx, cy] = f.crop, [bx, by, bw, bh] = f.bbox || f.crop;
    const s = Math.min((W * 0.86) / bw, (H * 0.92) / bh);
    const ox = (W - bw * s) / 2 - (bx - cx) * s, oy = (H - bh * s) / 2 - (by - cy) * s;
    g.drawImage(bmp, ox, oy, f.crop[2] * s, f.crop[3] * s);
    if (own) bmp.close?.();
    cv.dataset.ready = '1';
  }

  // ---------- 比較 ----------（compare-view.js）
  compareHtml() { return this.cmp.html(); }

  // ---------- 履歴 ----------
  historyHtml() {
    const list = this.history.records.slice().reverse();
    const cur = this.rec;
    return `<div class="res-hist-actions">
        <button type="button" data-act="exportAll">履歴を JSON で書き出す</button>
        <button type="button" data-act="cmpSel" class="primary-act" ${this.selected.size >= 2 ? '' : 'disabled'}>選択した ${this.selected.size} 件を比較</button>
        <button type="button" data-act="exportSel" ${this.selected.size ? '' : 'disabled'}>選択を書き出す</button>
        <label class="res-file">履歴 JSON を読み込む<input type="file" accept="application/json,.json" data-import></label>
        <button type="button" data-act="deleteSel" class="danger" ${this.selected.size ? '' : 'disabled'}>選択を削除</button>
      </div>
      <p class="hint">2 件以上をチェックして「選択した○件を比較」で、記録同士を比べられます（直近のプレイを含めなくてもよい）。成績の履歴はこのブラウザに保存されます（譜面・編集内容とは別。成績 JSON と譜面 JSON は別の形式で、互いに上書きしません）。${this.history.records.length} 件。</p>
      ${this.history.loadError ? `<p class="res-warn">${esc(this.history.loadError)}</p>` : ''}
      <p id="histMsg" class="hint" role="status"></p>
      ${this.history.official.length ? `<div class="res-scroll"><table class="res-table res-hist res-demo-hist"><caption>公式デモ／シミュレーション（${this.history.official.length} 件。実際の利用者の実績ではありません。自己ベスト・期間平均には含めません）</caption>
        <thead><tr><th><span class="sr">選択</span></th><th>名前</th><th>実際の正答率</th><th>スコア</th><th>平均絶対誤差</th><th>譜面</th><th>判定幅 P/G/M</th><th>速度</th><th>補正</th><th></th></tr></thead>
        <tbody>${this.history.official.map((h) => { const ok = h.summary.perfect + h.summary.good; return `<tr>
          <td><input type="checkbox" data-sel="${esc(h.id)}" ${this.selected.has(h.id) ? 'checked' : ''} aria-label="${esc(h.demo?.label ?? h.id)} を選択"></td>
          <td><em class="rec-demo-tag">公式デモ</em>${esc(h.demo?.label ?? h.id)}</td><td>${pct(ok / h.summary.total)}（${ok}/${h.summary.total}）</td><td>${h.summary.score.toLocaleString()}</td><td>${aMs(h.summary.maeMs)}</td>
          <td>${esc(h.chart.title || '')} <small>${esc(h.chart.hash)}</small></td><td>${h.settings.perfectWindowMs}/${h.settings.goodWindowMs}/${h.settings.missWindowMs}</td><td>${h.rate}×</td><td>${h.settings.inputOffsetMs}ms</td>
          <td><button type="button" data-open="${esc(h.id)}">開く</button> <button type="button" data-replay="${esc(h.id)}">▶ 再現</button>${cur && h.id !== cur.id ? ` <button type="button" data-cmp="${esc(h.id)}">今の記録と比較</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>` : ''}
      <div class="res-scroll"><table class="res-table res-hist"><caption>この端末の履歴（${this.history.records.length} 件）</caption><thead><tr><th><span class="sr">選択</span></th><th>日時</th><th>手動／AUTO・区分</th><th>スコア</th><th>成功率</th><th>平均絶対誤差</th><th>譜面</th><th>判定幅 P/G/M</th><th>速度</th><th>補正</th><th></th></tr></thead>
      <tbody>${list.map((h) => `<tr class="${cur && h.id === cur.id ? 'is-cur' : ''}">
        <td><input type="checkbox" data-sel="${esc(h.id)}" ${this.selected.has(h.id) ? 'checked' : ''} aria-label="${esc(when(h.at))} を選択"></td>
        <td>${esc(when(h.at))}</td><td>${h.mode === 'auto' ? 'AUTO' : '手動'}・${KIND_LABEL[h.kind]}</td><td>${h.summary.score.toLocaleString()}</td><td>${pct(h.summary.successRate)}</td><td>${aMs(h.summary.maeMs)}</td>
        <td>${esc(h.chart.title || '')} <small>${esc(h.chart.hash)}</small></td><td>${h.settings.perfectWindowMs}/${h.settings.goodWindowMs}/${h.settings.missWindowMs}</td><td>${h.rate}×</td><td>${h.settings.inputOffsetMs}ms</td>
        <td><button type="button" data-open="${esc(h.id)}">開く</button>${replayable(h).ok ? ` <button type="button" data-replay="${esc(h.id)}">▶ 再現</button>` : ''}${cur && h.id !== cur.id ? ` <button type="button" data-cmp="${esc(h.id)}">今の記録と比較</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="11">履歴はありません</td></tr>'}</tbody></table></div>`;
  }

  download(text, name, type = 'application/json') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    window.__lastScoreExport = text;
  }

  stamp() { return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16); }

  onClick(e) {
    if (this.tab === 'compare' && this.cmp.onClick(e)) return;
    const item = e.target.closest('[data-sel]');
    if (item && item.closest('.tl-scroll')) { const [k, id] = item.dataset.sel.split(/:(.*)/s); this.select(k, id, 'tl'); return; }
    const card = !e.target.closest('button') && e.target.closest('.nc[data-note]');
    if (card) { this.select('note', card.dataset.note, 'card'); return; }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.replay) {
      const rec = this.history.get(b.dataset.replay);
      const res = rec ? this.app.startReplay(rec) : { ok: false };
      if (res?.ok) this.hide(); else this.msg(res?.reason || 'この履歴はリプレイに必要な記録がありません');
      return;
    }
    if (b.dataset.zoom) { this.tlZoom(b.dataset.zoom === 'fit' ? 'fit' : Number(b.dataset.zoom)); return; }
    if (b.id === 'btnResultClose') { this.hide(); return; }
    if (b.id === 'btnResultRetry') { this.hide(); this.app.retry(); return; }
    if (b.dataset.tab) { this.tab = b.dataset.tab; this.render(); return; }
    if (b.dataset.filter) {
      const k = b.dataset.filter;
      if (this.filter.has(k) && this.filter.size > 1) this.filter.delete(k); else this.filter.add(k);
      this.keepTlCenter(); this.render(); return;
    }
    if (b.dataset.grade) { this.gradeFilter = b.dataset.grade; this.keepTlCenter(); this.render(); return; }
    if (b.dataset.nav) { this.navStep?.(Number(b.dataset.nav)); return; }
    if (b.dataset.open) { this.rec = this.history.get(b.dataset.open); this.selNote = null; this.selExtra = null; this.tlPps = null; this.saveState = null; this.tab = 'summary'; this.render(); return; }
    if (b.dataset.cmp) { this.cmp.setIds([b.dataset.cmp, this.rec.id]); this.tab = 'compare'; this.render(); return; }
    const act = b.dataset.act;
    const v = this.app.version;
    if (act === 'cmpSel') { if (this.selected.size >= 2) { this.cmp.setIds([...this.selected]); this.tab = 'compare'; this.render(); } return; }
    if (act === 'exportOne' && this.rec) this.download(JSON.stringify({ schema: 'kiva-score-history/1', exportedAt: new Date().toISOString(), records: [this.rec] }, null, 2) + '\n', `seipai-${v}-score-${this.stamp()}.json`);
    else if (act === 'exportAll') this.download(this.history.exportText(), `seipai-${v}-scores-${this.stamp()}.json`);
    else if (act === 'exportSel') this.download(this.history.exportText([...this.selected]), `seipai-${v}-scores-${this.stamp()}.json`);
    else if (act === 'deleteSel') {
      for (const id of [...this.selected]) if (this.history.official.some((r) => r.id === id)) this.selected.delete(id); // 公式デモは削除しない
      if (!this.selected.size || !confirm(`選択した ${this.selected.size} 件の記録を削除しますか？（元に戻せません。必要なら先に書き出してください）`)) return;
      const r = this.history.remove([...this.selected]);
      if (this.rec && this.selected.has(this.rec.id)) this.rec = null;
      this.selected.clear();
      this.render();
      this.msg(r.ok ? `${r.removed} 件を削除しました` : `削除を保存できませんでした: ${r.error}`);
    }
  }

  async onChange(e) {
    const t = e.target;
    if (this.tab === 'compare' && this.cmp.onChange(e)) return;
    if (t.matches('[data-sel]')) {
      if (t.checked) this.selected.add(t.dataset.sel); else this.selected.delete(t.dataset.sel);
      for (const b of this.root.querySelectorAll('[data-act=exportSel],[data-act=deleteSel]')) b.disabled = !this.selected.size;
      const cb = this.root.querySelector('[data-act=cmpSel]');
      if (cb) { cb.disabled = this.selected.size < 2; cb.textContent = `選択した ${this.selected.size} 件を比較`; }
      return;
    }
    if (t.matches('[data-import]')) {
      const f = t.files?.[0];
      t.value = '';
      if (!f) return;
      const r = this.history.importText(await f.text());
      this.render();
      this.msg(r.error && !r.added ? `読み込めませんでした: ${r.error}` : `読み込みました: 追加 ${r.added} 件、重複のため省略 ${r.skipped} 件${r.invalid ? `、形式が違う ${r.invalid} 件` : ''}${r.ok ? '' : `（保存できませんでした: ${r.error}）`}`);
    }
  }

  msg(text) { const el = this.root.querySelector('#histMsg'); if (el) el.textContent = text; }
}

export { conditionDiffs };
