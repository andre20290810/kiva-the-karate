// 成績の比較画面: 「記録の比較」（履歴から 2 件以上を選ぶ）と「期間平均の比較」。計算は compare.js（DOM 非依存）。
// 表示はすべて保存済みの記録から作る（プレイ当時の譜面・入力・判定条件。今の譜面から計算し直さない）。

import { CMD, DEVICE_LABEL, KIND_LABEL, conditionDiffs } from './score.js';
import { LANE_STYLE } from './lanes.js';
import { timeTicks } from './timeline.js';
import { compareMany, comparePeriods, presetPeriods, PERIOD_PRESETS, condKey, condLabel, periodCsv, styleOf, BUTTONS, fmtImp, dedupe } from './compare.js';
import { VIS, markShape } from './results.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sMs = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}ms`);
const aMs = (v) => (v == null ? '—' : `${v.toFixed(1)}ms`);
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const t3 = (v) => (v == null ? '—' : v.toFixed(3));
const when = (iso) => { try { return new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }); } catch { return iso; } };
const GC = { PERFECT: 'g-perfect', GOOD: 'g-good', MISS: 'g-miss' };
/** 記録の名前: 公式デモは名前（シミュレーションと明示）、それ以外はプレイ日時 */
const recName = (r) => (r.mode === 'demo' ? `${r.demo?.label ?? r.id}（シミュレーション）` : when(r.at));
const modeName = (r) => (r.mode === 'demo' ? '公式デモ' : r.mode === 'auto' ? 'AUTO' : '手動');
/** 変化の表示（色と文字・記号で区別。凡例と同じ） */
export const CHANGE = Object.freeze({
  up: { cls: 'k-up', mark: '▲', text: '改善' }, down: { cls: 'k-down', mark: '▼', text: '悪化' }, same: { cls: 'k-same', mark: '＝', text: '変化なし' },
  na: { cls: 'k-na', mark: '？', text: '比較不能' }, base: { cls: 'k-base', mark: '◎', text: '基準' },
});
const ptText = (v, good = 'up') => (v == null ? '—' : v === 0 ? '±0.0 ポイント（変化なし）' : `${Math.abs(v).toFixed(1)} ポイント${(v > 0) === (good === 'up') ? '向上' : '低下'}`);
const missText = (v) => (v == null ? '—' : v === 0 ? '±0.0 ポイント（変化なし）' : `${Math.abs(v).toFixed(1)} ポイント${v < 0 ? '減少（改善）' : '増加（悪化）'}`);
/** 照合の時間軸の寸法 */
const CT = Object.freeze({ head: 20, noteH: 22, gap: 6, recH: 38, labW: 128, pad: 12 });
const ZOOM = Object.freeze([4, 6, 10, 16, 25, 40, 60, 100, 160, 250, 400, 640, 1000]);

export class CompareView {
  constructor(results) {
    this.R = results;                    // ResultsView（画像・文字の幅・書き出しを共用）
    this.mode = 'records';               // records | period
    this.ids = [];                       // 比較する記録
    this.baseId = null;                  // 改善量の基準（null = 最も古い記録）
    this.selNote = null;                 // 選んだノーツ
    this.pps = null;                     // 時間軸の拡大率
    this.cmdFilter = new Set(BUTTONS);
    this.rowFilter = 'all';              // all | up | down | miss
    this.pickOpen = false;
    this.period = { preset: 'last7', ...presetPeriods('last7'), cond: null, includeAuto: false, includePractice: false, includeAborted: false, mixCharts: false, sort: 'time', sel: null };
  }

  get history() { return this.R.history; }
  get app() { return this.R.app; }

  /** 比較する記録を設定（履歴の選択から）。基準は最も古い記録 */
  setIds(ids) { this.ids = [...new Set(ids)].filter((id) => this.history.get(id)); this.baseId = null; this.selNote = null; this.pps = null; this.mode = 'records'; }

  html() {
    const tabs = `<div class="cmp-mode res-filter" role="tablist" aria-label="比較の種類">
      <button type="button" role="tab" data-cmode="records" aria-pressed="${this.mode === 'records'}">記録の比較（2 件以上を選ぶ）</button>
      <button type="button" role="tab" data-cmode="period" aria-pressed="${this.mode === 'period'}">期間平均の比較</button></div>`;
    return tabs + (this.mode === 'period' ? this.periodHtml() : this.recordsHtml());
  }

  after() {
    if (this.mode === 'records' && this.data) { this.renderTimeline(); this.renderDetail(); }
    if (this.mode === 'period' && this.pdata && !this.pdata.error) { this.renderPeriodTimeline(); this.renderPeriodSel(); }
  }

  // ================= 記録の比較 =================
  /** 履歴から記録を選ぶ表（日時・スコア・譜面・判定幅・速度・手動／AUTO・区分） */
  pickerHtml() {
    const list = [...this.history.official, ...this.history.records.slice().reverse()]; // 公式デモ（シミュレーション）も選べる
    const sel = new Set(this._pick ?? this.ids); // チェック中（「比較」を押すまでは今の比較を変えない）
    return `<details class="cmp-pick" ${this.pickOpen || this.ids.length < 2 ? 'open' : ''}><summary>比較する記録を選ぶ（${sel.size} 件選択中）</summary>
      <p class="hint">2 件以上をチェックして「比較する」。直近のプレイを含める必要はありません。公式デモ（シミュレーション）とも比較できます。条件（譜面・判定幅・速度・入力補正）が違う記録も選べますが、違いを表示し、同じ条件の改善とは区別します。</p>
      <div class="res-scroll cmp-pick-list"><table class="res-table"><thead><tr><th><span class="sr">選択</span></th><th>日時</th><th>スコア</th><th>譜面</th><th>判定幅 P/G/M</th><th>速度</th><th>補正</th><th>手動／AUTO</th><th>区分</th></tr></thead>
      <tbody>${list.map((h) => `<tr><td><input type="checkbox" data-cpick="${esc(h.id)}" ${sel.has(h.id) ? 'checked' : ''} aria-label="${esc(recName(h))} を比較に入れる"></td>
        <td>${h.mode === 'demo' ? `<em class="rec-demo-tag">公式デモ</em>${esc(h.demo?.label ?? h.id)}` : esc(when(h.at))}</td><td>${h.summary.score.toLocaleString()}</td><td>${esc(h.chart.title || '')} <small>${esc(h.chart.hash)}</small></td>
        <td>${h.settings.perfectWindowMs}/${h.settings.goodWindowMs}/${h.settings.missWindowMs}</td><td>${h.rate}×</td><td>${h.settings.inputOffsetMs}ms</td>
        <td>${modeName(h)}</td><td>${h.mode === 'demo' ? 'シミュレーション' : KIND_LABEL[h.kind]}</td></tr>`).join('') || '<tr><td colspan="9">履歴はありません</td></tr>'}</tbody></table></div>
      <div class="cmp-pick-act"><button type="button" class="tbtn primary" data-cact="apply" ${sel.size >= 2 ? '' : 'disabled'}>選択した ${sel.size} 件を比較</button>
        <button type="button" class="tbtn" data-cact="clear" ${sel.size ? '' : 'disabled'}>選択を解除</button></div></details>`;
  }

  recordsHtml() {
    const recs = this.ids.map((id) => this.history.get(id)).filter(Boolean);
    if (recs.length < 2) { this.data = null; return `${this.pickerHtml()}<p class="hint">比較する記録を 2 件以上選んでください（「履歴」タブのチェックからも選べます）。</p>`; }
    const d = this.data = compareMany(recs, this.baseId);
    this.styles = new Map(d.recs.map((x) => [x.rec.id, x]));
    const base = d.base.rec;
    const legend = `<ul class="cmp-legend" aria-label="比較する記録（色と記号は画面全体で共通）">${d.recs.map((x) => {
      const r = x.rec, s = d.summary.find((y) => y.id === r.id), diff = s.conditions;
      return `<li style="--rc:${x.color}"><span class="cmp-badge">${x.sym}</span><span>${r.mode === 'demo' ? '<em class="rec-demo-tag">公式デモ</em>' : ''}<b>${esc(recName(r))}</b> ${modeName(r)}・${r.mode === 'demo' ? 'シミュレーション' : KIND_LABEL[r.kind]}・${r.summary.score.toLocaleString()} 点
        <small class="cmp-cond">譜面 ${esc(r.chart.hash)}・判定幅 ${r.settings.perfectWindowMs}/${r.settings.goodWindowMs}/${r.settings.missWindowMs}・速度 ${r.rate}×・補正 ${r.settings.inputOffsetMs}ms</small>
        ${r.id === base.id ? '<em class="cmp-basetag">基準</em>' : ''}${diff.length ? `<em class="cmp-warn">条件が違う: ${diff.map((c) => `${c.name} ${c.key === 'chartHash' ? '別の譜面' : `${c.b}→${c.a}`}`).join('、')}</em>` : ''}</span>
        <label class="cmp-base"><input type="radio" name="cmpBase" data-cbase="${esc(r.id)}" ${r.id === base.id ? 'checked' : ''}> 基準</label>
        <button type="button" class="cmp-rm" data-crm="${esc(r.id)}" aria-label="${esc(when(r.at))} を比較から外す" ${recs.length <= 2 ? 'disabled' : ''}>外す</button></li>`;
    }).join('')}</ul>`;
    return `${this.pickerHtml()}
      <h3 class="res-h3">比較する記録（基準 = ${esc(when(base.at))}。改善量 = 基準の絶対誤差 − 比較する記録の絶対誤差）</h3>
      ${legend}
      ${this.summaryHtml(d)}
      ${d.recs.length >= 3 ? this.trendHtml(d) : ''}
      <h3 class="res-h3">全編の照合（0 秒〜${this.duration(d).toFixed(1)} 秒。編集画面と同じ時間軸）</h3>
      ${this.tlLegendHtml()}
      <div class="tl-tools"><span class="tl-zoom" role="group" aria-label="拡大・縮小"><button type="button" data-czoom="-1" aria-label="縮小">－</button><button type="button" data-czoom="1" aria-label="拡大">＋</button><button type="button" data-czoom="fit">全体</button></span><span class="tl-scale cmp-scale"></span></div>
      <div class="tl-wrap cmp-wrap"><div class="tl-labels cmp-labels"></div><div class="tl-scroll cmp-scroll" tabindex="0" aria-label="全編の照合（横にスクロール）"></div></div>
      <div class="cmp-detail" aria-live="polite"></div>
      <h3 class="res-h3">ノーツ別の比較表（行 = ノーツ、列 = 記録）</h3>
      ${this.matrixHtml(d)}`;
  }

