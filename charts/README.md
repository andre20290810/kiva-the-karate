# 譜面形式（*.chart.json）

時刻はすべて秒。`t` は **音声上の判定時刻**、`src.*` は **元動画上の時刻** です。
同じ動画から抽出した音声なら、両者は `audioOffset` = 0 で一致します。

```jsonc
{
  "title": "セーパイ（試作譜面）",
  "audio": "../assets/seipai/audio.m4a",      // この JSON からの相対パス
  "frames": "../assets/seipai/frames.json",
  "audioOffset": 0,
  "windows": { "perfect": 0.08, "good": 0.15 }, // 省略時は既定値
  "warp": { "maxHoldRatio": 0.6, "minRate": 0.5, "maxRate": 1.8 },
  "commands": [                                  // 必ず4種。順番がレーン番号（キー／ボタン対応）
    { "id": "A", "label": "突", "name": "手技", "color": "#ffb14a", "keyHint": "D / ←" }
  ],
  "camera": {                                    // 省略時: 全フレームの人物領域の和集合に合わせる
    "margin": 0.06,
    "keys": [ { "t": 0, "box": [x, y, w, h] } ]  // 区間ごとの注視枠（元画像座標）。間は補間
  },
  "moves": [
    {
      "id": "move01", "name": "動作01",          // 技名が確認できない間は仮名
      "src": { "start": 3.2, "kime": 3.8, "end": 4.4 },   // 元動画の開始／決め／終了
      "frames": [16, 22],                        // 使用する画像範囲（記録用）
      "hold": 0.25,                              // 決めポーズの保持（省略時は自動）
      "fx": [
        { "type": "impact", "at": { "joint": "right_wrist" } },     // 関節推定位置
        { "type": "ripple", "at": { "rel": [0.5, 0.98] } },         // 人物領域内の相対位置
        { "type": "arc",    "at": { "x": 300, "y": 420 }, "dir": -1.57 } // 手動指定（元画像座標）
      ]
    }
  ],
  "notes": [
    { "id": "n001", "t": 3.85, "cmd": "A", "move": "move01" }  // fx を個別指定することも可
  ],
  "frameFixes": [
    { "frame": 123, "use": 122, "reason": "背景残り" }       // 不良コマの置き換え記録
  ]
}
```

エフェクト種別: `impact`（手元の衝撃波・閃光）, `arc`（受けの円弧）, `ripple`（足元の波紋）, `flash`（画面周辺の光）。

位置の優先順位: `x,y`（手動）＞ `joint`（信頼度 `minConf` 以上のとき）＞ `rel`（人物領域の相対位置）。
