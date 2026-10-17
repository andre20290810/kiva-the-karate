# KIVA THE KARATE（空手の型 × 音ゲー 試作）

空手の型「セーパイ」の演武動画を題材にした、音楽に合わせてコマンドを入力するWebプロトタイプです。
ビルド不要の静的サイトです（ES Modules）。依存パッケージはありません。

## 現在の状態

| 項目 | 状態 |
|---|---|
| 判定・AUTO・入力・時刻同期・描画・エフェクト・UI | 実装済み（自動テスト 21件） |
| 素材（元動画・透過PNG ZIP） | ローカルPCに取得・変換済み。公開リポジトリには未収録 |
| 譜面 `charts/seipai.chart.json` | 23件の未校正の動作候補。正解データとして使用不可 |

実素材の準備・再生成手順と公開前の確認事項は `ASSET_SETUP.md` を参照してください。素材がない状態で起動すると不足ファイルを画面に表示します。

## 素材の配置

```
kiva-the-karate/
  source/                       ← 元素材を置く（git には含めない）
    seipai.mp4                  元動画
    seipai_frames.zip          412枚ZIP（展開後に変換）
  assets/seipai/                ← tools で生成する
    audio.m4a                   元動画から抽出した音声
    frames.json                 manifest.json から生成したフレーム定義
    frames/*.webp               透過画像（圧縮済み）
    beats.json, beats_click.m4a 拍解析の候補と確認用クリック音声
  charts/seipai.chart.json      譜面（手動で編集する）
```

手順（素材の確認後に整備します）:

```sh
sh tools/extract_audio.sh source/seipai.mp4 assets/seipai
python3 -I tools/analyze_beats.py assets/seipai/audio.m4a assets/seipai/beats.json
# beats_click.m4a を実際に聴いて、拍の候補が合っているか確認する
```

## 起動

```sh
cd kiva-the-karate
node tools/serve.mjs 8080      # http://localhost:8080/
npm test                       # 判定・AUTO・時刻写像の自動テスト
node tests/e2e.mjs [譜面]      # ブラウザ通し確認（Playwright。サーバー起動後に実行）
```

`tests/fixtures/synthetic/` は E2E テスト専用の合成データ（番号付きの図形とメトロノーム音）です。
ゲームの素材ではありません。

URL パラメータ:
- `?mode=manual` … MANUAL で起動
- `?debug` … 再生位置・元動画時刻・フレーム番号・再生速度を表示
- `?perfect=80&good=150` … 判定幅（ms）を変更
- `?chart=charts/xxx.json` … 別の譜面（別の型・曲）を読み込む

## 操作

| 操作 | キーボード | 画面 | ゲームパッド（Standard配置） |
|---|---|---|---|
| コマンド1〜4 | D F J K ／ ← ↓ ↑ → | 下部（横画面は右）の4ボタン | X A Y B ／ 十字キー 左 下 上 右 |
| 開始・一時停止・再開 | Space | 開始／一時停止ボタン | — |
| 最初から | R | 最初からボタン | — |

## 構成

| ファイル | 役割 |
|---|---|
| `src/clock.js` | 音声再生位置＝共通の基準時刻（AudioContext） |
| `src/chart.js` | 譜面の検証・展開 |
| `src/timewarp.js` | 音声時刻→元動画時刻の写像（決め＝判定時刻、ポーズ保持、逆再生なし） |
| `src/judge.js` | 判定（PERFECT/GOOD/MISS、重複防止） |
| `src/auto.js` | AUTO入力（予定時刻ちょうどを共通判定へ） |
| `src/input.js` | キーボード／タッチ／ゲームパッド → 4種の論理コマンド |
| `src/frames.js` | 画像の取得（1回のみ）と、前後数十枚に限ったデコード |
| `src/renderer.js` | ステージ・人物（共通カメラ）描画 |
| `src/track.js` | 譜面レーン |
| `src/effects.js` | 衝撃波・円弧・波紋・閃光・残像 |
| `src/game.js` | 全体の進行・UI |

譜面形式は `charts/README.md` を参照。
