# KIVA THE KARATE — セーパイ（2D・実写連続画像）

中央の人物（背景透過の実写連続画像 412 枚、0.2 秒間隔）の型を見ながら、動きに合うコマンド（Y 呼吸／X 構え／A 打撃／B 旋回）を
入力するリズムゲームです。成功すると人物に重なるエフェクトが出ます。譜面は編集モードで何度でも調整でき、JSON で保存できます。

旧版の 3D 表示（人体モデル・3D シーン・表示切替）は廃止しました。ページは `app/` だけを読み込み、公開用の `dist/` にも 3D の
コード・素材は入りません（`tools/build-dist.mjs` が検査）。

## 起動

```bat
npm install            :: playwright-core（ブラウザ確認用）だけ
npm start              :: http://localhost:8177/
npm test               :: 判定・長押し・AUTO・JSON 検証・配置の単体テスト
npm run test:browser   :: 実素材でのブラウザ確認（npm start を別に起動しておく）
```
`?fresh=1` を付けると、自動保存した編集内容を使わずに初期譜面で起動します。

## 素材の配置（公開リポジトリには含めない。`assets/` `source/` は Git 管理外）

| 用途 | 置き場所 | 作り方 |
|---|---|---|
| 人物 | `assets/seipai/manifest.json`、`assets/seipai/cut/frame_0000.webp`〜`0411.webp` | 提供 ZIP から下のコマンドで作る |
| 横向きの背景 | `assets/stage/IMG_7441.JPG`（1792×1008） | 提供画像をそのまま置く |
| 縦向きの背景 | `assets/stage/IMG_7439.JPG`（784×1168） | 提供画像をそのまま置く |
| 音声（任意） | `assets/seipai/audio.m4a` | `sh tools/extract_audio.sh source/seipai.mp4 assets/seipai`。無ければ効果音だけで進行 |

```bat
pip install opencv-python numpy mediapipe
:: ZIP の検査・展開・素材の作り直し・確認画像（source\ingest_report\）までまとめて行う
python tools\frames-2d\ingest.py --zip source\seipai_transparent_412frames.zip --model pose_landmarker_heavy.task
:: （drive.google.com に接続できる環境なら --zip の代わりに --download 1Mt_DYiGNyEWi5bpO2JASFXAEe5r0LSWZ）
npm start
node tests\record-effects.mjs   :: 呼吸・構え・打ち・蹴り・旋回の確認動画と描画時間（ffmpeg が必要）
```
会話に添付できない大きさの ZIP は、PC で `powershell -ExecutionPolicy Bypass -File tools\frames-2d\split_zip.ps1 -Zip <ZIP>` で 20 MB ずつに
分けて部分と `.sha256.txt` を渡し、受け取り側で `python tools/frames-2d/join_parts.py --list <...>.sha256.txt --out source/seipai_transparent_412frames.zip`
（SHA-256 と ZIP の整合を確認してから結合）→ `ingest.py --zip` で取り込みます。

`ingest.py` は 412 枚・576×1024・アルファ・timestamps.csv を検査してから `prepare_frames.py` を実行し、
`source/ingest_report/` に中央配置の一覧（centered.jpg）、倍率の表（scale.csv）、譜面の A の打撃点と新しい関節の比較
（anchors.jpg・anchors.csv）、作り直し前の素材との差（manifest_diff.csv）、打撃点を新しい関節で置き換えた譜面の案（proposed_chart.json）を
出します。欠落・重複（同じ画素の画像）・時刻の不連続があれば止まります。譜面とブラウザに自動保存された編集内容は書き換えません
（`--rebuild-chart` のときだけ初期譜面を作り直す）。コマ単位の補正がある場合は見直し対象として一覧に出します。
- 時刻は `timestamps.csv` を優先。`--model`（MediaPipe Pose、無料・ローカル）があれば胴体の中心と手足の位置を関節から測り、
  無ければアルファから推定します（その場合、エフェクトの打撃点の自動設定は使えません）。
