// ABXY ひし形の操作ボタン。配置・色・文字はすべて controls.js の一元表から作る。
// 押下状態はタッチだけでなくキーボード・ゲームパッドの押下も反映する。

import { FACE_BUTTONS } from '../controls.js';

export class ControllerUI {
  /**
   * @param {HTMLElement} root
   * @param {ReturnType<import('../controls.js').buildControlMap>} map
   */
  constructor(root, map) {
    this.root = root;
    this.map = map;
    this.buttons = {};
    root.innerHTML = '';
    root.classList.add('diamond');
    for (const b of FACE_BUTTONS) {
      const e = map.byButton.get(b);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `face face-${e.pos}`;
      el.dataset.button = b;
      el.style.setProperty('--c', e.color);
      el.style.setProperty('--g', e.glow);
      el.setAttribute('aria-label', `${b} ボタン（${e.name}）`);
      el.innerHTML = `<span class="ring"></span><span class="cap"><span class="glyph">${b}</span><span class="sub">${escapeHtml(e.label)}</span></span><span class="burst"></span>`;
      root.appendChild(el);
      this.buttons[b] = el;
    }
  }

  setHeld(button, down) {
    this.buttons[button]?.classList.toggle('held', down);
  }

  /** 判定結果のフィードバック（ボタンが光る / 失敗は寒色で短く） */
  flash(button, grade) {
    const el = this.buttons[button];
    if (!el) return;
    el.classList.remove('hit-PERFECT', 'hit-GOOD', 'hit-MISS');
    void el.offsetWidth; // アニメーションを再開
    el.classList.add(`hit-${grade}`);
  }

  setDimmed(dim) { this.root.classList.toggle('auto', dim); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
