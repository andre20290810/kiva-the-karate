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
const MARK = { PERFECT: '●', GOOD: '▲', MISS: '✕' };
const GRADE_CLASS = { PERFECT: 'g-perfect', GOOD: 'g-good', MISS: 'g-miss', SKIP: 'g-skip' };
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
    g += `<rect x="${X(-s.goodWindowMs)}" y="${top - 6}" width="${X(s.goodWindowMs) - X(-s.goodWindowMs)}" height="${rows.length * rowH + 6}" class="band-good"/>`;
    g += `<rect x="${X(-s.perfectWindowMs)}" y="${top - 6}" width="${X(s.perfectWindowMs) - X(-s.perfectWindowMs)}" height="${rows.length * rowH + 6}" class="band-perfect"/>`;
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
        const shape = n.result === 'PERFECT' ? `<circle cx="${x}" cy="${y}" r="5"/>`
          : n.result === 'GOOD' ? `<path d="M${x} ${y - 6}L${x + 6} ${y + 4.5}L${x - 6} ${y + 4.5}Z"/>`
            : `<path d="M${x - 5} ${y - 5}L${x + 5} ${y + 5}M${x + 5} ${y - 5}L${x - 5} ${y + 5}"/>`;
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
      <p class="hint">中央が正解の時刻（0ms）。左が早い入力、右が遅い入力。点の位置がずれの大きさです。帯: 内側 = PERFECT の範囲、外側 = GOOD の範囲。
        記号: ${MARK.PERFECT} PERFECT ／ ${MARK.GOOD} GOOD ／ ${MARK.MISS} MISS（入力あり）。息は押し始めのずれで、早離しの ${MARK.MISS} は押し始めが範囲内でも MISS（離した時刻は「ノーツ詳細」）。点にカーソル・長押しで ID と値。</p>
      ${this.rateNote(r)}
      ${this.graphSvg(r, [{ notes: pts, style: 'cur' }])}
      <p>表示中の入力: ${pts.length} 件</p>
      <div class="res-none"><b>入力なしの MISS（0ms には描きません）: ${none.length} 件</b>
        ${none.length ? `<ul>${none.map((n) => `<li>${MARK.MISS} ${esc(n.id)} ${n.cmd}（${sec(n.time)}）</li>`).join('')}</ul>` : ''}</div>`;
  }

  // ---------- ノーツ詳細 ----------
  detailHtml(r) {
    const rows = r.notes.filter((n) => this.filter.has(n.button)).map((n) => {
      const inp = n.input;
      const main = `<tr class="${GRADE_CLASS[n.result]}"><td>${esc(n.id)}</td><td>${n.cmd}</td><td>${sec(n.time)}</td><td>${inp ? sec(inp.time) : '—'}</td>
        <td>${inp ? sMs(inp.deltaMs) : '—'}${inp && inp.rawDeltaMs !== inp.deltaMs ? `<br><small>補正前 ${sMs(inp.rawDeltaMs)}</small>` : ''}</td>
        <td>${MARK[n.result] || ''} ${n.result}${n.reason && REASON[n.reason] ? `<br><small>${REASON[n.reason]}</small>` : ''}</td><td>${inp ? DEVICE_LABEL[inp.device] || inp.device : '—'}</td></tr>`;
      if (!n.hold) return main;
      const h = n.hold;
      return `${main}<tr class="hold-row"><td></td><td colspan="6">
        <span>開始のずれ ${inp ? sMs(inp.deltaMs) : '—'}</span>
        <span>終了の時刻 ${sec(h.end)}</span>
        <span>離した時刻 ${h.releasedAt != null ? sec(h.releasedAt) : '—'}（終了から ${h.releaseDeltaMs != null ? sMs(h.releaseDeltaMs) : '—'}）</span>
        <span>必要な保持 ${h.requiredSec.toFixed(2)} 秒（長押し ${h.duration.toFixed(2)} 秒 − 早離しの許容 ${r.settings.holdReleaseWindowMs}ms）</span>
        <span>実際の保持 ${h.heldSec != null ? `${h.heldSec.toFixed(2)} 秒` : '—'}</span>
        <span>状況: ${HOLD_STATUS_LABEL[h.status] || h.status}</span></td></tr>`;
    }).join('');
    const ex = r.extras.filter((x) => this.filter.has(x.button));
    return `${this.filterHtml()}${this.rateNote(r)}
      <div class="res-scroll"><table class="res-table res-detail"><caption>ノーツごとの入力（ずれ = 入力時刻 − 正解時刻）</caption>
        <thead><tr><th>ID</th><th>技</th><th>正解時刻</th><th>入力時刻</th><th>ずれ</th><th>判定</th><th>入力方法</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="res-scroll"><table class="res-table"><caption>余分な入力（判定範囲外・間違ったボタン。どのノーツにも付けない）: ${ex.length} 件</caption>
        <thead><tr><th>入力時刻</th><th>ボタン</th><th>入力方法</th></tr></thead>
        <tbody>${ex.map((x) => `<tr><td>${sec(x.time)}</td><td>${x.cmd}／${x.button}</td><td>${DEVICE_LABEL[x.device] || x.device}</td></tr>`).join('') || '<tr><td colspan="3">なし</td></tr>'}</tbody></table></div>`;
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
      ${c.sameChart ? `${this.filterHtml()}<p class="hint">同じノーツの入力位置（同じ目盛り）: 塗りつぶし = 今回、白抜き = 比較する記録。線で同じノーツを結んでいます。</p>
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