- 開発環境では提供 ZIP を取得できなかったため、元動画から人物を切り抜いた **代用素材**（`tools/frames-2d/standin_from_video.py`）で
  確認しています。代用素材の manifest には `standIn: true` が入り、画面に注意が出ます。`build-dist` は代用素材では公開用を作りません。
- 初期譜面の A の打撃点は代用素材の関節から作りました。本物の素材で作り直すと位置が少し変わる場合があるので、
  `python tools\chart\build_initial_chart.py --manifest assets\seipai\manifest.json --out charts\seipai.json` で作り直せます
  （編集済みの譜面がある場合は、作り直さずに編集モードで確認してください）。

## 画面

上から「背景付きのステージ」「操作パネル」。向きは表示領域の縦横比で決め（横長 = 横向きの背景、縦長 = 縦向きの背景）、
回転・リサイズしても再生位置・譜面の編集内容・AUTO は保たれます。背景は縦横比を保って全体を収め、余白は道場の色で塗ります。

- **人物の中央配置**: 各コマで胴体の中心（両肩と両腰の中点）を、背景が実際に表示される矩形の中央に置きます。
  離れた小さな塊（ゴミ・残った文字・床の反射）は基準にしません。
- **大きさ**: 直立時の全高が背景の高さの約 55%（`display.referenceHeightRatio`）。倍率はコマ共通で、撮影距離による体格の
  変化だけを胴の長さ（前後のコマで強く平滑化）で補正します。しゃがみ・蹴りで外接矩形が変わっても拡縮しません。
  全コマがレーンの下〜背景内に収まらない画面では、収まるところまで小さくします（縦横とも同じ規則）。
- **4 レーン**: 背景の上部に上から Y・X・A・B。右から左へ流れ、左の判定線で押します。ノーツの位置は「判定時刻までの残り時間 ÷
  先読み時間（`settings.laneLeadSeconds`）」で決めるので、縦横でレーンの長さが違ってもタイミングは同じです。
- **メモリ**: 切り出し済み WebP（合計 約 7 MB）を最初に全部取得し、デコード済み画像は再生位置の前後だけ（最大 48 枚）保持します。

## 操作

| 入力 | 意味 | 方式 |
|---|---|---|
| Y | 呼吸を整える | 長押し（開始の時刻・必要な時間の保持・早すぎる離しを判定） |
| X | 構える・構え直す | 単押し |
| A | 突き・蹴りなどの打撃（譜面の `action` で突き／蹴り／打ちを区別） | 単押し |
| B | 大きな向きの変更・旋回 | 単押し |

キーボード: Y X A B（押しっぱなしの自動リピートは無視）／ Space 開始・一時停止 ／ R リトライ。
画面のボタンはタッチとマウスの両方で使え、二重には数えません。ゲームパッド（標準配置）は **位置** で対応します:
上 = Y、左 = X、下 = A、右 = B（Nintendo 配置のコントローラーは印字と位置が違うので、画面のボタン名で確認してください）。
入力欄にフォーカスがある間、Y X A B はゲーム操作になりません。

判定の初期値: PERFECT ±60ms、GOOD ±120ms、許容限界 ±180ms（この外の入力は空振り）。設定パネルで変更でき、譜面 JSON に保存されます。
入力補正（`inputOffsetMs`）は ＋ にすると、押した時刻をその分だけ早い時刻として判定します（いつも LATE になる場合に ＋）。

**AUTO**: 譜面のノーツを予定時刻ちょうどの入力として、通常プレイと同じ判定処理に渡します（Y は押して保持して離す）。
画面に「AUTO 再生中」と出て、結果は手動プレイの記録と区別されます（手動の最高記録には入りません）。
途中で切り替えても、過去のノーツをまとめて成立させたり、押したままの Y が残ったりしません。

## 編集モード（「編集」ボタン）

- 再生／一時停止、シーク（スライダー・タイムラインのクリック）、1 コマ送り（← →、0.2 秒）、速度 1×・0.5×・0.25×
- タイムライン: 4 レーン、ノーツをクリックで選択（Shift で追加）、空いている所をドラッグで範囲選択、ノーツをドラッグで移動、
  長押しノーツの終端をドラッグで長さ変更、Ctrl+ホイールで拡大縮小。「コマにスナップ」は任意
