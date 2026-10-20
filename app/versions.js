// ゲームのバージョン（素材・譜面・音声の組）。ゲームのコードは共通で、ここで選んだ組を読み込む。
// 保存先（自動保存・プレイ記録）はバージョンごとに分ける。ver1 は従来のキーをそのまま使う（既存の保存内容を引き継ぐ）。

export const GAME_VERSIONS = Object.freeze({
  v1: Object.freeze({
    id: 'v1', label: 'ver1', name: 'セーパイ（2026-10-10 撮影）',
    chart: 'charts/seipai.json',
    keys: Object.freeze({ autosave: 'kiva2d.chart.autosave.v1', best: 'kiva2d.best.manual' }),
  }),
  v2: Object.freeze({
    id: 'v2', label: 'ver2', name: 'セーパイ（2026-10-20 撮影）',
    chart: 'charts/seipai_v2.json',
    keys: Object.freeze({ autosave: 'kiva2d.v2.chart.autosave', best: 'kiva2d.v2.best.manual' }),
  }),
});
export const DEFAULT_VERSION = 'v1';
export const VERSION_KEY = 'kiva2d.gameVersion';

/** "v2" / "2" / "ver2" → "v2"。知らない値は null */
export function parseVersion(v) {
  if (v == null) return null;
  const m = /^(?:ver|v)?\s*(\d+)$/i.exec(String(v).trim());
  const id = m ? `v${m[1]}` : null;
  return id && GAME_VERSIONS[id] ? id : null;
}

/** URL（?v=）→ 最後に選んだバージョン → 既定 の順に決める */
export function resolveVersion(params, stored) {
  return parseVersion(params?.get?.('v')) || parseVersion(stored) || DEFAULT_VERSION;
}
