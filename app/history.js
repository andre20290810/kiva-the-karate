// 成績の履歴（このブラウザの localStorage）。譜面・編集内容とは別の保存先・別の JSON 形式。
// 保存できないとき（容量・プライベートモード）は失敗を返し、呼び出し側が JSON の退避を案内する。

import { recordError } from './score.js';

export const HISTORY_SCHEMA = 'kiva-score-history/1';
export const HISTORY_LIMIT = 150; // 超えたら古い練習・途中終了から消す（通しプレイは最後に消す）

export class ScoreHistory {
  constructor(key, storage = globalThis.localStorage) {
    this.key = key;
    this.storage = storage;
    this.records = [];
    this.loadError = null;
    this.load();
  }

  load() {
    try {
      const obj = JSON.parse(this.storage?.getItem(this.key) || 'null');
      const list = Array.isArray(obj?.records) ? obj.records : [];
      this.records = list.filter((r) => !recordError(r));
      this.loadError = null;
    } catch (e) {
      this.records = [];
      this.loadError = `履歴を読み込めませんでした: ${e.message}`;
    }
    return this.records;
  }

  /** 保存（成功で {ok:true}、失敗で {ok:false, error}）。メモリ上の記録は残す */
  save() {
    try {
      this.storage.setItem(this.key, JSON.stringify({ schema: HISTORY_SCHEMA, records: this.records }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.name === 'QuotaExceededError' ? 'ブラウザの保存領域がいっぱいです' : `保存できませんでした（${e?.message || e}）` };
    }
  }

  add(rec) {
    this.records.push(rec);
    this.records.sort((a, b) => (a.at < b.at ? -1 : 1));
    this._trim();
    return this.save(); // 失敗してもメモリ上の記録は残す（成績画面と JSON の退避に使う）
  }

  _trim() {
    while (this.records.length > HISTORY_LIMIT) {
      const i = this.records.findIndex((r) => r.kind !== 'full');
      this.records.splice(i >= 0 ? i : 0, 1);
    }
  }

  remove(ids) {
    const set = new Set(ids);
    const before = this.records.length;
    this.records = this.records.filter((r) => !set.has(r.id));
    const r = this.save();
    return { ...r, removed: before - this.records.length };
  }

  get(id) { return this.records.find((r) => r.id === id) || null; }

  /** 書き出し（ids を省略すると全部） */
  exportText(ids = null) {
    const list = ids ? this.records.filter((r) => ids.includes(r.id)) : this.records;
    return JSON.stringify({ schema: HISTORY_SCHEMA, exportedAt: new Date().toISOString(), records: list }, null, 2) + '\n';
  }

  /** 読み込み（同じ ID は重複させない）。{ok, added, skipped, invalid, error} */
  importText(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: `JSON として読めません: ${e.message}` }; }
    let list;
    if (obj?.schema === HISTORY_SCHEMA && Array.isArray(obj.records)) list = obj.records;
    else if (!recordError(obj)) list = [obj];
    else return { ok: false, error: obj?.schemaVersion != null && Array.isArray(obj?.notes) ? 'これは譜面 JSON です。成績 JSON（履歴）を選んでください（譜面は編集モードで読み込みます）' : recordError(obj) || '成績 JSON ではありません' };
    const have = new Set(this.records.map((r) => r.id));
    let added = 0, skipped = 0, invalid = 0;
    for (const r of list) {
      if (recordError(r)) { invalid++; continue; }
      if (have.has(r.id)) { skipped++; continue; }
      this.records.push(r); have.add(r.id); added++;
    }
    this.records.sort((a, b) => (a.at < b.at ? -1 : 1));
    this._trim();
    const s = this.save();
    return { ok: s.ok, error: s.error, added, skipped, invalid };
  }
}