  duration(d) {
    const ds = d.recs.map((x) => x.rec.chart?.duration).filter(Boolean);
    if (ds.length) return Math.max(...ds);
    const ends = d.recs.flatMap((x) => x.rec.notes.map((n) => n.time + (n.hold?.duration || 0)));
    return Math.ceil(Math.max(...ends, 1) + 1);
  }

  badge(id) { const s = this.styles.get(id); return `<span class="cmp-badge" style="--rc:${s.color}">${s.sym}</span>`; }

  summaryHtml(d) {
    const cols = d.recs.map((x) => x.rec.id);
    const S = (id) => d.summary.find((s) => s.id === id);
    const row = (label, f) => `<tr><th>${label}</th>${cols.map((id) => `<td>${f(S(id), this.history.get(id))}</td>`).join('')}</tr>`;
    const head = `<tr><th>項目</th>${d.recs.map((x) => `<th>${this.badge(x.rec.id)} ${esc(recName(x.rec))}</th>`).join('')}</tr>`;
    const imp = (s, r) => (r.id === d.base.rec.id ? '基準' : s.maeImprove == null ? '—' : `${fmtImp(s.maeImprove)}${s.conditions.length ? '（※条件が違う）' : ''}`);
    const t = `<div class="res-scroll"><table class="res-table cmp-sum"><caption>全体（基準の譜面と対応したノーツで集計。入力なし・ボタン違いは誤差に入れず MISS に数える）</caption><thead>${head}</thead><tbody>
      ${row('スコア', (s, r) => r.summary.score.toLocaleString())}
      ${row('成功率', (s) => `${pct(s.successRate)}（${s.perfect + s.good}/${s.n}）`)}
      ${row('PERFECT 率', (s) => `${pct(s.perfectRate)}（${s.perfect}）`)}
      ${row('MISS 率', (s) => `${pct(s.missRate)}（${s.miss} 件。入力なし ${s.missNoInput}）`)}
      ${row('平均絶対誤差', (s) => `${aMs(s.mae)}（入力 ${s.timed} 件）`)}
      ${row('平均符号付き誤差', (s) => `${sMs(s.mean)}${s.mean == null ? '' : s.mean < 0 ? ' 早押し傾向' : s.mean > 0 ? ' 遅押し傾向' : ''}`)}
      ${row('ばらつき（標準偏差）', (s) => aMs(s.sd))}
      ${row('平均絶対誤差の改善', imp)}
      ${row('改善／悪化したノーツ', (s, r) => (r.id === d.base.rec.id ? '基準' : `▲ ${s.up} 改善 ／ ▼ ${s.down} 悪化 ／ ＝ ${s.same}`))}
      ${row('息の保持・解除の成功', (s) => (s.holdN ? `${s.holdOk}/${s.holdN}` : '記録なし'))}
      ${row('比較できないノーツ', (s) => (s.changed || s.missing ? `条件変更 ${s.changed}・対応なし ${s.missing}` : 'なし'))}
    </tbody></table></div>`;
    const cmd = `<div class="res-scroll"><table class="res-table cmp-sum"><caption>技ごと（成功率・平均絶対誤差・改善／悪化したノーツ数）</caption><thead>${head}</thead><tbody>
      ${BUTTONS.map((b) => row(`${CMD[b]}／${b}`, (s, r) => `${pct(s.byCmd[b].successRate)} ・ ${aMs(s.byCmd[b].mae)}${r.id === d.base.rec.id ? '' : `<br><small>▲${s.byCmdChange[b].up} ▼${s.byCmdChange[b].down}</small>`}`)).join('')}
    </tbody></table></div>`;
    return t + cmd;
  }

  /** 3 件以上: 日時順の推移（平均絶対誤差と成功率） */
  trendHtml(d) {
    const pts = d.recs.map((x) => ({ x, s: d.summary.find((y) => y.id === x.rec.id) }));
    const chart = (title, val, fmt, lowerBetter) => {
      const bw = this.R.body.clientWidth || 640, W = Math.max(300, Math.round(bw >= 660 ? (bw - 8) / 2 : bw)), H = 150, L = 46, Rm = 14, T = 22, B = 30;
      const vs = pts.map((p) => val(p.s)).filter((v) => v != null);
      if (!vs.length) return `<p class="hint">${title}: データなし</p>`;
      let lo = Math.min(...vs), hi = Math.max(...vs); if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      const X = (k) => L + (pts.length === 1 ? 0 : (k / (pts.length - 1)) * (W - L - Rm));
      const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
      let g = `<svg class="res-graph cmp-trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}の推移"><text x="${L}" y="14" class="axis-l" text-anchor="start">${title}（${lowerBetter ? '低いほど良い' : '高いほど良い'}）</text>`;
      g += `<line x1="${L}" x2="${W - Rm}" y1="${H - B}" y2="${H - B}" class="tick"/><text x="${L - 4}" y="${Y(hi) + 4}" text-anchor="end">${fmt(hi)}</text><text x="${L - 4}" y="${Y(lo) + 4}" text-anchor="end">${fmt(lo)}</text>`;
      const line = pts.map((p, k) => (val(p.s) == null ? null : [X(k), Y(val(p.s))])).filter(Boolean);
      g += `<polyline points="${line.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#cbb9a3" stroke-width="1.5"/>`;
      pts.forEach((p, k) => {
        const v = val(p.s);
        g += `<text x="${X(k)}" y="${H - 10}" class="tick-l">${p.x.sym}</text>`;
        if (v == null) { g += `<text x="${X(k)}" y="${H - B - 4}" class="tick-l">データなし</text>`; return; }
        g += `<circle cx="${X(k)}" cy="${Y(v)}" r="5" fill="${p.x.color}"><title>${p.x.sym} ${when(p.x.rec.at)} ${fmt(v)}</title></circle>`;
      });
      return `${g}</svg>`;
    };
    return `<div class="cmp-trends"><h3 class="res-h3">日時順の推移（${d.recs.length} 件）</h3><div class="cmp-trend-row">${chart('平均絶対誤差', (s) => s.mae, (v) => `${v.toFixed(0)}ms`, true)}${chart('成功率', (s) => (s.successRate == null ? null : s.successRate * 100), (v) => `${v.toFixed(0)}%`, false)}</div></div>`;
  }

  tlLegendHtml() {
    const icon = (inner, w = 26) => `<svg class="res-graph res-legend-icon" viewBox="0 0 ${w} 16" width="${w}" height="16" aria-hidden="true">${inner}</svg>`;
    const item = (svg, text) => `<li>${svg}<span>${text}</span></li>`;
    return `<ul class="res-legend" aria-label="全編の照合の凡例">${[
      item(icon('<rect x="10" y="2" width="6" height="12" fill="#ffc531"/>'), '上段: 正解（息・構・撃・旋）と息の保持区間'),
      ...Object.entries(VIS.grades).map(([k, v]) => item(icon(`<g class="${v.cls} cur">${markShape(k, 13, 8)}</g>`), `入力: ${v.mark} ${v.label}（入力した時刻の位置）`)),
      item(icon('<rect x="6" y="1" width="14" height="14" class="cmp-noin-box"/><path d="M9 4L17 12M17 4L9 12" class="cmp-noin-x"/>'), '入力なしの MISS（正解の時刻に表示。入力の位置ではない）'),
      item(icon(`<g class="g-extra">${markShape('EXTRA', 13, 8)}</g>`), '余分な入力・ボタン違い（判定に使っていない）'),
      item(icon('<rect x="2" y="5" width="22" height="6" class="tl-held"/><line x1="23" x2="23" y1="2" y2="14" class="tl-release"/>'), '息: 押していた区間と離した位置'),
      item(icon('<line x1="13" x2="13" y1="1" y2="15" class="cmp-na"/>'), '条件変更・対応なし（比較しない）'),
      item(icon('<rect x="1" y="2" width="24" height="12" rx="3" fill="#ffb34755" stroke="#ffb347"/>'), '左端の色と記号 = 記録（画面全体で共通）'),
    ].join('')}</ul>`;
  }

