// 判定（純粋ロジック・DOM 非依存）。手動入力も AUTO も、この press / release を通る。
// 時刻はすべて時間軸の秒（入力補正は呼び出し側で適用済み）。

export const GRADE = Object.freeze({ PERFECT: 'PERFECT', GOOD: 'GOOD', MISS: 'MISS', SKIP: 'SKIP' });
const POINTS = { PERFECT: 1000, GOOD: 500, MISS: 0, SKIP: 0 };

export class Judge {
  /**
   * @param {Array<{id:string,time:number,button:string,input:'tap'|'hold',duration?:number}>} notes
   * @param {{perfectWindowMs:number,goodWindowMs:number,missWindowMs:number,holdReleaseWindowMs:number}} settings
   */
  constructor(notes, settings) {
    this.w = {
      perfect: settings.perfectWindowMs / 1000, good: settings.goodWindowMs / 1000,
      miss: settings.missWindowMs / 1000, release: settings.holdReleaseWindowMs / 1000,
    };
    if (!(this.w.perfect > 0 && this.w.perfect <= this.w.good && this.w.good <= this.w.miss)) throw new Error('判定幅が不正です');
    this.notes = notes.map((n) => ({
      id: n.id, time: n.time, button: n.button, input: n.input, duration: n.input === 'hold' ? n.duration : 0,
      sequenceId: n.sequenceId ?? null, src: n,
      result: null, holding: false, startGrade: null, delta: null, points: 0, reason: null, judgedAt: null,
    })).sort((a, b) => a.time - b.time);
    this.byId = new Map(this.notes.map((n) => [n.id, n]));
    this.listeners = new Set();
    this.seenInputs = new Set();
    this.combo = 0;
    this.maxCombo = 0;
    this.stray = 0;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  /** ボタンを押した。id が同じ入力は 1 回しか処理しない（タッチとクリックの二重処理対策）。 */
  press(button, time, { id, source = 'input' } = {}) {
    if (id != null) {
      if (this.seenInputs.has(id)) return null;
      this.seenInputs.add(id);
    }
    let best = null;
    for (const n of this.notes) {
      if (n.time - time > this.w.miss) break;
      if (n.button !== button || n.result || n.holding) continue;
      const d = Math.abs(time - n.time);
      if (d <= this.w.miss && (!best || d < Math.abs(time - best.time))) best = n;
    }
    if (!best) {
      this.stray++;
      this.emit({ type: 'stray', button, time, source });
      return null;
    }
    const delta = time - best.time;
    const ad = Math.abs(delta);
    const grade = ad <= this.w.perfect ? GRADE.PERFECT : ad <= this.w.good ? GRADE.GOOD : GRADE.MISS;
    best.delta = delta;
    if (best.input === 'hold' && grade !== GRADE.MISS) {
      best.holding = true;
      best.startGrade = grade;
      best.holdSource = source;
      const ev = { type: 'holdStart', note: best, grade, time, delta, source };
      this.emit(ev);
      return ev;
    }
    return this._settle(best, grade, time, source, grade === GRADE.MISS ? (delta < 0 ? 'early' : 'late') : null);
  }

  /** ボタンを離した。長押し中のノーツがあれば、終了に届いたかを判定する。 */
  release(button, time, { source = 'input' } = {}) {
    const out = [];
    for (const n of this.notes) {
      if (!n.holding || n.button !== button) continue;
      const end = n.time + n.duration;
      if (time >= end - this.w.release) out.push(this._settle(n, n.startGrade, time, source, null));
      else out.push(this._settle(n, GRADE.MISS, time, source, 'early-release'));
    }
    return out;
  }

  /** 時刻を進める: 長押しの完了・期限切れの MISS を確定する（描画のたびに呼ぶ）。 */
  update(time) {
    const out = [];
    for (const n of this.notes) {
      if (n.time - time > this.w.miss) break;
      if (n.result) continue;
      if (n.holding) {
        if (time >= n.time + n.duration) out.push(this._settle(n, n.startGrade, n.time + n.duration, n.holdSource, null));
      } else if (time > n.time + this.w.miss) {
        out.push(this._settle(n, GRADE.MISS, time, 'timeout', 'timeout'));
      }
    }
    return out;
  }

  /** 長押しの進み具合 0〜1（押していないときは null） */
  holdProgress(n, time) {
    if (!n.holding) return null;
    return Math.max(0, Math.min(1, (time - n.time) / n.duration));
  }

  _settle(n, grade, time, source, reason) {
    n.result = grade;
    n.holding = false;
    n.reason = reason;
    n.judgedAt = time;
    if (grade === GRADE.MISS) {
      this.combo = 0;
      n.points = 0;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      n.points = POINTS[grade] + Math.min(this.combo, 50) * 10;
    }
    const ev = { type: 'judged', note: n, grade, time, source, reason, combo: this.combo };
    this.emit(ev);
    return ev;
  }

  /**
   * シーク・ループ・リトライ: time 以降のノーツを未判定に戻す。time より前で未判定のものは SKIP（成績に数えない）。
   * 長押し中のものは解除する。同じノーツが二重に加点されることはない（得点はノーツごとの値の合計）。
   */
  resetFrom(time) {
    for (const n of this.notes) {
      n.holding = false;
      if (n.time >= time - 1e-6) {
        n.result = null; n.delta = null; n.points = 0; n.reason = null; n.startGrade = null; n.judgedAt = null;
      } else if (!n.result) {
        n.result = GRADE.SKIP; n.reason = 'skipped';
      }
    }
    this.combo = 0;
    this.seenInputs.clear();
  }

  /** AUTO 切替時など: 長押し中のノーツを成績に数えない状態にする */
  cancelHolds() {
    for (const n of this.notes) if (n.holding) { n.holding = false; n.result = GRADE.SKIP; n.reason = 'cancelled'; }
  }

  summary() {
    const c = { PERFECT: 0, GOOD: 0, MISS: 0, SKIP: 0 };
    let score = 0;
    for (const n of this.notes) { if (n.result) c[n.result]++; score += n.points; }
    const counted = this.notes.length - c.SKIP;
    return {
      total: this.notes.length, counted, perfect: c.PERFECT, good: c.GOOD, miss: c.MISS, skip: c.SKIP,
      score, combo: this.combo, maxCombo: this.maxCombo, stray: this.stray,
      achievement: counted ? (c.PERFECT + c.GOOD * 0.5) / counted : 0,
      judged: c.PERFECT + c.GOOD + c.MISS,
    };
  }
}
