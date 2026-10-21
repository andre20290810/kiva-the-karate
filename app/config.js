// 正式版（旧 ver2、2026-10-20 撮影）の素材・譜面・音声・保存先。ver1 は終了（タグ ver1 / コミット f723a71 で復元できる）。
// 保存先のキーと素材のパスは旧 ver2 のまま（ブラウザに保存された編集内容・記録・BGM と音量の設定をそのまま引き継ぐ）。

export const GAME = Object.freeze({
  gameVersion: 'v2', // 譜面 JSON に書く値（旧 ver2 の JSON をそのまま読み書きできるように）
  name: 'セーパイ（2026-10-20 撮影）',
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
  // 初期音量（0〜1）。効果音は 0（設定で上げる）。3 つを重ねても割れない（最後にリミッター）
  defaultLevels: Object.freeze({ voice: 0.8, bgm: 0.4, sfx: 0 }),
  // 効果音の音量を一度だけ 0 に戻す（既存の保存内容にも適用。BGM・元動画の音声は変えない）。値を変えると再び一度だけ適用される
  sfxResetId: '2026-10-21-sfx-zero',
  // ノーツ・レーン・操作パネルの文字（入力の割り当て Y・X・A・B は変えない）
  glyphs: Object.freeze({ Y: '息', X: '構', A: '撃', B: '旋' }),
});