  /** 全編の照合（全行で同じ時間軸。横スクロール・拡大は全行で連動。左の記録名は固定） */
  renderTimeline(keepT = null) {
    const d = this.data, sc = this.R.body.querySelector('.cmp-scroll'), lab = this.R.body.querySelector('.cmp-labels');
    if (!d || !sc) return;
    const dur = this.duration(d);
    const fit = Math.max(1, (sc.clientWidth - CT.pad * 2) / dur);
    if (this.pps == null) this.pps = fit;
    const pps = this.pps;
    const centerT = keepT ?? (this._pps ? (sc.scrollLeft + sc.clientWidth / 2 - CT.pad) / this._pps : dur / 2);
    const W = Math.ceil(dur * pps + CT.pad * 2), X = (t) => CT.pad + t * pps;
    const rows = [];
    let y = CT.head;
    for (const b of BUTTONS) { rows.push({ kind: 'note', b, y, h: CT.noteH, label: `正解 ${CMD[b]}／${b}` }); y += CT.noteH; }
    y += CT.gap;
    for (const x of d.recs) { rows.push({ kind: 'rec', id: x.rec.id, x, y, h: CT.recH }); y += CT.recH; }
    const H = y + 4;
    const out = [], texts = [];
    for (const row of rows) out.push(`<rect x="0" y="${row.y}" width="${W}" height="${row.h}" class="${row.kind === 'note' ? 'tl-row tl-row-note' : 'tl-row tl-row-input'}"/>${row.kind === 'rec' ? `<rect x="0" y="${row.y}" width="${W}" height="3" fill="${row.x.color}" opacity="0.7"/>` : ''}`);
    for (const tk of timeTicks(0, dur, pps)) {
      const x = X(tk.t).toFixed(1);
      out.push(`<line x1="${x}" x2="${x}" y1="${tk.whole ? 0 : CT.head - 4}" y2="${H}" class="${tk.whole ? 'tl-tick1' : 'tl-tick02'}"/>`);
      if (tk.label) out.push(`<text x="${(+x + 2).toFixed(1)}" y="12" class="tl-sec">${tk.label}</text>`);
    }
    const sel = this.selNote;
    const occ = new Map();
    const free = (k, a, b) => (occ.get(k) || []).every(([x0, x1]) => b < x0 - 2 || a > x1 + 2);
    const take = (k, a, b) => { const l = occ.get(k) || []; l.push([a, b]); occ.set(k, l); };
    const labels = pps >= 100; // 拡大したときだけ ms の文字（重ならない位置に）
    for (const row of d.rows) {
      const n = row.note;
      if (!this.cmdFilter.has(n.button)) continue;
      const st = LANE_STYLE[n.button], nr = rows.find((r) => r.kind === 'note' && r.b === n.button), x = X(n.time);
      const g = [];
      const xs = [x];
      for (const c of row.cells) if (c.status === 'ok' && c.obs.input) xs.push(X(c.obs.input.time));
      const hx0 = Math.min(...xs) - 9, hx1 = Math.max(...xs) + 9;
      g.push(`<rect x="${hx0}" y="${CT.head}" width="${hx1 - hx0}" height="${H - CT.head}" class="tl-hit"/>`);
      if (n.id === sel) g.push(`<rect x="${hx0}" y="${CT.head - 2}" width="${hx1 - hx0}" height="${H - CT.head}" class="tl-selband"/>`);
      if (n.hold) { const xe = X(n.time + n.hold.duration); g.push(`<rect x="${x}" y="${nr.y + nr.h / 2 - 4}" width="${Math.max(1, xe - x)}" height="8" fill="${st.color}" fill-opacity="0.45"/><rect x="${xe - 2}" y="${nr.y + 3}" width="2" height="${nr.h - 6}" fill="${st.color}"/>`); }
      g.push(`<rect x="${x - 3}" y="${nr.y + 3}" width="6" height="${nr.h - 6}" rx="2" fill="${st.color}" class="tl-nmark"/>`);
      for (const c of row.cells) {
        const rr = rows.find((r) => r.kind === 'rec' && r.id === c.id), cy = rr.y + rr.h / 2 + 4;
        g.push(`<line x1="${x}" x2="${x}" y1="${rr.y + 4}" y2="${rr.y + rr.h - 2}" class="tl-target"/>`);
        if (c.status !== 'ok') { g.push(`<line x1="${x}" x2="${x}" y1="${rr.y + 6}" y2="${rr.y + rr.h - 4}" class="cmp-na"><title>${esc(c.why)}</title></line>`); continue; }
        const o = c.obs;
        if (o.input) {
          const ix = X(o.input.time);
          if (o.hold && o.input) {
            const rec = this.history.get(c.id), rn = rec.notes.find((q) => q.id === n.id);
            const endT = rn.hold?.releasedAt ?? rn.hold?.completedAt ?? rn.hold?.end;
            if (endT != null) g.push(`<rect x="${ix}" y="${cy - 3}" width="${Math.max(1, X(endT) - ix)}" height="6" class="tl-held${rn.hold?.status === 'early-release' ? ' early' : ''}"/>`);
            if (rn.hold?.releasedAt != null) g.push(`<line x1="${X(rn.hold.releasedAt)}" x2="${X(rn.hold.releasedAt)}" y1="${cy - 8}" y2="${cy + 8}" class="tl-release"/>`);
          }
          if (Math.abs(ix - x) > 1.5) g.push(`<line x1="${x}" x2="${ix}" y1="${cy}" y2="${cy}" class="tl-dist"/>`);
          g.push(`<g class="${GC[o.result] || 'g-miss'} cur">${markShape(o.result, ix, cy, 0.95)}</g>`);
          if (labels) {
            const txt = sMs(o.d), w = this.R.textW(txt, 11) + 2, side = o.d < 0 ? ix - 8 - w : ix + 8;
            if (free(c.id, side, side + w) && side > 1) { take(c.id, side, side + w); texts.push(`<text x="${side.toFixed(1)}" y="${rr.y + 14}" class="tl-t ${GC[o.result] || ''}">${txt}</text>`); }
          }
        } else if (o.noInput) {
          g.push(`<rect x="${x - 6}" y="${cy - 6}" width="12" height="12" class="cmp-noin-box"/><path d="M${x - 4} ${cy - 4}L${x + 4} ${cy + 4}M${x + 4} ${cy - 4}L${x - 4} ${cy + 4}" class="cmp-noin-x"/>`);
          if (labels) { const w = this.R.textW('入力なし', 11) + 2; if (free(c.id, x + 9, x + 9 + w)) { take(c.id, x + 9, x + 9 + w); texts.push(`<text x="${x + 9}" y="${rr.y + 14}" class="tl-t tl-t-miss">入力なし</text>`); } }
        }
      }
      out.push(`<g class="tl-item${n.id === sel ? ' is-sel' : ''}" data-cnote="${esc(n.id)}"><title>${esc(`${n.id} ${CMD[n.button]} ${t3(n.time)} 秒`)}</title>${g.join('')}</g>`);
    }
    // 余分な入力（判定に使っていない）: 記録の行の下寄り
    for (const x of d.recs) {
      const rr = rows.find((r) => r.kind === 'rec' && r.id === x.rec.id);
      for (const e of x.rec.extras || []) if (this.cmdFilter.has(e.button)) out.push(`<g class="g-extra"><title>${esc(`余分な入力 ${t3(e.time)} 秒 ${CMD[e.button]}／${e.button}（判定に使っていない）`)}</title>${markShape('EXTRA', X(e.time), rr.y + rr.h - 7, 0.8)}</g>`);
    }
    sc.innerHTML = `<svg class="res-graph tl-svg" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="正解と各記録の入力の照合（${dur.toFixed(1)} 秒）">${out.join('')}${texts.join('')}</svg>`;
    lab.innerHTML = `<svg class="res-graph tl-svg" width="${CT.labW}" height="${H}" style="width:${CT.labW}px;height:${H}px" aria-hidden="true">${rows.map((row) => row.kind === 'note'
      ? `<rect x="0" y="${row.y}" width="${CT.labW}" height="${row.h}" class="tl-row tl-row-note"/><text x="6" y="${row.y + row.h / 2 + 4}" class="tl-rs b-${row.b}">${row.label}</text>`
      : `<rect x="0" y="${row.y}" width="${CT.labW}" height="${row.h}" class="tl-row tl-row-input"/><rect x="0" y="${row.y}" width="5" height="${row.h}" fill="${row.x.color}"/><rect x="9" y="${row.y + 8}" width="20" height="20" rx="4" fill="${row.x.color}"/><text x="19" y="${row.y + 23}" class="cmp-sym" text-anchor="middle">${row.x.sym}</text><text x="34" y="${row.y + 17}" class="tl-rs">${esc(row.x.rec.mode === 'demo' ? (row.x.rec.demo?.label ?? '').replace('公式デモ：', 'デモ ') : when(row.x.rec.at))}</text><text x="34" y="${row.y + 31}" class="tl-rs">${row.x.rec.id === d.base.rec.id ? '基準・' : ''}${modeName(row.x.rec)}・${row.x.rec.mode === 'demo' ? 'シミュレーション' : KIND_LABEL[row.x.rec.kind]}</text>`).join('')}<text x="6" y="13" class="tl-sec">秒</text></svg>`;
    this._pps = pps;
    sc.scrollLeft = Math.max(0, X(centerT) - sc.clientWidth / 2);
    this.R.body.querySelector('.cmp-scale').textContent = `1 秒 = ${Math.round(pps)} px・全 ${dur.toFixed(1)} 秒・${d.recs.length} 件`;
    window.__cmpTl = { pps, pad: CT.pad, rows: rows.map((r) => ({ kind: r.kind, id: r.id, b: r.b, y: r.y, h: r.h })), dur, W };
  }

