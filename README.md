# KIVA THE KARATE（空手の型 × 音ゲー 試作）

空手の型「セーパイ」の演武動画を題材に、音楽に合わせて ABXY ボタンを入力するWebゲームの試作です。
ビルド不要の静的サイト（ES Modules）。限定公開は Cloudflare Workers の認証ゲート経由（`DEPLOY.md`）。

## 現在の状態

| 項目 | 状態 |
|---|---|
| 判定・AUTO・音声時刻同期・一時停止/再開 | 実装済み・検証済み（合成データ） |
| ABXY ひし形UI・GameSir/XInput/標準ゲームパッド・キャリブレーション | 実装済み（モック検証のみ。実機未確認） |
| 疑似3Dステージ・VFX（WebGL2 / Canvas2D フォールバック）・画質切替 | 実装済み（合成データで見た目確認。実素材での確認は未実施） |
| 縦横・タブレット・PC レイアウト | 11 サイズ + 回転で自動検証（実機未確認） |
| パスワード認証（Cloudflare Worker） | 実装済み・ローカル workerd で検証。**本番デプロイ・DNS は未実施** |
| 人物画像 412 枚の品質改善 | **未着手**（実素材がこの作業環境にないため） |
| 譜面 `charts/seipai.chart.json` | 23件の未校正の動作候補。技名・分類・決め時刻は未検証（正解データとして使用不可） |

## 起動

```sh
npm ci
npm start                       # http://localhost:8177/  （実素材の配置は ASSET_SETUP.md）
npm test                        # 単体テスト（判定・AUTO・時計・入力割り当て・VFX/ステージ・認証）
# 以下はブラウザ検証（npm start を別ターミナルで起動しておく。CHROME_PATH で Chromium を指定可）
npm run test:sync               # 一時停止/再開/リスタートの時刻検証（時刻の強制変更なし）
npm run test:e2e                # AUTO 全編・MANUAL 判定・レイアウト・読み込み失敗表示
npm run test:fallback           # WebGL2 非対応時の Canvas2D 切替・画質切替の連続性
CHART=tests/fixtures/synthetic/chart.json npm run test:layout   # 11 画面サイズ + 回転
npm run shots                   # PERFECT/GOOD/MISS 等の確認用スクリーンショット（見た目専用）
```

`tests/fixtures/synthetic/` は検証専用の合成データ（番号付きの棒人間とメトロノーム音）で、ゲーム素材ではありません。

URL パラメータ: `?mode=manual` / `?debug`（時刻・フレーム・描画負荷）/ `?quality=CINEMATIC|NORMAL|PERFORMANCE` /
`?canvas2d`（Canvas2D 強制）/ `?perfect=80&good=150`（判定幅 ms）/ `?chart=...`（別の譜面）

## 操作

| ボタン（ひし形の位置） | キーボード | ゲームパッド（標準配置） |
|---|---|---|
| Y（上） | ↑ / I / W | ボタン3（Y）・十字上 |
| X（左） | ← / J / A | ボタン2（X）・十字左 |
| B（右） | → / L / D | ボタン1（B）・十字右 |
| A（下） | ↓ / K / S | ボタン0（A）・十字下 |

開始・停止: Space ／ 最初から: R。画面のボタンはタッチ・クリック可。
ゲームパッドが標準配置で認識されない場合は、操作欄の「ボタン設定」で4ボタンを押して割り当てます（端末ごとに保存）。
譜面のコマンドとボタンの対応は `src/controls.js` で一元管理（譜面の `commands[].button` で変更可）。

## 構成

| ファイル | 役割 |
|---|---|
| `src/clock.js` | 音声再生位置＝共通の基準時刻（停止中は聞こえていた位置で固定） |
| `src/judge.js` / `src/auto.js` | 判定（重複防止）／AUTO 入力（共通判定へ予定時刻で入力） |
| `src/controls.js` / `src/input.js` | ボタン⇔コマンドの一元表／キー・タッチ・ゲームパッド入力 |
| `src/ui/controller-ui.js` / `src/ui/pad-panel.js` | ABXY ひし形ボタン／接続状態・割り当て・キャリブレーション |
| `src/chart.js` / `src/timewarp.js` | 譜面の検証／音声時刻→元動画時刻（決め＝判定時刻） |
| `src/frames.js` / `src/character.js` | 画像の取得・限定デコード／人物の共通カメラ・接地点 |
| `src/stage/` | 疑似3Dステージの空間計算・柱やゲート |
| `src/vfx/` | 技成立演出（PERFECT/GOOD/MISS、技カテゴリー別）。時刻の解析式で計算 |
| `src/gfx/` | WebGL2 / Canvas2D レンダラー、画質プリセット、シーン統合 |
| `src/track.js` / `src/game.js` | 譜面レーン／全体の進行・UI |
| `worker/index.js` / `wrangler.jsonc` | 限定公開の認証ゲート（`DEPLOY.md`） |

譜面形式は `charts/README.md`。技カテゴリー別演出は `moves[].vfx`（`generic|tsuki|uke|keri|fumikomi|kime`）で指定し、
未確認の動作は `generic` のままにします。
