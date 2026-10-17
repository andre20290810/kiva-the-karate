// 判定処理（純粋ロジック・DOM非依存）。
// MANUAL と AUTO の両方がこの Judge.input() を通る。AUTO だけ別ルートで
// 得点やエフェクトを出すことはしない。

export const DEFAULT_WINDOWS = Object.freeze({
  perfect: 0.080, // ±80ms
  good: 0.150,    // ±150ms
});

export const RESULT = Object.freeze({
  PERFECT: 'PERFECT',
  GOOD: 'GOOD',
  MISS: 'MISS',
});

const SCORE = { PERFECT: 1000, GOOD: 500, MISS: 0 };

export class Judge {
  /**
   * @param {Array<{id:string,t:number,cmd:string}>} notes 判定時刻（音声時刻・秒）順でなくてもよい
   * @param {{perfect:number,good:number}} windows
   */
  constructor(notes, windows = DEFAULT_WINDOWS) {
    this.windows = { ...DEFAULT_WINDOWS, ...windows };
    if (!(this.windows.perfect > 0 && this.windows.good >= this.windows.perfect)) {
      throw new Error('判定幅が不正です: perfect <= good である必要があります');
    }
    this.notes = notes
      .map((n, i) => ({ ...n, index: i, result: null, hitTime: null, delta: null, source: null }))
      .sort((a, b) => a.t - b.t);
    this.listeners = new Set();
    this.consumedInputIds = new Set();
    this.missCursor = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.score = 0;
    this.counts = { PERFECT: 0, GOOD: 0, MISS: 0 };
    this.strayInputs = 0;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  /**
   * 論理コマンド入力を判定する。
   * @param {{cmd:string, time:number, source:string, id?:string}} input
   *   time は音声の再生位置（秒）。id を渡すと同じ入力の二重処理を防ぐ。
   * @returns 判定されたノーツのイベント、または null（空振り）
   */
  input({ cmd, time, source, id }) {
    if (id != null) {
      if (this.consumedInputIds.has(id)) return null;
      this.consumedInputIds.add(id);
    }
    const g = this.windows.good;
    // 未判定・同じコマンド・判定幅内のうち、時刻差が最小のノーツに当てる。
    let best = null;
    for (const n of this.notes) {
      if (n.t - time > g) break;
      if (n.result || n.cmd !== cmd) continue;
      const d = Math.abs(time - n.t);
      if (d <= g && (!best || d < Math.abs(time - best.t))) best = n;
    }
    if (!best) {
      this.strayInputs++;
      this.emit({ type: 'stray', cmd, time, source });
      return null;
    }
    const delta = time - best.t;
    const result = Math.abs(delta) <= this.windows.perfect ? RESULT.PERFECT : RESULT.GOOD;
    return this._settle(best, result, time, delta, source);
  }

  /** 判定期限（t + good）を過ぎた未判定ノーツを MISS にする。 */
  update(time) {
    const g = this.windows.good;
    const out = [];
    while (this.missCursor < this.notes.length) {
      const n = this.notes[this.missCursor];
      if (n.result) { this.missCursor++; continue; }
      if (time > n.t + g) {
        out.push(this._settle(n, RESULT.MISS, null, null, 'timeout'));
        this.missCursor++;
      } else break;
    }
    return out;
  }

  _settle(note, result, time, delta, source) {
    note.result = result;
    note.hitTime = time;
    note.delta = delta;
    note.source = source;
    this.counts[result]++;
    if (result === RESULT.MISS) {
      this.combo = 0;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.score += SCORE[result] + Math.min(this.combo, 50) * 10;
    }
    const ev = { type: 'judged', note, result, time, delta, source, combo: this.combo };
    this.emit(ev);
    return ev;
  }

  get done() { return this.notes.every((n) => n.result); }

  summary() {
    const total = this.notes.length;
    const hit = this.counts.PERFECT + this.counts.GOOD;
    return {
      total,
      perfect: this.counts.PERFECT,
      good: this.counts.GOOD,
      miss: this.counts.MISS,
      // 達成率: PERFECT=1, GOOD=0.5 の重みで算出（ゲーム内の入力成績）
      achievement: total ? (this.counts.PERFECT + this.counts.GOOD * 0.5) / total : 0,
      hitRate: total ? hit / total : 0,
      maxCombo: this.maxCombo,
      score: this.score,
      strayInputs: this.strayInputs,
    };
  }
}