  zoom(z) {
    const sc = this.R.body.querySelector('.cmp-scroll');
    if (!sc || !this.data) return;
    const dur = this.duration(this.data), fit = Math.max(1, (sc.clientWidth - CT.pad * 2) / dur);
    const c = (sc.scrollLeft + sc.clientWidth / 2 - CT.pad) / (this._pps || 1);
    if (z === 'fit') this.pps = fit;
    else { const cur = this.pps; const next = z > 0 ? ZOOM.find((v) => v > cur * 1.01) : [...ZOOM].reverse().find((v) => v < cur * 0.99); this.pps = Math.max(fit, next ?? cur); }
    this.renderTimeline(z === 'fit' ? dur / 2 : c);
  }

  /** ノーツを選ぶ: 時間軸の中央に移し、全記録の結果と画像を一覧にする */
  selectNote(id, { scroll = true } = {}) {
    this.selNote = id;
    const row = this.data?.rows.find((r) => r.note.id === id);
    if (!row) return;
    if (!this.cmdFilter.has(row.note.button)) this.cmdFilter.add(row.note.button);
    const sc = this.R.body.querySelector('.cmp-scroll');
    const x = CT.pad + row.note.time * (this._pps || 1);
    const visible = sc && x > sc.scrollLeft + 30 && x < sc.scrollLeft + sc.clientWidth - 30;
    this.renderTimeline(visible ? null : row.note.time);
    this.renderDetail();
    for (const td of this.R.body.querySelectorAll('.cmx td[data-cnote]')) td.classList.toggle('is-sel', td.dataset.cnote === id);
    if (scroll) this.R.body.querySelector('.cmp-detail')?.scrollIntoView({ block: 'nearest' });
  }

