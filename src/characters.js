// 表示キャラクターの切替（純粋ロジック・DOM非依存）。
// 型の動作・音声・譜面・判定は共通。キャラクターごとに変わるのは「表示する人物画像」だけ。
// 別キャラクターの画像は、基準（KIVA のセーパイ演武）と同じ時間軸（fps・枚数・各コマの時刻）で
// 作られている必要がある。存在しない・時間軸が合わない場合は「未完成」として扱い、人物を描かない。

export const STATUS = Object.freeze({ READY: 'ready', PENDING: 'pending', UNAVAILABLE: 'unavailable', LOADING: 'loading' });

/**
 * 譜面の characters 定義を正規化する。未指定なら譜面の frames を使う1人だけ。
 * @returns {Array<{id:string,name:string,frames:string|null,status:string,note?:string,references?:string[]}>}
 */
export function characterList(chart) {
  const list = Array.isArray(chart.characters) && chart.characters.length
    ? chart.characters
    : [{ id: 'kiva', name: 'KIVA', frames: chart.frames }];
  const seen = new Set();
  return list.map((c, i) => {
    if (!c.id || seen.has(c.id)) throw new Error(`characters[${i}] の id が未指定または重複しています`);
    seen.add(c.id);
    return {
      id: c.id,
      name: c.name || c.id,
      frames: c.frames || null,
      // 基準キャラクター（先頭）は譜面の frames と同じ画像を使う
      base: i === 0,
      status: c.frames ? (c.status === STATUS.PENDING ? STATUS.PENDING : STATUS.READY) : STATUS.PENDING,
      note: c.note || '',
      references: c.references || [],
    };
  });
}

/**
 * 別キャラクターの frames.json が基準と同じ時間軸か検査する。
 * @param {{fps:number,frames:Array<{t:number}>}} base
 * @param {{fps:number,width:number,height:number,frames:Array<{t:number,file:string}>}} def
 */
export function validateCharacterFrames(base, def) {
  if (!def || !Array.isArray(def.frames)) return { ok: false, reason: 'フレーム定義の形式が不正です' };
  if (def.fps !== base.fps) return { ok: false, reason: `fps が違います（基準 ${base.fps} / ${def.fps}）` };
  if (def.frames.length !== base.frames.length) return { ok: false, reason: `フレーム数が違います（基準 ${base.frames.length} / ${def.frames.length}）` };
  if (!(def.width > 0 && def.height > 0)) return { ok: false, reason: '画像サイズ（width/height）がありません' };
  for (let i = 0; i < def.frames.length; i++) {
    const f = def.frames[i];
    if (!f.file) return { ok: false, reason: `フレーム ${i} のファイル名がありません` };
    if (Math.abs(f.t - base.frames[i].t) > 0.001) return { ok: false, reason: `フレーム ${i} の時刻が基準と違います（${base.frames[i].t} / ${f.t}）` };
  }
  return { ok: true, reason: '' };
}

/** 選択状態（クリックで順に切替。選択は保存し、次回も同じキャラクターで始まる） */
export class CharacterSelector {
  constructor(list, storage = null, key = 'kiva.character') {
    this.list = list;
    this.storage = storage;
    this.key = key;
    let saved = null;
    try { saved = storage?.getItem(key); } catch { /* 保存不可 */ }
    this.index = Math.max(0, list.findIndex((c) => c.id === saved));
  }

  get current() { return this.list[this.index]; }

  next() {
    this.index = (this.index + 1) % this.list.length;
    try { this.storage?.setItem(this.key, this.current.id); } catch { /* 保存不可でも切替は有効 */ }
    return this.current;
  }

  label() { return this.list.map((c) => c.name).join(' ⇄ '); }
}
