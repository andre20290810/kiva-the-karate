// 判定（純粋ロジック・DOM 非依存）。手動入力も AUTO も、この press / release を通る。
// 時刻はすべて時間軸の秒（入力補正は呼び出し側で適用済み。補正前の時刻は raw として記録だけする）。
// ずれ = 入力時刻 − 正解時刻（マイナス = 早い、プラス = 遅い）。境界は ms で比べ、境界ちょうどは内側（|ずれ| ≤ 幅）。
// 記録: ノーツに当たった入力（hit）、長押しの離した時刻（release）、どのノーツにも当たらなかった入力（strays）。
// 判定は確定したら変えない（後からの入力を別のノーツへ付け替えない）。入力のない MISS には入力時刻・ずれを入れない。

export const GRADE = Object.freeze({ PERFECT: 'PERFECT', GOOD: 'GOOD', MISS: 'MISS', SKIP: 'SKIP' });
const POINTS = { PERFECT: 1000, GOOD: 500, MISS: 0, SKIP: 0 };
/** 秒の差 → ms（µs で丸めて浮動小数の誤差を消す。60.0000000001 ms を 60 ms として境界内にする） */
export const diffMs = (a, b) => Math.round((a - b) * 1e6) / 1e3;

export class Judge {
  /**
   * @param {Array<{id:string,time:number,button:string,input:'tap'|'hold',duration?:number}>} notes
   * @param {{perfectWindowMs:number,goodWindowMs:number,missWindowMs:number,holdReleaseWindowMs:number,holdStartWindowMs?:number}} settings
   */
  constructor(notes, settings) {
    this.ms = {
      perfect: settings.perfectWindowMs, good: settings.goodWindowMs, miss: settings.missWindowMs,
      holdStart: settings.holdStartWindowMs ?? settings.goodWindowMs, release: settings.holdReleaseWindowMs,
    };
    this.w = { perfect: this.ms.perfect / 1000, good: this.ms.good / 1000, miss: this.ms.miss / 1000, release: this.ms.release / 1000 };
    const m = this.ms;
    if (!(m.perfect > 0 && m.perfect <= m.good && m.good <= m.miss && m.perfect <= m.holdStart && m.holdStart <= m.miss)) throw new Error('判定幅が不正です');
    this.notes = notes.map((n) => ({
      id: n.id, time: n.time, button: n.button, input: n.input, duration: n.input === 'hold' ? n.duration : 0,
      sequenceId: n.sequenceId ?? null, src: n,
      result: null, holding: false, startGrade: null, delta: null, points: 0, reason: null, judgedAt: null,
      hit: null, release: null, completedAt: null, awaitRelease: false,
    })).sort((a, b) => a.time - b.time);
    this.byId = new Map(this.notes.map((n) => [n.id, n]));
    this.listeners = new Set();
    this.seenInputs = new Set();
    this.strays = [];
    this.combo = 0;
    this.maxCombo = 0;
    this.stray = 0;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  /**
   * ボタンを押した。id が同じ入力は 1 回しか処理しない（タッチとクリックの二重処理対策）。
   * o.raw: 入力補正の前の時刻、o.device: keyboard|touch|mouse|gamepad|auto（記録用）
   */
  press(button, time, { id, source = 'input', raw = time, device = source } = {}) {
    if (id != null) {
      if (this.seenInputs.has(id)) return null;
      this.seenInputs.add(id);
    }
    let best = null, bestAd = Infinity;
    for (const n of this.notes) {
      if (diffMs(n.time, time) > this.ms.miss) break;
      if (n.button !== button || n.result || n.holding) continue;
      const ad = Math.abs(diffMs(time, n.time));
      if (ad <= this.ms.miss && ad < bestAd) { best = n; bestAd = ad; }
    }
    const input = { time, raw, device, button, source };
    if (!best) {
      this.stray++;
      this.strays.push(input);
      this.emit({ type: 'stray', button, time, source, input });
      return null;
    }
    const deltaMs = diffMs(time, best.time);
    const ad = Math.abs(deltaMs);
    const goodMs = best.input === 'hold' ? this.ms.holdStart : this.ms.good;
    const grade = ad <= this.ms.perfect ? GRADE.PERFECT : ad <= goodMs ? GRADE.GOOD : GRADE.MISS;
    best.delta = deltaMs / 1000;
    best.hit = { ...input, deltaMs, rawDeltaMs: diffMs(raw, best.time) };
    if (best.input === 'hold' && grade !== GRADE.MISS) {
      best.holding = true;
      best.startGrade = grade;
      best.holdSource = source;
      const ev = { type: 'holdStart', note: best, grade, time, delta: best.delta, source, input };
      this.emit(ev);
      return ev;
    }
    return this._settle(best, grade, time, source, grade === GRADE.MISS ? (deltaMs < 0 ? 'early' : 'late') : null);
  }

  /**
   * ボタンを離した。長押し中のノーツがあれば、終了に届いたかを判定する。
   * 長押しが自動で完了した後に離した場合は、その実際の時刻だけを記録する（判定は変えない）。
   */
  release(button, time, { source = 'input', raw = time, device = source } = {}) {
    const out = [];
    for (const n of this.notes) {
      if (n.button !== button) continue;
      if (n.holding) {
        const end = n.time + n.duration;
        n.release = { time, raw, device, deltaMs: diffMs(time, end) };
        if (diffMs(end, time) <= this.ms.release) out.push(this._settle(n, n.startGrade, time, source, 'released'));
        else out.push(this._settle(n, GRADE.MISS, time, source, 'early-release'));
      } else if (n.awaitRelease) {
        n.awaitRelease = false;
        n.release = { time, raw, device, deltaMs: diffMs(time, n.time + n.duration) };
        this.emit({ type: 'holdRelease', note: n, time, source });
      }
    }
    return out;
  }

  /** 時刻を進める: 長押しの完了・期限切れの MISS を確定する（描画のたびに呼ぶ）。 */
  update(time) {
    const out = [];
    for (const n of this.notes) {
      if (diffMs(n.time, time) > this.ms.miss) break;
      if (n.result) continue;
      if (n.holding) {
        // 必要な時間を保持した: 終了の時刻で成功を確定（ユーザーが離した時刻ではない。離した時刻は release で別に記録）
        if (time >= n.time + n.duration) {
          n.completedAt = n.time + n.duration;
          n.awaitRelease = true;
          out.push(this._settle(n, n.startGrade, n.time + n.duration, n.holdSource, 'completed'));
        }
      } else if (diffMs(time, n.time) > this.ms.miss) {
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
      n.awaitRelease = false;
      if (n.time >= time - 1e-6) {
        n.result = null; n.delta = null; n.points = 0; n.reason = null; n.startGrade = null; n.judgedAt = null;
        n.hit = null; n.release = null; n.completedAt = null;
      } else if (!n.result) {
        n.result = GRADE.SKIP; n.reason = 'skipped';
      }
    }
    this.strays = this.strays.filter((s) => s.time < time - 1e-6);
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
