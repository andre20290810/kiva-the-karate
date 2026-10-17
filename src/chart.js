// 譜面データの検証と、実行時に使う形への展開（純粋ロジック）。
// 譜面 JSON の形式は charts/README.md を参照。

import { buildWarp } from './timewarp.js';

export const FX_TYPES = ['impact', 'arc', 'ripple', 'flash'];

export function validateChart(chart) {
  const errors = [];
  const warnings = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(chart && typeof chart === 'object', '譜面が JSON オブジェクトではありません');
  if (errors.length) return { errors, warnings };
  need(Array.isArray(chart.commands) && chart.commands.length === 4, 'commands は4種類必要です');
  need(Array.isArray(chart.moves), 'moves がありません');
  need(Array.isArray(chart.notes), 'notes がありません');
  need(typeof chart.audio === 'string' || (Array.isArray(chart.audio) && chart.audio.length > 0), 'audio（音声ファイルのパス）がありません');
  need(typeof chart.frames === 'string', 'frames（フレーム定義のパス）がありません');
  if (errors.length) return { errors, warnings };

  const cmdIds = new Set(chart.commands.map((c) => c.id));
  const moves = new Map();
  for (const m of chart.moves) {
    if (moves.has(m.id)) errors.push(`動作ID ${m.id} が重複しています`);
    moves.set(m.id, m);
    const s = m.src || {};
    if (!(s.start <= s.kime && s.kime <= s.end)) {
      errors.push(`動作 ${m.id}: src は start <= kime <= end である必要があります`);
    }
    for (const fx of m.fx || []) {
      if (!FX_TYPES.includes(fx.type)) errors.push(`動作 ${m.id}: 未知のエフェクト ${fx.type}`);
    }
  }
  const noteIds = new Set();
  let prev = null;
  for (const n of chart.notes) {
    if (noteIds.has(n.id)) errors.push(`ノーツID ${n.id} が重複しています`);
    noteIds.add(n.id);
    if (!cmdIds.has(n.cmd)) errors.push(`ノーツ ${n.id}: 未定義のコマンド ${n.cmd}`);
    const m = moves.get(n.move);
    if (!m) { errors.push(`ノーツ ${n.id}: 未定義の動作 ${n.move}`); continue; }
    if (!(typeof n.t === 'number' && n.t >= 0)) errors.push(`ノーツ ${n.id}: 判定時刻 t が不正です`);
    if (prev) {
      if (n.t <= prev.t) errors.push(`ノーツ ${n.id}: 判定時刻が前のノーツ以前です（時刻順に並べてください）`);
      const pm = moves.get(prev.move);
      if (pm && m.src.kime < pm.src.kime) errors.push(`ノーツ ${n.id}: 元動画の決め時刻が前の動作より前です（型の順序が逆転）`);
      if (n.t - prev.t < 0.2) warnings.push(`ノーツ ${prev.id}→${n.id} の間隔が 0.2 秒未満です`);
    }
    prev = n;
  }
  return { errors, warnings };
}

/**
 * 実行時データに展開する。
 * @param {object} chart
 * @param {number} audioDuration 音声の長さ（秒）
 * @param {number} videoDuration 元動画の長さ（秒、フレーム定義から）
 */
export function compileChart(chart, audioDuration, videoDuration) {
  const { errors, warnings } = validateChart(chart);
  if (errors.length) {
    const e = new Error('譜面エラー:\n' + errors.join('\n'));
    e.details = errors;
    throw e;
  }
  const moves = new Map(chart.moves.map((m) => [m.id, m]));
  const offset = chart.audioOffset || 0; // 音声と元動画の時刻差（通常0: 同じ動画から抽出）
  const notes = chart.notes.map((n) => {
    const m = moves.get(n.move);
    return {
      id: n.id,
      t: n.t,
      cmd: n.cmd,
      move: m,
      fx: n.fx || m.fx || [],
      hold: n.hold ?? m.hold,
    };
  });
  const anchors = notes.map((n) => ({ t: n.t, kime: n.move.src.kime, hold: n.hold }));
  const warp = buildWarp(
    anchors,
    {
      start: { t: 0, v: Math.max(0, 0 - offset) },
      end: { t: audioDuration, v: Math.min(videoDuration, audioDuration - offset) },
    },
    chart.warp || {},
  );
  return {
    title: chart.title,
    commands: chart.commands,
    notes,
    warp,
    warnings: [...warnings, ...warp.warnings],
    windows: chart.windows,
    camera: chart.camera,
    frameFixes: chart.frameFixes || [],
  };
}
