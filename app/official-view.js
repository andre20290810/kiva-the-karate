// 「公式データとして保存・公開」の画面（編集モードから開く）。
// - 個人用の保存（この端末のデフォルト・下書き・JSON 書き出し）とは別の操作。全利用者に配布する公式データを、サーバーで認証して更新する。
// - パスワードは保存・復元のたびに入力し、送信後すぐ消す（ブラウザに解除状態を残さない。ログ・成績 JSON に出さない）。
// - 送る前に、対象・変更概要・今の版を表示（サーバーと同じ prepareUpdate で確認）。サーバーも同じ検証をする。

import { prepareUpdate, summaryText, TARGETS } from './official.js';
import { normalizeChart, exportChart } from './chart.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => { try { return iso ? new Date(iso).toLocaleString('ja-JP') : '配布時（公開ビルド）'; } catch { return iso; } };

export class OfficialView {
  constructor(app) {
    this.app = app;
    this.dlg = document.createElement('dialog');
    this.dlg.id = 'officialDlg';
    this.dlg.className = 'off-dlg';
    this.dlg.setAttribute('aria-labelledby', 'offTitle');
    document.body.append(this.dlg);
    this.targets = new Set(['effects']);
    this.demoSource = 'bundle';
    this.demoFile = null;
    this.cur = null;
    this.versions = [];
    this.msg = { text: '', kind: '' };
    this.dlg.addEventListener('click', (e) => this.onClick(e));
    this.dlg.addEventListener('change', (e) => this.onChange(e));
    this.dlg.addEventListener('close', () => this.clearPassword());
    this.dlg.addEventListener('cancel', () => { this.msg = { text: 'キャンセルしました（変更していません）', kind: 'info' }; });
  }

  async open() {
    this.msg = { text: '公式データを読み込み中…', kind: 'info' };
    this.render();
    if (!this.dlg.open) this.dlg.showModal();
    await this.reload();
  }

  async reload() {
    try {
      const [c, v] = await Promise.all([fetch('api/official', { cache: 'no-store' }), fetch('api/official/versions', { cache: 'no-store' })]);
      if (!c.ok) throw new Error(`公式データを読み込めません（${c.status}）`);
      this.cur = await c.json();
      this.versions = v.ok ? (await v.json()).versions || [] : [];
      this.online = true;
      this.msg = { text: '', kind: '' };
    } catch (e) {
      this.online = false;
      this.cur = null;
      this.msg = { text: `公式データのサーバーに接続できません（${e.message}）。この環境では公開できません。個人用の保存は使えます。`, kind: 'error' };
    }
    this.render();
  }

  /** 送る内容（今の編集中の譜面 + 公式デモ） */
  async body() {
    const b = { targets: [...this.targets], baseVersion: this.cur?.version };
    if ([...this.targets].some((t) => t !== 'demos')) b.chart = JSON.parse(exportChart(this.app.chart));
    if (this.targets.has('demos')) {
      if (this.demoSource === 'file') b.demos = this.demoFile?.records ?? null;
      else b.demos = (await (await fetch('charts/official-demos.json', { cache: 'no-store' })).json()).records;
    }
    return b;
  }

  async preview() {
    if (!this.cur) return null;
    const b = await this.body();
    const cur = { chart: normalizeChart(this.cur.chart), demos: this.cur.demos || [] };
    return prepareUpdate(cur, b, { frameCount: this.cur.chart.source?.frameCount, gameVersion: this.cur.chart.gameVersion });
  }

