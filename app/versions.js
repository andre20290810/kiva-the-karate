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
    keys: Object.freeze({ autosave: 'kiva2d.v2.chart.autosave', best: 'kiva2d.v2.best.manual', audio: 'kiva2d.v2.audio' }),
    // BGM（時間軸の 0 秒 = 曲の先頭。演武の終わりで短くフェードアウト）。配信用は 85 秒に切り詰めた AAC と予備の Opus。
    // gainDb: 曲ごとの音量合わせ（原本のラウドネスを -18 LUFS にそろえる。原本は変えない）
    bgm: Object.freeze([
      Object.freeze({ id: 'devil', label: 'Devil In The Fire', original: 'Devil In The Fire0.0(1).mp3', gainDb: -4.7,
        src: ['assets/seipai_v2/bgm/devil.m4a', 'assets/seipai_v2/bgm/devil.opus.m4a'] }),
      Object.freeze({ id: 'spear', label: 'AUTODRIVING THE SPEAR', original: 'AUTODRIVING THE SPEAR 1.1.wav', gainDb: -1.9,
        src: ['assets/seipai_v2/bgm/spear.m4a', 'assets/seipai_v2/bgm/spear.opus.m4a'] }),
      Object.freeze({ id: 'uprising', label: 'UPRISING OVERDRIVE VORTEX', original: 'uprising-overdrive-vortex1.0(2).mp3', gainDb: -4.9,
        src: ['assets/seipai_v2/bgm/uprising.m4a', 'assets/seipai_v2/bgm/uprising.opus.m4a'] }),
    ]),
    defaultBgm: 'devil',
    // 初期音量（0〜1）。効果音が聞こえ、3 つ重ねても割れない値（最後にリミッター）
    defaultLevels: Object.freeze({ voice: 0.8, bgm: 0.4, sfx: 0.9 }),
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
