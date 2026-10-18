// AUTO: 譜面のノーツを、予定の時刻ちょうどの入力として Judge へ渡す（通常プレイと同じ判定処理）。
// - 描画が遅れて判定時刻をまたいでも、「時刻 ≤ 現在」の全ノーツを順に処理する（完全一致では発火しない）
// - Y は予定時刻に押し、長押し時間の終わりに離す
// - 1 ノーツにつき 1 回だけ（入力 ID で二重処理も防ぐ）。譜面にない入力は作らない

export class AutoPlayer {
  /** @param {import('./judge.js').Judge} judge */
  constructor(judge, { generation = 0 } = {}) {
    this.judge = judge;
    this.generation = generation;
    this.queue = [...judge.notes].sort((a, b) => a.time - b.time);
    this.cursor = 0;
    this.active = []; // 押している長押しノーツ
    this.onPress = null;   // (button, note) 画面のボタン表示用
    this.onRelease = null;
  }

  /** time 以降のノーツから再開（それより前のノーツはまとめて成立させない） */
  reset(time) {
    this.cursor = this.queue.findIndex((n) => n.time >= time - 1e-6);
    if (this.cursor < 0) this.cursor = this.queue.length;
    for (const n of this.active) this.onRelease?.(n.button, n);
    this.active = [];
  }

  update(time) {
    const events = [];
    // 長押しの終了（押した順に、終了時刻が来たものを離す）
    const due = (n) => n.time + n.duration;
    while (true) {
      // 押下と解放を時刻順に処理する
      const nextPress = this.cursor < this.queue.length && this.queue[this.cursor].time <= time ? this.queue[this.cursor] : null;
      const nextRel = this.active.filter((n) => due(n) <= time).sort((a, b) => due(a) - due(b))[0] || null;
      if (!nextPress && !nextRel) break;
      if (nextRel && (!nextPress || due(nextRel) <= nextPress.time)) {
        this.active.splice(this.active.indexOf(nextRel), 1);
        events.push(...this.judge.release(nextRel.button, due(nextRel), { source: 'auto' }));
        this.onRelease?.(nextRel.button, nextRel);
        continue;
      }
      this.cursor++;
      if (nextPress.result) continue; // 判定済み（シーク前の状態など）は触らない
      const ev = this.judge.press(nextPress.button, nextPress.time, { id: `auto:${this.generation}:${nextPress.id}`, source: 'auto' });
      if (ev) events.push(ev);
      this.onPress?.(nextPress.button, nextPress);
      if (nextPress.input === 'hold' && nextPress.holding) this.active.push(nextPress);
      else this.onRelease?.(nextPress.button, nextPress);
    }
    return events;
  }
}