- ノーツの欄: 時刻（0.01 秒単位）、ボタン、動作（A は突き／蹴り／打ち）、表示名、長押し時間、連続コマンド、
  エフェクト（種類・強さ・A の打撃点と方向。「画面で指定」でステージ上の拳・足をクリック、「関節から自動」もあり）
- 追加（現在位置に ＋Y／＋X／＋A／＋B）、複製、削除（Delete）、選択したノーツをまとめて早く／遅くずらす
- 連続コマンド: 選択したノーツを新しいまとまりにする／外す、名前の変更、一覧の並べ替え、まとまり内のコマンドの順番の入れ替え
  （「◀ 順番」「順番 ▶」: 時刻の並びはそのままで、隣のノーツとコマンドの中身を入れ替える）
- A–B ループ（ゲームの A・B ボタンとは別の「ループ開始」「ループ終了」）、区間内のノーツを選択
- 人物の位置・倍率のコマ単位の補正（下の `frameOverrides`）、直立時の高さ、人物の中心。補正欄に入力を始めると再生が止まり、
  入力を始めたコマが対象として固定されます（コマ送り・再生で値も対象も変わらない）。「このコマに適用」か「取り消し」で終わります
- 元に戻す／やり直す（Ctrl+Z／Ctrl+Y）、ブラウザ内への自動保存、初期譜面に戻す、JSON の書き出し・読み込み、編集メモ

シーク・ループ・リトライ・譜面の変更のたびに、その時刻以降のノーツの判定を初期化します（同じノーツを二重に加点しない、
前回の MISS が残らない）。シークより前の未判定のノーツは「対象外」として成績に数えません。

## 譜面 JSON（`charts/seipai.json`、schemaVersion 1）

時間はすべて **連続画像の開始を 0 秒** とする同じ時間軸の秒数です。画像（base64 など）は含めません。

```jsonc
{
  "schemaVersion": 1,
  "title": "セーパイ",
  "source": { "frameManifest": "assets/seipai/manifest.json", "frameCount": 412, "frameIntervalSeconds": 0.2, "durationSeconds": 82.266667 },
  "audio": { "src": "assets/seipai/audio.m4a", "startAtTimelineSeconds": 0 },   // 音声の 0 秒を置く時間軸の位置。src: null で音源なし
  "settings": {
    "inputOffsetMs": 0, "perfectWindowMs": 60, "goodWindowMs": 120, "missWindowMs": 180,
    "holdReleaseWindowMs": 150,   // 長押しの終了より この分 早く離しても成功
    "leadInSeconds": 2,           // 開始前の待ち時間
    "laneLeadSeconds": 2.4        // レーンの右端から判定線までの時間
  },
  "display": {
    "subjectAnchor": { "x": 0.5, "y": 0.5 },   // 胴体の中心を置く位置（背景の表示矩形内の 0〜1）
    "referenceHeightRatio": 0.55,               // 直立時の全高 ÷ 背景の高さ
    "frameOverrides": { "123": { "dx": 0.01, "dy": -0.02, "scale": 1.05 } }
  },
  "sequences": [ { "id": "opening", "label": "呼吸・構え・打撃" } ],
  "notes": [
    { "id": "n001", "time": 5.8, "button": "Y", "action": "breathe", "input": "hold", "duration": 2.6, "label": "呼吸", "sequenceId": "opening",
      "effect": { "preset": "breath", "intensity": 1 } },
    { "id": "n003", "time": 15.4, "button": "A", "action": "strike", "input": "tap", "label": "打撃", "sequenceId": "opening",
      "effect": { "preset": "strike", "anchor": { "x": 0.53, "y": 0.29 }, "direction": { "x": 0.1, "y": -1 }, "intensity": 1 } }
  ],
  "memo": [ "初期譜面の要調整箇所など" ]
}
```