  renderDetail() {
    const el = this.R.body.querySelector('.cmp-detail');
    if (!el || !this.data) return;
    const row = this.data.rows.find((r) => r.note.id === this.selNote);
    if (!row) { el.innerHTML = '<p class="hint">選択なし: 時間軸のノーツか、下の比較表のセルを押すと、そのノーツの全記録の結果と画像を表示します。</p>'; return; }
    const n = row.note, base = this.data.base.rec;
    const ft = n.frames?.target ?? this.R.frameAt(n.time);
    const fig = (label, t, f, w = 96) => `<figure class="nc-fig cmp-fig" style="width:${w}px"><canvas width="${w}" height="${Math.round(w * 4 / 3)}" data-frame="${f ? f.i : ''}" aria-label="${label}の主人公の画像"></canvas><figcaption><b>${label}</b> ${t3(t)} 秒<br><small>${f ? `コマ ${f.i}` : '画像なし'}</small></figcaption></figure>`;
    const ch = (c) => { const k = CHANGE[c.kind]; return `<span class="cmp-chg ${k.cls}">${k.mark} ${esc(c.kind === 'base' || c.kind === 'na' ? c.label : c.label)}</span>`; };
    const rows = row.cells.map((c) => {
      const rec = this.history.get(c.id), rn = rec.notes.find((q) => q.id === n.id);
      if (c.status !== 'ok') return `<tr><th>${this.badge(c.id)} ${esc(recName(rec))}</th><td colspan="${n.hold ? 8 : 7}">${esc(c.why)}</td></tr>`;
      const o = c.obs, fi = o.input ? (rn.frames?.input ?? this.R.frameAt(o.input.time)) : null;
      return `<tr><th>${this.badge(c.id)} ${esc(recName(rec))}${c.id === base.id ? ' <em class="cmp-basetag">基準</em>' : ''}</th>
        <td>${CMD[n.button]}／${n.button} ${t3(n.time)} 秒</td>
        <td>${o.input ? `${o.input.button} を ${t3(o.input.time)} 秒 <small>${DEVICE_LABEL[o.input.device] || o.input.device || ''}</small>` : '<b>入力なし</b>'}</td>
        <td>${o.d == null ? '—' : `${sMs(o.d)} ${o.d < 0 ? '早い' : o.d > 0 ? '遅い' : ''}`}</td><td>${aMs(o.abs)}</td>
        <td class="${GC[o.result] || ''}">${VIS.grades[o.result]?.mark || ''} ${o.result}</td>
        <td>${ch(c.change)}</td>
        ${n.hold ? `<td>${o.hold?.ok == null ? '記録なし' : o.hold.ok ? '保持して成功' : o.hold.status === 'early-release' ? '早離し' : '失敗'}${o.hold?.heldSec != null ? `（保持 ${o.hold.heldSec.toFixed(2)} 秒）` : ''}<br>${ch(c.holdChange)}</td>` : ''}
        <td>${o.input ? fig('入力時', o.input.time, fi, 66) : '<small>入力なし（画像なし）</small>'}</td></tr>`;
    }).join('');
    el.innerHTML = `<div class="cmp-dhead">${fig('正解時', n.time, ft, 110)}<div><b>選択: ${esc(n.id)}</b>（${this.data.rows.indexOf(row) + 1}／${this.data.rows.length}）<br>
      正解 <b class="nc-cmd" data-b="${n.button}">${CMD[n.button]}／${n.button}</b> ${t3(n.time)} 秒${n.hold ? `〜${t3(n.time + n.hold.duration)} 秒（息: 押し始めの精度と、保持・解除を分けて比較）` : ''}<br>
      <small>改善量 = 基準の絶対誤差 − 比較する記録の絶対誤差（早押し・遅押しを相殺しない）。入力がない記録とは ms の改善量を計算せず、判定の変化で示します。</small></div></div>
      <div class="res-scroll"><table class="res-table cmp-dt"><thead><tr><th>記録</th><th>正解</th><th>入力</th><th>ずれ（符号付き）</th><th>絶対誤差</th><th>判定</th><th>基準からの変化（${n.hold ? '押し始め' : '改善量'}）</th>${n.hold ? '<th>保持・解除</th>' : ''}<th>入力時の画像</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    el.querySelectorAll('canvas[data-frame]').forEach((cv) => this.R.drawFrame(cv, Number(cv.dataset.frame)));
  }

  matrixHtml(d) {
    const rows = d.rows.filter((r) => this.cmdFilter.has(r.note.button) && (this.rowFilter === 'all' || (this.rowFilter === 'up' && r.improved) || (this.rowFilter === 'down' && r.worsened) || (this.rowFilter === 'miss' && r.hasMiss)));
    const legend = `<ul class="res-legend" aria-label="比較表の凡例">${Object.values(CHANGE).map((k) => `<li><span class="cmp-chg ${k.cls}">${k.mark} ${k.text}</span></li>`).join('')}<li><span>セル: 判定と早い／遅い（符号付き ms）。改善量は基準の絶対誤差 − その記録の絶対誤差</span></li></ul>`;
    const filters = `<div class="res-filter" role="group" aria-label="技で絞り込み">${BUTTONS.map((b) => `<button type="button" data-ccmd="${b}" aria-pressed="${this.cmdFilter.has(b)}">${CMD[b]}</button>`).join('')}</div>
      <div class="res-filter" role="group" aria-label="ノーツの絞り込み">${[['all', 'すべて'], ['up', '▲ 改善したノーツ'], ['down', '▼ 悪化したノーツ'], ['miss', '✕ MISS を含むノーツ']].map(([k, l]) => `<button type="button" data-crow="${k}" aria-pressed="${this.rowFilter === k}">${l}（${d.rows.filter((r) => this.cmdFilter.has(r.note.button) && (k === 'all' || (k === 'up' && r.improved) || (k === 'down' && r.worsened) || (k === 'miss' && r.hasMiss))).length}）</button>`).join('')}</div>`;
    const head = `<tr><th class="cmx-t">時刻</th><th class="cmx-c">コマンド</th><th class="cmx-i">ID</th>${d.recs.map((x) => `<th>${this.badge(x.rec.id)}<br><small>${esc(recName(x.rec))}</small></th>`).join('')}</tr>`;
    const body = rows.map((r) => `<tr><th class="cmx-t">${t3(r.note.time)}</th><th class="cmx-c"><b class="nc-cmd" data-b="${r.note.button}">${CMD[r.note.button]}</b>${r.note.hold ? '<small> 長押し</small>' : ''}</th><th class="cmx-i">${esc(r.note.id)}</th>${r.cells.map((c) => {
      const k = CHANGE[c.change.kind], o = c.obs;
      const main = c.status !== 'ok' ? `<span class="cmx-na">${c.status === 'changed' ? '条件変更' : '対応なし'}</span>` : `<span class="${GC[o.result] || ''}">${VIS.grades[o.result]?.mark || ''} ${o.noInput ? '入力なし' : `${o.result} ${sMs(o.d)}`}</span>`;
      return `<td class="${k.cls}${r.note.id === this.selNote ? ' is-sel' : ''}" data-cnote="${esc(r.note.id)}" data-crec="${esc(c.id)}" tabindex="0" title="${esc(c.change.label)}">${main}<small>${k.mark} ${esc(c.change.kind === 'up' || c.change.kind === 'down' ? c.change.label : k.text)}</small>${c.holdChange && c.status === 'ok' && c.holdChange.kind !== 'base' ? `<small>保持: ${esc(c.holdChange.label)}</small>` : ''}</td>`;
    }).join('')}</tr>`).join('');
    return `${filters}${legend}<div class="res-scroll cmx-wrap" tabindex="0" aria-label="ノーツ別の比較表（横・縦にスクロール）"><table class="res-table cmx"><thead>${head}</thead><tbody>${body || `<tr><td colspan="${3 + d.recs.length}">該当するノーツはありません</td></tr>`}</tbody></table></div>`;
  }

  // ================= 期間平均の比較 =================
  /** 集計条件の候補（同じ譜面・判定幅・速度・入力補正のまとまり）。手動の通しプレイの件数つき */
  condGroups() {
    const m = new Map();
    for (const r of dedupe(this.history.records).records) {
      const k = condKey(r), g = m.get(k) || { key: k, rec: r, n: 0 };
      g.n += r.mode === 'manual' && r.kind === 'full' ? 1 : 0;
      if (r.at > g.rec.at) g.rec = r;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || (a.rec.at < b.rec.at ? 1 : -1));
  }

  periodHtml() {
    const P = this.period;
    const groups = this.condGroups();
    if (!groups.length) { this.pdata = null; return '<p class="hint">履歴がありません。</p>'; }
    if (!P.cond || !groups.some((g) => g.key === P.cond)) {
      const cur = this.R.rec && groups.find((g) => g.key === condKey(this.R.rec));
      P.cond = (cur || groups[0]).key;
    }
    const ref = groups.find((g) => g.key === P.cond).rec;
    const res = this.pdata = comparePeriods(this.history.records, { A: P.A, B: P.B, ref, includeAuto: P.includeAuto, includePractice: P.includePractice, includeAborted: P.includeAborted, mixCharts: P.mixCharts });
    this.pref = ref;
    const form = `<div class="per-form">
      <label>期間の選択 <select data-pset>${PERIOD_PRESETS.map(([k, l]) => `<option value="${k}" ${P.preset === k ? 'selected' : ''}>${l}</option>`).join('')}<option value="custom" ${P.preset === 'custom' ? 'selected' : ''}>日付を指定</option></select></label>
      <fieldset class="per-range"><legend>期間 A（基準）</legend><input type="date" data-pdate="A0" value="${P.A[0]}" aria-label="期間 A の開始日"> 〜 <input type="date" data-pdate="A1" value="${P.A[1]}" aria-label="期間 A の終了日"></fieldset>
      <fieldset class="per-range"><legend>期間 B（比較）</legend><input type="date" data-pdate="B0" value="${P.B[0]}" aria-label="期間 B の開始日"> 〜 <input type="date" data-pdate="B1" value="${P.B[1]}" aria-label="期間 B の終了日"></fieldset>
      <label class="per-cond">集計条件 <select data-pcond>${groups.map((g) => `<option value="${esc(g.key)}" ${g.key === P.cond ? 'selected' : ''}>${esc(condLabel(g.rec))}（手動・通し ${g.n} 件）</option>`).join('')}</select></label>
      <div class="per-inc"><label><input type="checkbox" data-pinc="includeAuto" ${P.includeAuto ? 'checked' : ''}> AUTO を含める</label><label><input type="checkbox" data-pinc="includePractice" ${P.includePractice ? 'checked' : ''}> 練習を含める</label>
        <label><input type="checkbox" data-pinc="includeAborted" ${P.includeAborted ? 'checked' : ''}> 途中終了を含める</label><label><input type="checkbox" data-pinc="mixCharts" ${P.mixCharts ? 'checked' : ''}> 譜面が違う記録もノーツ単位で照合して含める</label></div>
      <p class="hint">日付は端末の現地時間で、終了日当日を含みます（開始日 0 時〜終了日の翌日 0 時の前まで）。週は月曜はじまり。</p></div>`;
    if (res.error) return `${form}<p class="res-warn">${esc(res.error)}</p>`;
    const notes = [];
    notes.push(`集計条件: ${esc(condLabel(ref))}。${P.includeAuto || P.includePractice || P.includeAborted ? `含める: ${[P.includeAuto && 'AUTO', P.includePractice && '練習', P.includeAborted && '途中終了'].filter(Boolean).join('・')}` : '手動の通しプレイのみ（AUTO・練習・途中終了は除外）'}`);
    const ex = Object.entries(res.excludedRecords);
    if (ex.length) notes.push(`期間内で集計から除いた記録: ${ex.map(([k, v]) => `${k} ${v} 件`).join('、')}`);
    if (res.duplicates.length) notes.push(`重複した記録（同じプレイの取り込みなど）${res.duplicates.length} 件は 1 回だけ数えました`);
    if (res.excludedNotes.length) notes.push(`条件が変わったノーツは除外: ${res.excludedNotes.slice(0, 6).map((x) => `${esc(x.note)} ${esc(x.reason)}（${x.records} 件）`).join('、')}${res.excludedNotes.length > 6 ? ` ほか ${res.excludedNotes.length - 6}` : ''}`);
    const warn = [];
    if (res.overlap.length) warn.push(`期間 A と B が重なっています。同じ記録 ${res.overlap.length} 件が両方の期間に含まれています。`);
    if (!res.A.plays || !res.B.plays) warn.push(`データなし: ${!res.A.plays ? '期間 A' : ''}${!res.A.plays && !res.B.plays ? '・' : ''}${!res.B.plays ? '期間 B' : ''} に対象のプレイがありません（0 として扱いません）。`);
    if (Math.min(res.A.plays, res.B.plays) > 0 && Math.min(res.A.plays, res.B.plays) < 5) warn.push('対象のプレイが少ないため、差は偶然の範囲かもしれません。');
    return `${form}
      <div class="per-counts"><div><b>期間 A</b> ${res.periods.A.from}〜${res.periods.A.to}<br>プレイ ${res.A.plays} 件・ノーツ ${res.all.a.n} 件・誤差の対象 ${res.all.a.timed} 件・MISS ${res.all.a.miss} 件</div>
        <div><b>期間 B</b> ${res.periods.B.from}〜${res.periods.B.to}<br>プレイ ${res.B.plays} 件・ノーツ ${res.all.b.n} 件・誤差の対象 ${res.all.b.timed} 件・MISS ${res.all.b.miss} 件</div></div>
      ${warn.map((w) => `<p class="res-warn" role="note">${w}</p>`).join('')}
      <ul class="hint per-notes">${notes.map((x) => `<li>${x}</li>`).join('')}
        <li>集計方法: 期間内の対象プレイのノーツをすべて合算（記録ごとの平均の平均にしない）。入力なし・ボタン違いは誤差 0ms とせず誤差の集計から除き、MISS に数えます。改善量 = A − B（プラスが改善）、改善率 = 改善量 ÷ A。統計的な有意性は判定していません。</li></ul>
      <div class="per-act"><button type="button" class="tbtn" data-pexp="json">比較結果を JSON で書き出す</button><button type="button" class="tbtn" data-pexp="csv">比較結果を CSV で書き出す</button></div>
      ${this.periodOverallHtml(res)}
      ${this.periodCmdHtml(res)}
      <h3 class="res-h3">ノーツ別（0 秒〜${(ref.chart.duration || 82).toFixed(1)} 秒の共通の時間軸）</h3>
      ${this.periodLegendHtml()}
      <div class="tl-tools"><span class="tl-zoom" role="group" aria-label="拡大・縮小"><button type="button" data-pzoom="-1" aria-label="縮小">－</button><button type="button" data-pzoom="1" aria-label="拡大">＋</button><button type="button" data-pzoom="fit">全体</button></span><span class="tl-scale per-scale"></span></div>
      <div class="tl-wrap per-wrap"><div class="tl-labels per-labels"></div><div class="tl-scroll per-scroll" tabindex="0" aria-label="ノーツ別の期間平均誤差（横にスクロール）"></div></div>
      <div class="per-sel" aria-live="polite"></div>
      ${this.periodTableHtml(res)}
      ${this.periodPlaysHtml(res)}`;
  }

  periodOverallHtml(res) {
    const a = res.all.a, b = res.all.b, D = res.all;
    const has = a.n > 0 && b.n > 0;
    const mae = !has || D.maeImprove == null ? 'データなし'
      : `${D.maeImprove > 0 ? `${D.maeImprove.toFixed(1)}ms 改善` : D.maeImprove < 0 ? `${Math.abs(D.maeImprove).toFixed(1)}ms 悪化` : '変化なし'}・誤差 ${D.maeImprovePct == null ? '—' : `${Math.abs(D.maeImprovePct).toFixed(1)}%${D.maeImprovePct >= 0 ? '減少' : '増加'}`}`;
    const both = has && D.maeImprove > 0 && D.missPt > 0 ? '<p class="res-warn" role="note">誤差は小さくなりましたが、MISS 率は増えています（両方の変化を確認してください）。</p>' : '';
    const v = (x, f) => (x && x.n ? f(x) : 'データなし');
    const tbl = `<div class="res-scroll"><table class="res-table per-tbl"><caption>全体の比較（期間 A → 期間 B）</caption><thead><tr><th>項目</th><th>期間 A</th><th>期間 B</th><th>変化</th></tr></thead><tbody>
      <tr><th>平均絶対誤差（ずれの大きさ）</th><td>${v(a, (x) => `${aMs(x.mae)}（${x.timed} 件）`)}</td><td>${v(b, (x) => `${aMs(x.mae)}（${x.timed} 件）`)}</td><td class="${has ? `k-${D.status}` : 'k-na'}">${mae}</td></tr>
      <tr><th>平均符号付き誤差（早押し／遅押しの傾向）</th><td>${v(a, (x) => sMs(x.mean))}</td><td>${v(b, (x) => sMs(x.mean))}</td><td>${D.meanShift == null ? 'データなし' : `${sMs(D.meanShift)}（${D.meanShift < 0 ? '早い側へ' : D.meanShift > 0 ? '遅い側へ' : '変化なし'}）`}</td></tr>
      <tr><th>入力誤差のばらつき（標準偏差）</th><td>${v(a, (x) => aMs(x.sd))}</td><td>${v(b, (x) => aMs(x.sd))}</td><td>${D.sdImprove == null ? 'データなし' : fmtImp(D.sdImprove)}</td></tr>
      <tr><th>成功率</th><td>${v(a, (x) => `${pct(x.successRate)}（${x.perfect + x.good}/${x.n}）`)}</td><td>${v(b, (x) => `${pct(x.successRate)}（${x.perfect + x.good}/${x.n}）`)}</td><td>${ptText(D.successPt)}</td></tr>
      <tr><th>PERFECT 率</th><td>${v(a, (x) => `${pct(x.perfectRate)}（${x.perfect}）`)}</td><td>${v(b, (x) => `${pct(x.perfectRate)}（${x.perfect}）`)}</td><td>${ptText(D.perfectPt)}</td></tr>
      <tr><th>MISS 率</th><td>${v(a, (x) => `${pct(x.missRate)}（${x.miss} 件・入力なし ${x.missNoInput}）`)}</td><td>${v(b, (x) => `${pct(x.missRate)}（${x.miss} 件・入力なし ${x.missNoInput}）`)}</td><td>${missText(D.missPt)}</td></tr>
      <tr><th>息の保持・解除の成功率</th><td>${v(a, (x) => (x.holdN ? `${pct(x.holdRate)}（${x.holdOk}/${x.holdN}）` : '記録なし'))}</td><td>${v(b, (x) => (x.holdN ? `${pct(x.holdRate)}（${x.holdOk}/${x.holdN}）` : '記録なし'))}</td><td>${ptText(D.holdPt)}</td></tr>
      <tr><th>平均スコア</th><td>${res.score.a == null ? 'データなし' : `${res.score.a.toLocaleString()}（${res.A.plays} プレイ）`}</td><td>${res.score.b == null ? 'データなし' : `${res.score.b.toLocaleString()}（${res.B.plays} プレイ）`}</td><td>${res.score.diff == null ? 'データなし' : `${res.score.diff >= 0 ? '+' : '−'}${Math.abs(res.score.diff).toLocaleString()} 点`}</td></tr>
    </tbody></table></div>`;
    // 期間 A・B の平均値を並べたグラフ（ms と %）
    // 2 つのグラフを横に並べるときは列の幅で描く（等倍。縮めて文字が小さくならないように）
    const bw = this.R.body.clientWidth || 640, W = Math.max(300, Math.round(bw >= 660 ? (bw - 8) / 2 : bw)), L = 110, Rm = 90, rowH = 26;
    const bars = (title, items, max, unit) => {
      const H = 24 + items.length * rowH * 2 + 8;
      const X = (val) => L + (val / (max || 1)) * (W - L - Rm);
      let g = `<svg class="res-graph per-bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}"><text x="8" y="16" class="axis-l" text-anchor="start">${title}</text>`;
      items.forEach((it, k) => {
        const y = 24 + k * rowH * 2;
        g += `<text x="8" y="${y + rowH}" class="row-l">${it.label}</text>`;
        [['A', it.a, 'per-a'], ['B', it.b, 'per-b']].forEach(([p, val], j) => {
          const yy = y + j * rowH + 4;
          if (val == null) { g += `<text x="${L}" y="${yy + 14}" text-anchor="start">${p}: データなし</text>`; return; }
          g += `<rect x="${L}" y="${yy}" width="${Math.max(1, X(val) - L)}" height="${rowH - 8}" class="${j ? 'per-b' : 'per-a'}"/><text x="${X(val) + 4}" y="${yy + 13}" text-anchor="start">${p} ${val.toFixed(1)}${unit}</text>`;
        });
      });
      return `${g}</svg>`;
    };
    const ms = [{ label: '平均絶対誤差', a: a.n ? a.mae : null, b: b.n ? b.mae : null }, { label: 'ばらつき', a: a.n ? a.sd : null, b: b.n ? b.sd : null }];
    const rt = [{ label: '成功率', a: a.n ? a.successRate * 100 : null, b: b.n ? b.successRate * 100 : null }, { label: 'PERFECT 率', a: a.n ? a.perfectRate * 100 : null, b: b.n ? b.perfectRate * 100 : null }, { label: 'MISS 率', a: a.n ? a.missRate * 100 : null, b: b.n ? b.missRate * 100 : null }];
    const maxMs = Math.max(1, ...ms.flatMap((x) => [x.a, x.b]).filter((x) => x != null));
    return `<h3 class="res-h3">全体（期間 A・B の平均）</h3><p class="per-big ${has ? `k-${D.status}` : 'k-na'}">平均絶対誤差: ${mae}</p>${both}
      <ul class="res-legend"><li><svg class="res-graph res-legend-icon" viewBox="0 0 22 16" width="22" height="16"><rect x="1" y="3" width="20" height="10" class="per-a"/></svg><span>期間 A（基準・白抜き）</span></li><li><svg class="res-graph res-legend-icon" viewBox="0 0 22 16" width="22" height="16"><rect x="1" y="3" width="20" height="10" class="per-b"/></svg><span>期間 B（比較・塗りつぶし）</span></li></ul>
      <div class="per-chart-row">${bars('誤差（ms。短いほど良い）', ms, maxMs * 1.1, 'ms')}${bars('率（%）', rt, 100, '%')}</div>${tbl}`;
  }

  periodCmdHtml(res) {
    return `<div class="res-scroll"><table class="res-table per-tbl"><caption>技ごと（息・構・撃・旋）</caption><thead><tr><th>技</th><th>A 平均絶対誤差</th><th>B 平均絶対誤差</th><th>改善量</th><th>A 成功率</th><th>B 成功率</th><th>成功率の変化</th><th>件数（誤差の対象・MISS・ノーツ）</th></tr></thead><tbody>
      ${BUTTONS.map((b) => { const d = res.byCmd[b]; return `<tr><th><b class="nc-cmd" data-b="${b}">${CMD[b]}／${b}</b></th>
        <td>${d.a.n ? aMs(d.a.mae) : 'データなし'}</td><td>${d.b.n ? aMs(d.b.mae) : 'データなし'}</td>
        <td class="k-${d.status}">${CHANGE[d.status].mark} ${d.maeImprove == null ? '比較不能' : `${fmtImp(d.maeImprove)}${d.maeImprovePct != null ? `（${Math.abs(d.maeImprovePct).toFixed(1)}%${d.maeImprovePct >= 0 ? '減少' : '増加'}）` : ''}`}</td>
        <td>${d.a.n ? pct(d.a.successRate) : 'データなし'}</td><td>${d.b.n ? pct(d.b.successRate) : 'データなし'}</td><td>${ptText(d.successPt)}</td>
        <td>A ${d.a.timed}・${d.a.miss}・${d.a.n} ／ B ${d.b.timed}・${d.b.miss}・${d.b.n}</td></tr>`; }).join('')}
      </tbody></table></div>`;
  }

  periodLegendHtml() {
    const icon = (inner, w = 26) => `<svg class="res-graph res-legend-icon" viewBox="0 0 ${w} 16" width="${w}" height="16" aria-hidden="true">${inner}</svg>`;
    const item = (svg, text) => `<li>${svg}<span>${text}</span></li>`;
    return `<ul class="res-legend" aria-label="ノーツ別の凡例">${[
      item(icon('<circle cx="13" cy="8" r="5" class="per-pa"/>'), '期間 A の平均絶対誤差（白抜き）'),
      item(icon('<circle cx="13" cy="8" r="5" class="per-pb"/>'), '期間 B の平均絶対誤差（塗りつぶし。上ほど誤差が大きい）'),
      item(icon('<path d="M13 2L20 13H6Z" class="per-up"/>'), '▲ 改善（緑）'), item(icon('<path d="M13 14L20 3H6Z" class="per-down"/>'), '▼ 悪化（赤）'),
      item(icon('<rect x="8" y="5" width="10" height="6" class="per-same"/>'), '＝ 変化なし（灰）'), item(icon('<text x="13" y="12" text-anchor="middle" class="per-nat">?</text>'), '？ 比較不能・データなし（0 として描かない）'),
    ].join('')}</ul>`;
  }

  renderPeriodTimeline(keepT = null) {
    const res = this.pdata, sc = this.R.body.querySelector('.per-scroll'), lab = this.R.body.querySelector('.per-labels');
    if (!res || !sc) return;
    const dur = this.pref.chart.duration || Math.ceil(Math.max(...res.notes.map((n) => n.time)) + 2);
    const fit = Math.max(1, (sc.clientWidth - CT.pad * 2) / dur);
    if (this.ppps == null) this.ppps = fit;
    const pps = this.ppps, X = (t) => CT.pad + t * pps;
    const centerT = keepT ?? (this._ppps ? (sc.scrollLeft + sc.clientWidth / 2 - CT.pad) / this._ppps : dur / 2);
    const W = Math.ceil(dur * pps + CT.pad * 2), top = CT.head + 18, plotH = 150, stY = top + plotH + 8, H = stY + 26;
    const vals = res.notes.flatMap((n) => [n.a?.n ? n.a.mae : null, n.b?.n ? n.b.mae : null]).filter((v) => v != null);
    const max = Math.max(60, ...vals) * 1.1;
    const Y = (v) => top + plotH - (v / max) * plotH;
    const out = [`<rect x="0" y="${top}" width="${W}" height="${plotH}" class="tl-row tl-row-note"/><rect x="0" y="${stY}" width="${W}" height="22" class="tl-row tl-row-input"/>`];
    for (const tk of timeTicks(0, dur, pps)) { const x = X(tk.t).toFixed(1); out.push(`<line x1="${x}" x2="${x}" y1="${tk.whole ? 0 : CT.head - 4}" y2="${H}" class="${tk.whole ? 'tl-tick1' : 'tl-tick02'}"/>`); if (tk.label) out.push(`<text x="${(+x + 2).toFixed(1)}" y="12" class="tl-sec">${tk.label}</text>`); }
    for (const v of [0, max / 2]) out.push(`<line x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" class="rowsep"/>`);
    for (const n of res.notes) {
      const x = X(n.time), st = LANE_STYLE[n.button], k = n.status;
      const g = [`<rect x="${x - 7}" y="${CT.head}" width="14" height="${H - CT.head}" class="tl-hit"/>`];
      if (n.id === this.period.sel) g.push(`<rect x="${x - 8}" y="${CT.head}" width="16" height="${H - CT.head}" class="tl-selband"/>`);
      g.push(`<rect x="${x - 2}" y="${CT.head + 2}" width="4" height="14" rx="1" fill="${st.color}"/>`);
      const ya = n.a?.n && n.a.mae != null ? Y(n.a.mae) : null, yb = n.b?.n && n.b.mae != null ? Y(n.b.mae) : null;
      if (ya != null && yb != null) g.push(`<line x1="${x}" x2="${x}" y1="${ya}" y2="${yb}" class="per-link k-${k}"/>`);
      if (ya != null) g.push(`<circle cx="${x}" cy="${ya}" r="4" class="per-pa"/>`);
      if (yb != null) g.push(`<circle cx="${x}" cy="${yb}" r="4" class="per-pb" style="fill:${st.color}"/>`);
      const sy = stY + 11;
      g.push(k === 'up' ? `<path d="M${x} ${sy - 7}L${x + 6} ${sy + 5}H${x - 6}Z" class="per-up"/>` : k === 'down' ? `<path d="M${x} ${sy + 7}L${x + 6} ${sy - 5}H${x - 6}Z" class="per-down"/>` : k === 'same' ? `<rect x="${x - 5}" y="${sy - 3}" width="10" height="6" class="per-same"/>` : `<text x="${x}" y="${sy + 4}" text-anchor="middle" class="per-nat">?</text>`);
      out.push(`<g class="tl-item" data-pnote="${esc(n.id)}"><title>${esc(`${n.id} ${CMD[n.button]} ${t3(n.time)} 秒 A ${n.a?.n ? aMs(n.a.mae) : 'データなし'} → B ${n.b?.n ? aMs(n.b.mae) : 'データなし'} ${CHANGE[k].text}`)}</title>${g.join('')}</g>`);
    }
    sc.innerHTML = `<svg class="res-graph tl-svg" width="${W}" height="${H}" style="width:${W}px;height:${H}px" viewBox="0 0 ${W} ${H}" role="img" aria-label="ノーツごとの期間平均誤差">${out.join('')}</svg>`;
    lab.innerHTML = `<svg class="res-graph tl-svg" width="${CT.labW}" height="${H}" style="width:${CT.labW}px;height:${H}px" aria-hidden="true"><text x="6" y="13" class="tl-sec">秒</text><text x="6" y="${CT.head + 14}" class="tl-rs">正解</text>
      <text x="6" y="${top + 14}" class="tl-rs">平均絶対誤差</text><text x="${CT.labW - 6}" y="${Y(max / 2) + 4}" class="tl-rs" text-anchor="end">${(max / 2).toFixed(0)}ms</text><text x="${CT.labW - 6}" y="${Y(0)}" class="tl-rs" text-anchor="end">0ms</text>
      <text x="6" y="${stY + 15}" class="tl-rs">改善・悪化</text></svg>`;
    this._ppps = pps;
    sc.scrollLeft = Math.max(0, X(centerT) - sc.clientWidth / 2);
    this.R.body.querySelector('.per-scale').textContent = `1 秒 = ${Math.round(pps)} px・全 ${dur.toFixed(1)} 秒`;
    window.__perTl = { pps, pad: CT.pad, top, plotH, max, dur };
  }

