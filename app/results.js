// 成績画面: 概要・入力タイミングのグラフ・ノーツごとの詳細・過去との比較・履歴（書き出し・読み込み・削除）。
// 表示する数値はすべて記録（score.js の buildRecord / summarize）から計算する（画面と記録が食い違わない）。
// ずれは譜面の時間軸の ms（判定と同じ基準）。マイナス = 早い、プラス = 遅い。入力のない MISS は 0ms に描かず別に示す。

import { CMD, DEVICE_LABEL, KIND_LABEL, HOLD_STATUS_LABEL, comparisonTargets, compareRecords, conditionDiffs } from './score.js';

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
    this.compareTo = 'previous';
    this.selected = new Set();
    this.root.innerHTML = `
      <div class="card results" tabindex="-1">
        <div class="res-head">
          <h2 id="resultTitle">成績</h2>
          <span class="res-head-btns"><button type="button" id="btnResultRetry" class="tbtn">リトライ</button><button type="button" id="btnResultClose" class="tbtn">閉じる</button></span>
        </div>
        <div class="res-tabs" role="tablist">
          ${[['summary', '概要'], ['timing', 'タイミング'], ['detail', 'ノーツ詳細'], ['compare', '比較'], ['history', '履歴']]
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
    window.addEventListener('resize', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (!this.root.hidden && ['timing', 'compare'].includes(this.tab)) this.render(); }); });
  }

  get history() { return this.app.history; }

  show(rec, { saved = null, tab = 'summary' } = {}) {
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
    this.root.querySelector('#resultTitle').textContent = !r ? '成績' : r.mode === 'auto' ? 'AUTO 再生の記録（手動の成績・自己ベストには含めません）' : `成績（${KIND_LABEL[r.kind]}）`;
    if (this.tab === 'history') { this.body.innerHTML = this.historyHtml(); return; }
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
    return `${save}
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

  // ---------- タイミングのグラフ ----------
  filterHtml() {
    return `<div class="res-filter" role="group" aria-label="技で絞り込み">${BTN.map((b) => `<button type="button" data-filter="${b}" aria-pressed="${this.filter.has(b)}">${CMD[b]}</button>`).join('')}</div>`;
  }

  /** 入力タイミングの図（SVG）。series: [{notes, style:'cur'|'base'}]。pairs があれば同じノーツを線で結ぶ */
  graphSvg(r, series, pairs = null) {
    const s = r.settings, R = Math.max(s.missWindowMs, ...series.flatMap((x) => x.notes.map((n) => Math.abs(n.d ?? 0)))) * 1.05;
    const rows = BTN.filter((b) => this.filter.has(b));
    // 幅は画面に合わせる（スマホの縦でも文字が読める大きさ）
    const W = Math.max(340, Math.min(640, Math.round(this.body.clientWidth || 640))), L = 48, Rm = 12, top = 30, rowH = 46, H = top + rows.length * rowH + 34;
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

  cardFilterHtml(r) {
    const g = this.gradeFilter;
    const count = (k) => r.notes.filter((n) => (k === 'all' || n.result === k) && this.filter.has(n.button)).length;
    return `<div class="res-filter" role="group" aria-label="判定で絞り込み">${[['all', 'すべて'], ['PERFECT', `${VIS.grades.PERFECT.mark} PERFECT`], ['GOOD', `${VIS.grades.GOOD.mark} GOOD`], ['MISS', `${VIS.grades.MISS.mark} MISS`]]
      .map(([k, l]) => `<button type="button" data-grade="${k}" aria-pressed="${g === k}">${l}（${count(k)}）</button>`).join('')}</div>${this.filterHtml()}`;
  }

  /** 小さな時間軸: 正解（0）・判定の範囲・採用した入力・採用していない入力 */
  miniTimeline(r, n, inputs) {
    const s = r.settings, W = 280, H = 58, L = 10, Rm = 10, cy = 26;
    const R = Math.max(s.missWindowMs * 1.15, ...inputs.map((x) => Math.abs(x.deltaMs ?? 0) + 15));
    const X = (v) => L + ((v + R) / (2 * R)) * (W - L - Rm);
    let g = `<svg class="res-graph nc-axis" viewBox="0 0 ${W} ${H}" role="img" aria-label="正解の時刻と入力の位置（ms）">`;
    g += `<rect x="${X(-s.missWindowMs)}" y="${cy - 12}" width="${X(s.missWindowMs) - X(-s.missWindowMs)}" height="24" class="band-miss"/>`;
    g += `<rect x="${X(-s.goodWindowMs)}" y="${cy - 12}" width="${X(s.goodWindowMs) - X(-s.goodWindowMs)}" height="24" class="${VIS.bands.good.cls}"/>`;
    g += `<rect x="${X(-s.perfectWindowMs)}" y="${cy - 12}" width="${X(s.perfectWindowMs) - X(-s.perfectWindowMs)}" height="24" class="${VIS.bands.perfect.cls}"/>`;
    g += `<line x1="${X(0)}" x2="${X(0)}" y1="${cy - 15}" y2="${cy + 15}" class="axis0"/>`;
    g += `<text x="${X(0)}" y="${H - 4}" class="tick-l">正解 0</text><text x="${L}" y="${H - 4}" class="tick-l" text-anchor="start">← 早い</text><text x="${W - Rm}" y="${H - 4}" class="tick-l" text-anchor="end">遅い →</text>`;
    for (const x of inputs) {
      if (x.deltaMs == null) continue;
      const px = X(x.deltaMs);
      g += x.adopted
        ? `<g class="${VIS.grades[n.result]?.cls || 'g-miss'} cur"><title>採用: ${sMs(x.deltaMs)}</title>${markShape(n.result, px, cy, 1.1)}</g><text x="${px}" y="${cy - 15}" class="tick-l nc-lab">採用</text>`
        : `<g class="g-extra"><title>不採用: ${sMs(x.deltaMs)} ${x.button}</title>${markShape('EXTRA', px, cy, 1)}</g><text x="${px}" y="${cy + 24}" class="tick-l nc-lab">不採用</text>`;
    }
    return `${g}</svg>`;
  }

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
    const fig = (label, t, f, kind) => `<figure class="nc-fig"><canvas width="132" height="176" data-frame="${f ? f.i : ''}" aria-label="${label}の主人公の画像"></canvas>
      <figcaption><b>${label}</b> ${t3(t)} 秒<br><small>${f ? `コマ ${f.i}（${t3(f.t)} 秒の画像）` : '画像なし'}</small></figcaption></figure>`;
    const h = n.hold;
    const holdHtml = !h ? '' : `<dl class="nc-hold">
      <dt>正解の開始・終了</dt> <dd>${t3(n.time)} 〜 ${h.end != null ? t3(h.end) : '記録なし'} 秒（${h.duration != null ? `${h.duration.toFixed(2)} 秒` : '記録なし'}）</dd> 
      <dt>押下</dt> <dd>${h.pressedAt === undefined ? '記録なし' : h.pressedAt == null ? '押していない' : `${t3(h.pressedAt)} 秒（${inp ? sMs(inp.deltaMs) : '—'}）`}</dd> 
      <dt>解除</dt> <dd>${h.releasedAt === undefined ? '記録なし' : h.releasedAt == null ? (h.status === 'completed-held' ? '離す前に終了' : '—') : `${t3(h.releasedAt)} 秒（終了から ${sMs(h.releaseDeltaMs)}）`}</dd> 
      <dt>保持時間</dt> <dd>必要 ${h.requiredSec != null ? `${h.requiredSec.toFixed(2)} 秒` : '記録なし'} ／ 実際 ${h.heldSec === undefined ? '記録なし' : h.heldSec == null ? '—' : `${h.heldSec.toFixed(2)} 秒`}</dd> 
      <dt>早離し</dt> <dd>${h.status === undefined ? '記録なし' : h.status === 'early-release' ? 'あり（途中解除）' : 'なし'}${h.completedAt != null ? `（${t3(h.completedAt)} 秒に保持して成功）` : ''}</dd> 
    </dl>`;
    return `<article class="nc ${v.cls}" data-note="${esc(n.id)}" data-grade="${n.result}" aria-label="${no} 番目 ${esc(n.id)} ${CMD[n.button]}">
      <header><span class="nc-no">${no}</span><span class="nc-id">${esc(n.id)}</span><span class="nc-grade">${v.mark} ${n.result}</span></header>
      <p class="nc-line"><span class="nc-k">正解</span> <b class="nc-cmd" data-b="${n.button}">${CMD[n.button]}／${n.button}</b> <span>${t3(n.time)} 秒</span></p>
      <p class="nc-line"><span class="nc-k">入力</span> ${inp ? `<b class="nc-cmd" data-b="${inp.button}">${inp.button}</b> を <span>${t3(inp.time)} 秒</span> <small>${DEVICE_LABEL[inp.device] || inp.device || '入力方法の記録なし'}</small>` : '<b>入力なし</b>'}</p>
      ${wrong.length ? `<p class="nc-line nc-wrong"><span class="nc-k">押したボタン</span> ${wrong.map((x) => `<b class="nc-cmd" data-b="${x.button}">${CMD[x.button]}／${x.button}</b> ${t3(x.time)} 秒`).join('、')}<small>（要求は ${CMD[n.button]}／${n.button}・判定に使っていない）</small></p>` : ''}
      <p class="nc-verdict">${verdict}</p>
      ${inp && inp.rawDeltaMs !== undefined && inp.rawDeltaMs !== inp.deltaMs ? `<p class="nc-small">入力補正 ${r.settings.inputOffsetMs}ms の後のずれ。補正前は ${sMs(inp.rawDeltaMs)}</p>` : inp && inp.rawDeltaMs === undefined ? '<p class="nc-small">補正前の時刻: 記録なし</p>' : ''}
      <div class="nc-imgs">${fig('正解時', n.time, ft, 'target')}${inp ? fig('入力時', inp.time, fi, 'input') : '<figure class="nc-fig nc-none"><div>入力なし</div><figcaption><b>入力時</b> —<br><small>入力がないので画像は作りません</small></figcaption></figure>'}</div>
      ${inp && ft && fi && ft.i === fi.i ? '<p class="nc-small">2 枚は同じ画像です（素材は 0.2 秒間隔）。ずれは上の数値が正確です。</p>' : ''}
      ${this.miniTimeline(r, n, inputs)}
      ${holdHtml}
      ${inputs.length ? `<ol class="nc-inputs" aria-label="関係する入力（時刻順）">${inputs.map((x) => `<li class="${x.adopted ? 'adopted' : ''}">${t3(x.time)} 秒 <b>${CMD[x.button]}／${x.button}</b> ${sMs(x.deltaMs)} ${DEVICE_LABEL[x.device] || x.device || ''} — ${x.adopted ? '<b>判定に採用</b>' : esc(x.note)}</li>`).join('')}</ol>` : '<p class="nc-small">関係する入力: なし</p>'}
    </article>`;
  }

  detailHtml(r) {
    const list = r.notes.filter((n) => this.filter.has(n.button) && (this.gradeFilter === 'all' || n.result === this.gradeFilter));
    const total = r.notes.length;
    const order = new Map(r.notes.map((n, i) => [n.id, i + 1]));
    const ex = Array.isArray(r.extras) ? r.extras.filter((x) => this.filter.has(x.button)) : null;
    return `${this.cardFilterHtml(r)}${this.rateNote(r)}
      <p class="hint">各ノーツを時間順に左から右へ並べています。横にスクロール（スマホはスワイプ、PC は ◀ ▶ かスクロールバー）。時刻・ずれは判定に使った補正後の時間軸（${r.settings.inputOffsetMs ? `入力補正 ${r.settings.inputOffsetMs}ms` : '入力補正なし'}）。</p>
      <div class="nc-nav"><button type="button" data-nav="-1" aria-label="前のカード">◀</button><span class="nc-pos" aria-live="polite">${list.length ? `1／${list.length}件` : '0 件'}</span><button type="button" data-nav="1" aria-label="次のカード">▶</button>
        <small>${list.length !== total ? `（全 ${total} ノーツ中）` : ''}</small></div>
      <div class="nc-scroller" tabindex="0" aria-label="ノーツのカード（横にスクロール）">${list.map((n) => this.cardHtml(r, n, `${order.get(n.id)}／${total}`)).join('') || '<p class="hint">該当するノーツはありません</p>'}</div>
      <div class="res-scroll"><table class="res-table"><caption>どのノーツにも対応しない入力（判定範囲外・ボタン違い・判定後の入力。ノーツに付け替えない）: ${ex ? `${ex.length} 件` : '記録なし'}</caption>
        <thead><tr><th>入力時刻</th><th>ボタン</th><th>入力方法</th></tr></thead>
        <tbody>${ex ? ex.map((x) => `<tr><td>${t3(x.time)} 秒</td><td>${CMD[x.button]}／${x.button}</td><td>${DEVICE_LABEL[x.device] || x.device || '記録なし'}</td></tr>`).join('') || '<tr><td colspan="3">なし</td></tr>' : '<tr><td colspan="3">記録なし</td></tr>'}</tbody></table></div>`;
  }

  /** カードの表示後: 位置の表示・◀▶・画像（見えたカードから順に描く） */
  afterDetail() {
    const sc = this.body.querySelector('.nc-scroller');
    if (!sc) return;
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

  // ---------- 比較 ----------
  compareTarget(r) {
    const list = this.history.records;
    const t = comparisonTargets(r, list);
    if (this.compareTo === 'previous') return { rec: t.previous, label: '前回（同条件）' };
    if (this.compareTo === 'best') return { rec: t.best, label: '同条件の自己ベスト（手動・通しプレイ）' };
    const sel = list.find((h) => h.id === this.compareTo);
    return { rec: sel || null, label: '選択した記録' };
  }

  compareHtml(r) {
    const list = this.history.records.filter((h) => h.id !== r.id).slice().reverse();
    const { rec: base, label } = this.compareTarget(r);
    const opts = `<option value="previous" ${this.compareTo === 'previous' ? 'selected' : ''}>前回（同条件）</option>
      <option value="best" ${this.compareTo === 'best' ? 'selected' : ''}>同条件の自己ベスト</option>
      ${list.map((h) => `<option value="${esc(h.id)}" ${this.compareTo === h.id ? 'selected' : ''}>${esc(when(h.at))} ${h.mode === 'auto' ? 'AUTO' : '手動'}・${KIND_LABEL[h.kind]} ${h.summary.score.toLocaleString()} 点</option>`).join('')}`;
    const head = `<label class="res-sel">比較する記録 <select data-compare>${opts}</select></label>
      <p class="hint">同条件 = 同じ譜面・判定幅・入力補正・再生速度の手動プレイ。AUTO は自己ベスト・同条件の候補に入りません。練習（シーク・区間ループなど）は通しプレイの自己ベストに入りません。</p>`;
    if (r.mode === 'auto') return `${head}<p class="res-warn">この記録は AUTO 再生です（手動の成績と比較する対象ではありません）。</p>${base ? this.compareBody(r, base, label) : ''}`;
    if (!base) return `${head}<p>${label}の記録がありません。</p>`;
    return head + this.compareBody(r, base, label);
  }

  compareBody(r, base, label) {
    const c = compareRecords(r, base);
    const diffs = c.conditions.length
      ? `<div class="res-warn" role="note"><b>条件が違います</b>（数値はそのまま比べられません）: ${c.conditions.map((d) => `${d.name} ${d.key === 'chartHash' ? '別の譜面' : `${d.b} → ${d.a}`}`).join('、')}</div>` : '<p class="hint">同じ条件の記録です。</p>';
    const good = (v) => (v == null ? '' : v > 0 ? 'better' : v < 0 ? 'worse' : '');
    const word = (v, up, down) => (v == null ? '' : v > 0 ? up : v < 0 ? down : '変化なし');
    const pts = this.points(r), bpts = this.points(base);
    return `<p>比較: ${label} ／ ${esc(when(base.at))} の${base.mode === 'auto' ? 'AUTO' : '手動'}・${KIND_LABEL[base.kind]}</p>${diffs}
      <div class="res-grid">
        <div class="${good(c.scoreDiff)}"><span>スコアの差</span><b>${sgn(c.scoreDiff, ' 点', 0)}</b><small>${base.summary.score.toLocaleString()} → ${r.summary.score.toLocaleString()}</small></div>
        <div class="${good(c.successRatePt)}"><span>成功率の差</span><b>${sgn(c.successRatePt, ' pt')}</b><small>${pct(base.summary.successRate)} → ${pct(r.summary.successRate)}</small></div>
        <div class="${good(c.maeImproveMs)}"><span>平均絶対誤差</span><b>${c.maeImproveMs == null ? '—' : `${Math.abs(c.maeImproveMs).toFixed(1)}ms ${word(c.maeImproveMs, '改善', '悪化')}`}</b><small>${aMs(base.summary.maeMs)} → ${aMs(r.summary.maeMs)}</small></div>
        <div><span>平均符号付き誤差</span><b>${sMs(base.summary.meanMs)} → ${sMs(r.summary.meanMs)}</b></div>
        <div class="${good(c.sdImproveMs)}"><span>ばらつき（標準偏差）</span><b>${aMs(base.summary.sdMs)} → ${aMs(r.summary.sdMs)}</b></div>
      </div>
      <div class="res-scroll"><table class="res-table"><caption>技ごとの変化</caption><thead><tr><th>技</th><th>成功率</th><th>差</th><th>平均絶対誤差</th><th>改善量</th><th>平均符号付き</th></tr></thead>
        <tbody>${BTN.map((b) => { const x = c.byCmd[b]; return `<tr><th>${CMD[b]}／${b}</th><td>${pct(x.base.successRate)} → ${pct(x.cur.successRate)}</td><td class="${good(x.successRatePt)}">${sgn(x.successRatePt, ' pt')}</td>
          <td>${aMs(x.base.maeMs)} → ${aMs(x.cur.maeMs)}</td><td class="${good(x.maeImproveMs)}">${x.maeImproveMs == null ? '—' : `${Math.abs(x.maeImproveMs).toFixed(1)}ms ${word(x.maeImproveMs, '改善', '悪化')}`}</td><td>${sMs(x.base.meanMs)} → ${sMs(x.cur.meanMs)}</td></tr>`; }).join('')}</tbody></table></div>
      ${c.sameChart ? `${this.filterHtml()}<p class="hint">同じノーツの入力位置（同じ目盛り）。線で同じノーツを結んでいます。</p>${this.legendHtml(r, { compare: true })}
        ${this.graphSvg(r, [{ notes: bpts, style: 'base', label: '比較' }, { notes: pts, style: 'cur', label: '今回' }], c.pairs)}` : '<p class="hint">譜面が違うため、ノーツごとの比較はできません。</p>'}`;
  }

  // ---------- 履歴 ----------
  historyHtml() {
    const list = this.history.records.slice().reverse();
    const cur = this.rec;
    return `<div class="res-hist-actions">
        <button type="button" data-act="exportAll">履歴を JSON で書き出す</button>
        <button type="button" data-act="exportSel" ${this.selected.size ? '' : 'disabled'}>選択を書き出す</button>
        <label class="res-file">履歴 JSON を読み込む<input type="file" accept="application/json,.json" data-import></label>
        <button type="button" data-act="deleteSel" class="danger" ${this.selected.size ? '' : 'disabled'}>選択を削除</button>
      </div>
      <p class="hint">成績の履歴はこのブラウザに保存されます（譜面・編集内容とは別。成績 JSON と譜面 JSON は別の形式で、互いに上書きしません）。${this.history.records.length} 件。</p>
      ${this.history.loadError ? `<p class="res-warn">${esc(this.history.loadError)}</p>` : ''}
      <p id="histMsg" class="hint" role="status"></p>
      <div class="res-scroll"><table class="res-table res-hist"><thead><tr><th><span class="sr">選択</span></th><th>日時</th><th>区分</th><th>スコア</th><th>成功率</th><th>平均絶対誤差</th><th>速度</th><th>判定幅 P/G/M</th><th></th></tr></thead>
      <tbody>${list.map((h) => `<tr class="${cur && h.id === cur.id ? 'is-cur' : ''}">
        <td><input type="checkbox" data-sel="${esc(h.id)}" ${this.selected.has(h.id) ? 'checked' : ''} aria-label="${esc(when(h.at))} を選択"></td>
        <td>${esc(when(h.at))}</td><td>${h.mode === 'auto' ? 'AUTO' : '手動'}・${KIND_LABEL[h.kind]}</td><td>${h.summary.score.toLocaleString()}</td><td>${pct(h.summary.successRate)}</td><td>${aMs(h.summary.maeMs)}</td>
        <td>${h.rate}×</td><td>${h.settings.perfectWindowMs}/${h.settings.goodWindowMs}/${h.settings.missWindowMs}</td>
        <td><button type="button" data-open="${esc(h.id)}">開く</button>${cur && h.id !== cur.id ? ` <button type="button" data-cmp="${esc(h.id)}">今の記録と比較</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9">履歴はありません</td></tr>'}</tbody></table></div>`;
  }

  download(text, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    window.__lastScoreExport = text;
  }

  stamp() { return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16); }

  onClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'btnResultClose') { this.hide(); return; }
    if (b.id === 'btnResultRetry') { this.hide(); this.app.retry(); return; }
    if (b.dataset.tab) { this.tab = b.dataset.tab; this.render(); return; }
    if (b.dataset.filter) {
      const k = b.dataset.filter;
      if (this.filter.has(k) && this.filter.size > 1) this.filter.delete(k); else this.filter.add(k);
      this.render(); return;
    }
    if (b.dataset.grade) { this.gradeFilter = b.dataset.grade; this.render(); return; }
    if (b.dataset.nav) { this.navStep?.(Number(b.dataset.nav)); return; }
    if (b.dataset.open) { this.rec = this.history.get(b.dataset.open); this.saveState = null; this.tab = 'summary'; this.render(); return; }
    if (b.dataset.cmp) { this.compareTo = b.dataset.cmp; this.tab = 'compare'; this.render(); return; }
    const act = b.dataset.act;
    const v = this.app.version;
    if (act === 'exportOne' && this.rec) this.download(JSON.stringify({ schema: 'kiva-score-history/1', exportedAt: new Date().toISOString(), records: [this.rec] }, null, 2) + '\n', `seipai-${v}-score-${this.stamp()}.json`);
    else if (act === 'exportAll') this.download(this.history.exportText(), `seipai-${v}-scores-${this.stamp()}.json`);
    else if (act === 'exportSel') this.download(this.history.exportText([...this.selected]), `seipai-${v}-scores-${this.stamp()}.json`);
    else if (act === 'deleteSel') {
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
    if (t.matches('[data-compare]')) { this.compareTo = t.value; this.render(); return; }
    if (t.matches('[data-sel]')) {
      if (t.checked) this.selected.add(t.dataset.sel); else this.selected.delete(t.dataset.sel);
      for (const b of this.root.querySelectorAll('[data-act=exportSel],[data-act=deleteSel]')) b.disabled = !this.selected.size;
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
