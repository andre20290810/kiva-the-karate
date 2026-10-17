// AUTO 入力。各ノーツの予定時刻そのものを入力時刻として Judge.input() に渡す。
// 描画が遅れても「入力時刻 = ノーツ時刻」なので判定は常に PERFECT（delta=0）になる。
// 1ノーツにつき1回だけ発火し、入力IDで二重処理も防ぐ。

export class AutoPlayer {
  /** @param {import('./judge.js').Judge} judge */
  constructor(judge, { generation = 0 } = {}) {
    this.judge = judge;
    this.generation = generation;
    this.queue = [...judge.notes].sort((a, b) => a.t - b.t);
    this.cursor = 0;
    this.fired = 0;
  }

  /**
   * 現在の音声時刻までに到来したノーツを入力する。
   * Judge.update()（MISS 判定）より先に呼ぶこと。
   */
  update(songTime) {
    const events = [];
    while (this.cursor < this.queue.length && this.queue[this.cursor].t <= songTime) {
      const n = this.queue[this.cursor++];
      const ev = this.judge.input({
        cmd: n.cmd,
        time: n.t,
        source: 'auto',
        id: `auto:${this.generation}:${n.id}`,
      });
      if (ev) { this.fired++; events.push(ev); }
    }
    return events;
  }
}