  pzoom(z) {
    const sc = this.R.body.querySelector('.per-scroll');
    if (!sc || !this.pdata) return;
    const dur = this.pref.chart.duration || 82, fit = Math.max(1, (sc.clientWidth - CT.pad * 2) / dur);
    const c = (sc.scrollLeft + sc.clientWidth / 2 - CT.pad) / (this._ppps || 1);
    if (z === 'fit') this.ppps = fit;
    else { const cur = this.ppps; const next = z > 0 ? ZOOM.find((v) => v > cur * 1.01) : [...ZOOM].reverse().find((v) => v < cur * 0.99); this.ppps = Math.max(fit, next ?? cur); }
    this.renderPeriodTimeline(z === 'fit' ? dur / 2 : c);
  }

  renderPeriodSel() {
    const el = this.R.body.querySelector('.per-sel');
    if (!el) return;
    const n = this.pdata?.notes.find((x) => x.id === this.period.sel);
    if (!n) { el.innerHTML = '<p class="hint">選択なし: ノーツを押すと、正解時刻の主人公の画像と、両期間の平均誤差・ばらつき・成功率・件数を表示します。</p>'; return; }
    const rn = this.pref.notes.find((x) => x.id === n.id);
    const f = rn?.frames?.target ?? this.R.frameAt(n.time);
    const col = (x, p) => (!x?.n ? `<td colspan="1">データなし</td>` : `<td>${aMs(x.mae)}（${x.timed} 件）<br>符号付き ${sMs(x.mean)}・ばらつき ${aMs(x.sd)}<br>成功率 ${pct(x.successRate)}（${x.perfect + x.good}/${x.n}）・MISS ${x.miss}${n.hold ? `<br>保持・解除の成功 ${x.holdN ? `${pct(x.holdRate)}（${x.holdOk}/${x.holdN}）` : '記録なし'}` : ''}</td>`);
    el.innerHTML = `<figure class="nc-fig cmp-fig" style="width:110px"><canvas width="110" height="147" data-frame="${f ? f.i : ''}" aria-label="正解時の主人公の画像"></canvas><figcaption><b>正解時</b> ${t3(n.time)} 秒<br><small>${f ? `コマ ${f.i}` : '画像なし'}</small></figcaption></figure>
      <div class="per-sel-txt"><b>選択: ${esc(n.id)}</b> <b class="nc-cmd" data-b="${n.button}">${CMD[n.button]}／${n.button}</b> ${t3(n.time)} 秒${n.hold ? '（息: 押し始めの精度と保持・解除を分けて表示）' : ''}
        <div class="res-scroll"><table class="res-table per-tbl"><thead><tr><th>期間 A</th><th>期間 B</th></tr></thead><tbody><tr>${col(n.a)}${col(n.b)}</tr></tbody></table></div>
        <p class="cmp-chg k-${n.status}">${CHANGE[n.status].mark} ${n.maeImprove == null ? '比較不能（どちらかの期間にデータなし）' : `${fmtImp(n.maeImprove)}${n.maeImprovePct != null ? `・誤差 ${Math.abs(n.maeImprovePct).toFixed(1)}%${n.maeImprovePct >= 0 ? '減少' : '増加'}` : ''}`}${n.successPt != null ? `・成功率 ${ptText(n.successPt)}` : ''}</p></div>`;
    el.querySelectorAll('canvas[data-frame]').forEach((cv) => this.R.drawFrame(cv, Number(cv.dataset.frame)));
  }

