// 視覚エフェクト。時刻はすべて音声の再生位置（秒）で管理するため、
// 一時停止中は止まり、再開後にまとめて発生することもない。
// 位置は「元画像座標」で受け取り、描画時に camera で画面座標へ変換する。

const DUR = { impact: 0.28, arc: 0.38, ripple: 0.45, flash: 0.18, afterimage: 0.32, combo: 0.6 };

export class Effects {
  constructor() { this.items = []; }

  clear() { this.items = []; }

  /**
   * @param {string} type impact|arc|ripple|flash|afterimage|combo
   * @param {number} t 発生する音声時刻（未来でもよい: 決めの瞬間に合わせて予約）
   * @param {object} p 位置などのパラメータ（元画像座標 x,y）
   */
  spawn(type, t, p = {}) {
    this.items.push({ type, t, dur: DUR[type] ?? 0.3, ...p });
  }

  /** 古すぎる予約（タブ復帰や巻き戻し後）を捨てる */
  prune(now) {
    this.items = this.items.filter((e) => now < e.t + e.dur && e.t < now + 1.0);
  }

  /**
   * @param {CanvasRenderingContext2D} g
   * @param {number} now
   * @param {{toScreen:(x:number,y:number)=>{x:number,y:number}, scale:number}} cam
   * @param {(e:object, alpha:number)=>void} drawAfterimage 残像描画コールバック（人物の後ろ）
   */
  drawBehind(g, now, cam, drawAfterimage) {
    for (const e of this.items) {
      if (e.type !== 'afterimage') continue;
      const k = (now - e.t) / e.dur;
      if (k < 0 || k > 1) continue;
      drawAfterimage(e, 1 - k);
    }
  }

  drawFront(g, now, cam, view) {
    this.prune(now);
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const e of this.items) {
      const k = (now - e.t) / e.dur;
      if (k < 0 || k > 1) continue;
      const ease = 1 - (1 - k) ** 3;
      const a = 1 - k;
      const s = cam.scale;
      const c = e.x != null ? cam.toScreen(e.x, e.y) : null;
      const col = e.color || '255,220,140';
      switch (e.type) {
        case 'impact': {
          // 手元からの短い衝撃波 + 閃光
          const r = (18 + 90 * ease) * s;
          g.strokeStyle = `rgba(${col},${0.9 * a})`;
          g.lineWidth = Math.max(1.5, 6 * s * a);
          g.beginPath(); g.arc(c.x, c.y, r, 0, Math.PI * 2); g.stroke();
          const n = 10;
          g.lineWidth = Math.max(1, 3 * s * a);
          for (let i = 0; i < n; i++) {
            const ang = (i / n) * Math.PI * 2 + (e.seed || 0);
            const r0 = r * 0.6, r1 = r * 1.15;
            g.beginPath();
            g.moveTo(c.x + Math.cos(ang) * r0, c.y + Math.sin(ang) * r0);
            g.lineTo(c.x + Math.cos(ang) * r1, c.y + Math.sin(ang) * r1);
            g.stroke();
          }
          if (k < 0.35) {
            const fr = 40 * s * (1 - k / 0.35);
            const grd = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, fr * 2);
            grd.addColorStop(0, `rgba(255,255,255,${0.9 * (1 - k / 0.35)})`);
            grd.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = grd;
            g.beginPath(); g.arc(c.x, c.y, fr * 2, 0, Math.PI * 2); g.fill();
          }
          break;
        }
        case 'arc': {
          // 受け: 腕付近の円弧状の光
          const r = (60 + 30 * ease) * s;
          const dir = e.dir ?? -Math.PI / 2;
          const span = Math.PI * (0.5 + 0.5 * ease);
          g.strokeStyle = `rgba(${e.color || '140,210,255'},${0.95 * a})`;
          g.lineWidth = Math.max(2, 9 * s * a);
          g.lineCap = 'round';
          g.beginPath(); g.arc(c.x, c.y, r, dir - span / 2, dir + span / 2); g.stroke();
          g.lineWidth = Math.max(1, 3 * s * a);
          g.beginPath(); g.arc(c.x, c.y, r * 1.2, dir - span / 2.5, dir + span / 2.5); g.stroke();
          break;
        }
        case 'ripple': {
          // 踏み込み: 足元の短い波紋（遠近を出すため楕円）
          for (let i = 0; i < 2; i++) {
            const kk = Math.max(0, ease - i * 0.2);
            const rx = (30 + 150 * kk) * s, ry = rx * 0.22;
            g.strokeStyle = `rgba(${e.color || '255,200,120'},${0.8 * a * (1 - i * 0.4)})`;
            g.lineWidth = Math.max(1, 4 * s * a);
            g.beginPath(); g.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2); g.stroke();
          }
          break;
        }
        case 'flash': {
          // 画面周辺だけを光らせ、人物は隠さない
          const grd = g.createRadialGradient(view.w / 2, view.h / 2, Math.min(view.w, view.h) * 0.35, view.w / 2, view.h / 2, Math.max(view.w, view.h) * 0.75);
          grd.addColorStop(0, 'rgba(255,255,255,0)');
          grd.addColorStop(1, `rgba(${col},${0.35 * a})`);
          g.fillStyle = grd;
          g.fillRect(0, 0, view.w, view.h);
          break;
        }
        default: break;
      }
    }
    g.restore();
  }
}