  async render() {
    const c = this.cur;
    const prev = c ? await this.preview().catch((e) => ({ errors: [e.message] })) : null;
    this.lastPreview = prev;
    const vlist = this.versions.slice(0, 12);
    this.dlg.innerHTML = `<form method="dialog" class="off-form" autocomplete="off">
      <h2 id="offTitle">公式データとして保存・公開（全利用者に配布）</h2>
      <p class="hint">新しく使い始める人と、「公開版の設定に切り替える」「配布時の初期設定に戻す」を選んだ人に反映します。各利用者が個人用に保存した譜面・設定・成績は上書きしません。
        個人用の保存（この端末のデフォルト・JSON 書き出し）にはパスワードは不要です。</p>
      <p class="off-cur">${c ? `今の公式データ: <b>版 ${c.version}</b>（更新 ${esc(when(c.updatedAt))}${c.targets?.length ? `・${c.targets.map((t) => TARGETS[t] || t).join('・')}` : ''}）${c.summary ? `<br><small>${esc(c.summary)}</small>` : ''}` : '今の公式データ: 読み込めません'}</p>
      <fieldset class="off-targets"><legend>更新する対象（選んだものだけを上書き）</legend>
        ${Object.entries(TARGETS).map(([k, l]) => `<label><input type="checkbox" data-target="${k}" ${this.targets.has(k) ? 'checked' : ''}> ${l}</label>`).join('')}
        <p class="hint">譜面・判定設定・個別エフェクトは、いま編集中の譜面（${esc(this.app.chart.title || '')}・${this.app.chart.notes.length} ノーツ）から取ります。</p>
        ${this.targets.has('demos') ? `<div class="off-demo"><label><input type="radio" name="offDemo" value="bundle" ${this.demoSource === 'bundle' ? 'checked' : ''}> このビルドに同梱の公式デモ（charts/official-demos.json）</label>
          <label><input type="radio" name="offDemo" value="file" ${this.demoSource === 'file' ? 'checked' : ''}> ファイルから（公式デモの JSON）</label>
          ${this.demoSource === 'file' ? `<input type="file" accept="application/json,.json" data-demofile> ${this.demoFile ? `<small>${esc(this.demoFile.name)}（${this.demoFile.records?.length ?? 0} 件）</small>` : ''}` : ''}</div>` : ''}
      </fieldset>
      <div class="off-preview" role="status">${!prev ? '' : prev.errors?.length ? `<p class="res-warn">公開できない内容です:</p><ul class="err">${prev.errors.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
        : `<p><b>変更概要:</b> ${esc(summaryText(prev.summary))}</p><p class="hint">公開すると 版 ${c.version + 1} になります。今の版 ${c.version} は保存され、あとで戻せます。</p>`}</div>
      <label class="off-pass">パスワード <input type="password" id="offPass" autocomplete="new-password" spellcheck="false" inputmode="text" aria-describedby="offPassHint"></label>
      <p id="offPassHint" class="hint">保存・復元のたびに入力します（このブラウザには記憶しません）。照合はサーバーで行います。</p>
      <p class="off-msg" data-kind="${this.msg.kind}" role="alert">${esc(this.msg.text)}</p>
      <div class="off-act"><button type="button" class="tbtn primary" data-off="publish" ${!c || prev?.errors?.length ? 'disabled' : ''}>公式データとして保存・公開</button>
        <button type="button" class="tbtn" data-off="cancel">キャンセル</button><button type="button" class="tbtn" data-off="reload">最新を読み込む</button></div>
      <details class="off-versions" ${this.showVersions ? 'open' : ''}><summary>以前の版に戻す（${this.versions.length} 件）</summary>
        <p class="hint">戻すと、その版の内容が新しい版として公開されます（今の版も残ります）。上のパスワード欄に入力してから押してください。</p>
        <ul>${vlist.map((v) => `<li><b>版 ${v.version}</b> ${esc(when(v.updatedAt))} <small>${esc(v.summary || '')}</small>${c && v.version < c.version ? ` <button type="button" class="tbtn" data-restore="${v.version}">この版に戻す</button>` : ' <small>（今の版）</small>'}</li>`).join('') || '<li>まだ更新されていません（版 0 = 公開ビルドの初期データ）</li>'}</ul></details>
    </form>`;
  }

  clearPassword() { const p = this.dlg.querySelector('#offPass'); if (p) p.value = ''; }

  async send(path, payload, label) {
    const pass = this.dlg.querySelector('#offPass');
    const password = pass?.value || '';
    if (!password) { this.msg = { text: 'パスワードを入力してください（保存していません）', kind: 'error' }; this.render(); return; }
    this.msg = { text: `${label}中…`, kind: 'info' };
    this.dlg.querySelector('.off-msg').textContent = this.msg.text;
    let res, data;
    try {
      res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, password }), cache: 'no-store', credentials: 'same-origin' });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      data = { message: `送信できませんでした（${e.message}）` }; res = { status: 0 };
    } finally {
      if (pass) pass.value = ''; // 送信後すぐ消す
    }
    if (res.status === 200 && data.ok) {
      this.msg = { text: `${label}しました: 版 ${data.version}（${when(data.updatedAt)}）${data.summary ? ` — ${data.summary}` : ''}`, kind: 'ok' };
      await this.reload();
      this.msg = { text: `${label}しました: 版 ${data.version}（${when(data.updatedAt)}）${data.summary ? ` — ${data.summary}` : ''}`, kind: 'ok' };
      await this.app.applyOfficial(this.cur);
    } else {
      const extra = data.errors?.length ? `: ${data.errors.slice(0, 4).join(' ／ ')}` : '';
      this.msg = { text: `${data.message || `失敗しました（${res.status}）`}${extra}`, kind: 'error' };
      if (res.status === 409) await this.reload(), this.msg = { text: `${data.message}`, kind: 'error' };
    }
    this.render();
  }

  async onClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.off === 'cancel') { this.clearPassword(); this.msg = { text: 'キャンセルしました（変更していません）', kind: 'info' }; this.dlg.close('cancel'); return; }
    if (b.dataset.off === 'reload') { await this.reload(); return; }
    if (b.dataset.off === 'publish') { const p = await this.body(); await this.send('api/official/publish', p, '公式データを公開'); return; }
    if (b.dataset.restore != null) { this.showVersions = true; await this.send('api/official/restore', { version: Number(b.dataset.restore), baseVersion: this.cur?.version }, `版 ${b.dataset.restore} に戻して公開`); }
  }

  async onChange(e) {
    const t = e.target;
    if (t.matches('[data-target]')) { if (t.checked) this.targets.add(t.dataset.target); else this.targets.delete(t.dataset.target); }
    else if (t.name === 'offDemo') this.demoSource = t.value;
    else if (t.matches('[data-demofile]')) {
      const f = t.files?.[0];
      if (f) { try { const j = JSON.parse(await f.text()); this.demoFile = { name: f.name, records: Array.isArray(j) ? j : j.records }; } catch (err) { this.demoFile = { name: f.name, records: null }; this.msg = { text: `JSON として読めません: ${err.message}`, kind: 'error' }; } }
    } else return;
    const keep = this.dlg.querySelector('#offPass')?.value || '';
    await this.render();
    const p = this.dlg.querySelector('#offPass'); if (p && keep) p.value = keep; // 対象の切り替えで入力中のパスワードを消さない（保存はしない）
  }
}
