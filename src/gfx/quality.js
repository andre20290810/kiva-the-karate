// 描画品質プリセット。演出の派手さ・背景速度・負荷はすべてここの設定値で調整する。

export const QUALITY_PRESETS = Object.freeze({
  PERFORMANCE: {
    label: 'PERFORMANCE（低負荷）',
    dprCap: 1.25,
    maxParticles: 450,
    particleScale: 0.45,
    bloom: false,
    chroma: false,
    reflection: false,
    rimLight: false,
    dust: 30,
    pillars: 6,
    gates: 3,
    shake: 0.6,
    floorSpeed: 3.2,      // 床の流れる速さ（ワールド単位/秒）
    floorBoost: 5,        // 技成立時の一瞬の加速
    fog: 0.055,
    afterimages: 1,
  },
  NORMAL: {
    label: 'NORMAL（標準）',
    dprCap: 2,
    maxParticles: 1400,
    particleScale: 1,
    bloom: true,
    bloomStrength: 0.75,
    chroma: true,
    reflection: true,
    rimLight: true,
    dust: 90,
    pillars: 10,
    gates: 5,
    shake: 1,
    floorSpeed: 3.6,
    floorBoost: 9,
    fog: 0.045,
    afterimages: 3,
  },
  CINEMATIC: {
    label: 'CINEMATIC（演出強化）',
    dprCap: 2,
    maxParticles: 2600,
    particleScale: 1.5,
    bloom: true,
    bloomStrength: 1.1,
    chroma: true,
    reflection: true,
    rimLight: true,
    dust: 160,
    pillars: 12,
    gates: 6,
    shake: 1.35,
    floorSpeed: 4.2,
    floorBoost: 13,
    fog: 0.04,
    afterimages: 4,
  },
});

export function pickQuality(name, { webgl2 = true, lowMemory = false } = {}) {
  if (name && QUALITY_PRESETS[name]) return { name, ...QUALITY_PRESETS[name] };
  const auto = !webgl2 || lowMemory ? 'PERFORMANCE' : 'NORMAL';
  return { name: auto, ...QUALITY_PRESETS[auto] };
}

/** 実測 FPS が下がり続けたら一段階下げる（判定や音声には影響しない） */
export class FrameRateGovernor {
  constructor({ window = 90, lowFps = 40 } = {}) {
    this.window = window;
    this.lowFps = lowFps;
    this.samples = [];
    this.fps = 60;
  }

  sample(dtMs) {
    if (!(dtMs > 0 && dtMs < 1000)) return null;
    this.samples.push(dtMs);
    if (this.samples.length > this.window) this.samples.shift();
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    this.fps = 1000 / avg;
    if (this.samples.length >= this.window && this.fps < this.lowFps) {
      this.samples = [];
      return 'degrade';
    }
    return null;
  }
}