| 項目 | 内容 |
|---|---|
| `button` / `action` / `input` | Y = `breathe`・`hold`（`duration` 必須）、X = `stance`・`tap`、A = `punch`／`kick`／`strike`・`tap`、B = `turn`・`tap` |
| `id` | ノーツごとに一意で変わらない ID（追加時は `n` + 連番） |
| `sequenceId` | 連続コマンドのまとまり（`sequences` の id）。各ノーツは個別に判定 |
| `effect.anchor` | 元の 576×1024 画像内を 0〜1 にした打撃点。中央配置・拡大縮小と同じ変換で画面に置く |
| `effect.direction` | 攻撃の向き（画面の右 = +x、下 = +y） |
| `effect.intensity` | 0〜2（PERFECT は 1 倍、GOOD は約 0.6 倍で表示） |
| `display.frameOverrides` | キー = コマ番号（0〜411）。`dx`・`dy` は背景の表示矩形の **高さ** に対する割合のずらし量、`scale` は自動倍率に掛ける倍率（0.2〜5） |

読み込み時は、形式・版・時刻の範囲・長押し時間・ID の重複・ボタンと action の対応・同じボタンの長押しとの重なり・
連続コマンドの参照・補正値を検証します。不正な JSON はメッセージを出して拒否し、今の編集内容は変わりません。
判定済みフラグやコンボなど、プレイ中だけの状態は保存しません。

## 初期譜面について

`charts/seipai.json`（46 ノーツ）は、412 枚を目視で確認し、動作が止まった（決まった）コマに置きました
（`tools/chart/build_initial_chart.py` に時刻の一覧と根拠のメモ）。0.2 秒間隔の画像から読んだ時刻なので、ミリ秒の精度はありません。
要調整箇所は譜面の `memo`（編集モードの「編集メモ」）にあります。主なもの:

- 冒頭は映像の動作に合わせた 1 つの連続コマンド: Y 呼吸（5.8 秒〜2.6 秒間）→ X 構え（12.2）→ A 打撃（15.4、片腕の突き上げ）→
  X 構え直し（18.4、両腕の交差）→ B 旋回（20.8）→ X 構え（21.6）→ A 打撃（22.2）。映像にない突きは加えていません
- 技名を確定できない打撃は「打撃」と表記（編集モードで変更可）。はっきり蹴りと分かる 24.2・59.2 秒だけ「蹴り」
- 44.4〜46.8 秒（後ろ向きで足を運ぶ区間）は決めの瞬間が読めないためノーツなし。静止・礼の区間にもなし

## 構成

| パス | 内容 |
|---|---|
| `app/main.js` | 読み込み・再生・入力・判定・描画のまとめ役 |
| `app/clock.js` | 共通の再生時計（音声あり: AudioContext の時計、なし: performance.now。速度・シーク・一時停止・開始前の待ち時間） |
| `app/judge.js` / `app/auto.js` | 判定（単押し・長押し・シーク時の初期化）／ AUTO |
| `app/input.js` | キーボード・画面ボタン・ゲームパッド → 押した／離した |
| `app/frames.js` / `app/layout.js` | 連続画像の読み込みとキャッシュ ／ 背景・レーン・人物の配置計算 |
| `app/fx.js` / `app/sfx.js` | 人物のアルファを使うエフェクト ／ 合成の効果音 |
| `app/lanes.js` / `app/editor.js` / `app/chart.js` | レーン描画 ／ 編集モード ／ 譜面 JSON の検証・書き出し |
| `tools/frames-2d/` | 素材準備（`prepare_frames.py`、代用素材 `standin_from_video.py`、`landmarks_mp.py`） |
| `tools/chart/` | 初期譜面の作成 |
| `tools/build-dist.mjs` | 公開用 `dist/`（2D 版のファイルだけ。代用素材では作らない） |
| `tools/handoff/integrate_bundle.bat` | クラウドで作った git bundle を PC で安全に取り込み、通常 push（確認のみ→ push の 2 段階） |
| `worker/` | 限定公開の認証ゲート（DEPLOY.md） |