  periodTableHtml(res) {
    const order = this.period.sort;
    const list = res.notes.slice();
    const key = (n) => n.maeImprove;
    if (order === 'up') list.sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity) || a.time - b.time);
    else if (order === 'down') list.sort((a, b) => (key(a) ?? Infinity) - (key(b) ?? Infinity) || a.time - b.time);
    else list.sort((a, b) => a.time - b.time);
    return `<h3 class="res-h3">比較表（ノーツ別）</h3>
      <div class="res-filter" role="group" aria-label="並べ替え">${[['time', '時刻順'], ['up', '改善順'], ['down', '悪化順']].map(([k, l]) => `<button type="button" data-psort="${k}" aria-pressed="${order === k}">${l}</button>`).join('')}</div>
      <div class="res-scroll per-tblwrap"><table class="res-table per-notes-tbl"><thead><tr><th>ノーツ時刻</th><th>コマンド</th><th>期間 A の平均</th><th>期間 B の平均</th><th>改善量</th><th>件数（A ／ B）</th><th>成功率（A → B）</th></tr></thead><tbody>
      ${list.map((n) => `<tr data-pnote="${esc(n.id)}" class="${n.id === this.period.sel ? 'is-sel' : ''}"><td>${t3(n.time)} 秒 <small>${esc(n.id)}</small></td><td><b class="nc-cmd" data-b="${n.button}">${CMD[n.button]}／${n.button}</b>${n.hold ? '<small> 押し始め</small>' : ''}</td>
        <td>${n.a?.timed ? aMs(n.a.mae) : 'データなし'}</td><td>${n.b?.timed ? aMs(n.b.mae) : 'データなし'}</td>
        <td class="k-${n.status}">${CHANGE[n.status].mark} ${n.maeImprove == null ? '比較不能' : fmtImp(n.maeImprove)}</td>
        <td>誤差 ${n.a?.timed ?? 0}・MISS ${n.a?.miss ?? 0}・計 ${n.a?.n ?? 0} ／ 誤差 ${n.b?.timed ?? 0}・MISS ${n.b?.miss ?? 0}・計 ${n.b?.n ?? 0}</td>
        <td>${n.a?.n ? pct(n.a.successRate) : 'データなし'} → ${n.b?.n ? pct(n.b.successRate) : 'データなし'}${n.hold ? `<br><small>保持 ${n.a?.holdN ? pct(n.a.holdRate) : '—'} → ${n.b?.holdN ? pct(n.b.holdRate) : '—'}</small>` : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  periodPlaysHtml(res) {
    const li = (id) => { const r = this.history.get(id); return r ? `<li>${esc(when(r.at))} ${r.summary.score.toLocaleString()} 点 ${res.overlap.includes(id) ? '<em class="cmp-warn">両方の期間</em>' : ''} <button type="button" data-open="${esc(id)}">この記録を開く</button></li>` : ''; };
    return `<details class="per-plays"><summary>集計対象のプレイ（A ${res.A.plays} 件・B ${res.B.plays} 件）</summary>
      <div class="per-plays-cols"><div><b>期間 A</b><ul>${res.A.ids.map(li).join('') || '<li>データなし</li>'}</ul></div><div><b>期間 B</b><ul>${res.B.ids.map(li).join('') || '<li>データなし</li>'}</ul></div></div></details>`;
  }

  exportPeriod(kind) {
    const res = this.pdata;
    if (!res || res.error) return;
    const cond = condLabel(this.pref);
    const P = this.period;
    const stamp = this.R.stamp();
    if (kind === 'csv') { this.R.download(periodCsv(res, cond), `seipai-period-compare-${stamp}.csv`, 'text/csv'); return; }
    const out = { schema: 'kiva-period-compare/1', exportedAt: new Date().toISOString(), conditions: { text: cond, key: P.cond, includeAuto: P.includeAuto, includePractice: P.includePractice, includeAborted: P.includeAborted, mixCharts: P.mixCharts,
      method: '期間内の対象プレイのノーツを合算。入力なし・ボタン違いは誤差に入れず MISS に数える。改善量 = A − B（プラスが改善）、改善率 = 改善量 ÷ A（A = 0 なら null）。有意性は判定しない。' },
      periods: res.periods, plays: { A: res.A.ids, B: res.B.ids }, overlap: res.overlap, duplicates: res.duplicates, excludedRecords: res.excludedRecords, excludedNotes: res.excludedNotes,
      all: res.all, score: res.score, byCmd: res.byCmd, notes: res.notes };
    this.R.download(`${JSON.stringify(out, null, 2)}\n`, `seipai-period-compare-${stamp}.json`);
  }

  // ================= 操作 =================
  /** クリック（処理したら true） */
  onClick(e) {
    const t = e.target;
    const b = t.closest('button');
    const note = t.closest('[data-cnote]');
    if (note && !b && note.closest('.cmp-scroll, .cmx')) { this.selectNote(note.dataset.cnote); return true; }
    const pn = t.closest('[data-pnote]');
    if (pn && !b) { this.period.sel = pn.dataset.pnote; this.renderPeriodTimeline(); this.renderPeriodSel(); for (const tr of this.R.body.querySelectorAll('tr[data-pnote]')) tr.classList.toggle('is-sel', tr.dataset.pnote === this.period.sel); return true; }
    if (!b) return false;
    const ds = b.dataset;
    if (ds.cmode) { this.mode = ds.cmode; this.R.render(); return true; }
    if (ds.cact === 'apply') { this.setIds(this._pick ?? this.ids); this._pick = null; this.pickOpen = false; this.R.render(); return true; }
    if (ds.cact === 'clear') { this._pick = []; this.R.render(); return true; }
    if (ds.crm) { this.ids = this.ids.filter((id) => id !== ds.crm); if (this.baseId === ds.crm) this.baseId = null; this.R.render(); return true; }
    if (ds.czoom) { this.zoom(ds.czoom === 'fit' ? 'fit' : Number(ds.czoom)); return true; }
    if (ds.pzoom) { this.pzoom(ds.pzoom === 'fit' ? 'fit' : Number(ds.pzoom)); return true; }
    if (ds.ccmd) { if (this.cmdFilter.has(ds.ccmd) && this.cmdFilter.size > 1) this.cmdFilter.delete(ds.ccmd); else this.cmdFilter.add(ds.ccmd); this.R.render(); return true; }
    if (ds.crow) { this.rowFilter = ds.crow; this.R.render(); return true; }
    if (ds.psort) { this.period.sort = ds.psort; this.R.render(); return true; }
    if (ds.pexp) { this.exportPeriod(ds.pexp); return true; }
    return false;
  }

  /** 入力の変更（処理したら true） */
  onChange(e) {
    const t = e.target, P = this.period;
    if (t.matches('[data-cpick]')) {
      const cur = new Set(this._pick ?? this.ids);
      if (t.checked) cur.add(t.dataset.cpick); else cur.delete(t.dataset.cpick);
      this._pick = [...cur]; this.pickOpen = true; this.R.render(); return true;
    }
    if (t.matches('[data-cbase]')) { this.baseId = t.dataset.cbase; this.R.render(); return true; }
    if (t.matches('[data-pset]')) { P.preset = t.value; if (t.value !== 'custom') Object.assign(P, presetPeriods(t.value)); this.ppps = null; this.R.render(); return true; }
    if (t.matches('[data-pdate]')) { const k = t.dataset.pdate; P[k[0]] = k[1] === '0' ? [t.value, P[k[0]][1]] : [P[k[0]][0], t.value]; P.preset = 'custom'; this.R.render(); return true; }
    if (t.matches('[data-pcond]')) { P.cond = t.value; this.ppps = null; P.sel = null; this.R.render(); return true; }
    if (t.matches('[data-pinc]')) { P[t.dataset.pinc] = t.checked; this.R.render(); return true; }
    return false;
  }
}

export { conditionDiffs };
