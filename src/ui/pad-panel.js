// ゲームパッドの接続状態・認識デバイス名・割り当て・押下中のボタン表示と、簡易キャリブレーション。

import { FACE, FACE_BUTTONS, invertProfile } from '../controls.js';

const STEPS = ['Y', 'X', 'B', 'A'];

export class PadPanel {
  /**
   * @param {HTMLElement} root
   * @param {import('../input.js').InputRouter} input
   * @param {ReturnType<import('../controls.js').buildControlMap>} map
   */
  constructor(root, input, map) {
    this.root = root;
    this.input = input;
    this.map = map;
    this.calib = null;
    root.innerHTML = `
      <div class="padHead"><span class="dot"></span><span class="padName">ゲームパッド: 未接続</span></div>
      <div class="padMap"></div>
      <div class="padRow"><button type="button" class="calib">ボタン設定</button><button type="button" class="reset" hidden>標準に戻す</button></div>
      <div class="calibBox" hidden><div class="calibMsg"></div><button type="button" class="cancel">中止</button></div>`;
    this.el = {
      dot: root.querySelector('.dot'), name: root.querySelector('.padName'), map: root.querySelector('.padMap'),
      calib: root.querySelector('.calib'), reset: root.querySelector('.reset'), box: root.querySelector('.calibBox'),
      msg: root.querySelector('.calibMsg'), cancel: root.querySelector('.cancel'),
    };
    this.el.calib.addEventListener('click', () => this.startCalibration());
    this.el.cancel.addEventListener('click', () => this.stopCalibration('中止しました'));
    this.el.reset.addEventListener('click', () => {
      const p = this.input.gamepads[0];
      if (p) { this.input.profiles.clear(p.id); this.update(); }
    });
    this.update();
  }

  update() {
    const pads = this.input.gamepads;
    const p = pads[0];
    this.root.dataset.connected = p ? '1' : '0';
    if (!p) {
      this.el.name.textContent = 'ゲームパッド: 未接続（接続後にボタンを1回押すと認識されます）';
      this.el.map.innerHTML = '';
      this.el.calib.disabled = true;
      this.el.reset.hidden = true;
      return;
    }
    this.el.calib.disabled = false;
    this.el.name.textContent = `${p.vendor}：${p.id.slice(0, 60)}${pads.length > 1 ? `（他 ${pads.length - 1} 台）` : ''}`;
    const profile = this.input.profiles.get(p.id, p.mapping);
    const inv = invertProfile(profile);
    const idxOf = (b) => [...inv.entries()].filter(([, v]) => v === b).map(([k]) => k);
    const mapLabel = profile.name === 'calibrated' ? '保存した設定' : p.standard ? '標準配置（Standard Gamepad）' : '非標準配置：ボタン設定を推奨';
    this.el.map.innerHTML = `<div class="mapKind${!p.standard && profile.name !== 'calibrated' ? ' warn' : ''}">${mapLabel}</div>` +
      FACE_BUTTONS.map((b) => {
        const on = p.pressedButtons.includes(b);
        return `<span class="chip${on ? ' on' : ''}" style="--c:${FACE[b].color}"><b>${b}</b>#${idxOf(b).join('/')}</span>`;
      }).join('') + `<span class="raw">押下中: ${p.pressedIdx.length ? p.pressedIdx.map((i) => `#${i}`).join(' ') : 'なし'}</span>`;
    this.el.reset.hidden = profile.name !== 'calibrated';
  }

  startCalibration() {
    const p = this.input.gamepads[0];
    if (!p) return;
    this.calib = { id: p.id, index: p.index, step: 0, got: {} };
    this.el.box.hidden = false;
    this.prompt();
    this.input.capture = ({ pad, index }) => {
      if (!this.calib || pad.index !== this.calib.index) return;
      if (Object.values(this.calib.got).includes(index)) { this.el.msg.textContent = `#${index} は設定済みです。別のボタンを押してください`; return; }
      this.calib.got[STEPS[this.calib.step]] = index;
      this.calib.step++;
      if (this.calib.step >= STEPS.length) {
        try {
          this.input.profiles.set(this.calib.id, this.calib.got);
          this.stopCalibration('保存しました');
        } catch (e) { this.stopCalibration(`保存できません: ${e.message}`); }
      } else this.prompt();
    };
  }

  prompt() {
    const b = STEPS[this.calib.step];
    const pos = { up: '上', left: '左', right: '右', down: '下' }[FACE[b].pos];
    this.el.msg.innerHTML = `<b style="color:${FACE[b].color}">${b}</b>（ひし形の${pos}）のボタンを押してください（${this.calib.step + 1}/4）`;
  }

  stopCalibration(msg) {
    this.input.capture = null;
    this.calib = null;
    this.el.msg.textContent = msg;
    setTimeout(() => { if (!this.calib) this.el.box.hidden = true; }, 1500);
    this.update();
  }
}
