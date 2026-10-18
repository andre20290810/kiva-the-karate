# 公開（Cloudflare Workers）

> **現在の構成（2026-10-18 時点の `wrangler.jsonc`）**: `"main": "worker/public.js"` = **パスワードなしの公開版**
> （コミット 9191dcf「Deploy public no-password KIVA preview on Cloudflare」）。`kiva.world-of-andersen.com` 以外のホストは 404、
> http は https へ転送、GET/HEAD のみ。`dist/` の全ファイル（人物の画像・音声を含む）が誰でも取得できます。
> パスワード付きに戻す場合は `"main": "worker/index.js"` にして手順 2 のシークレットを設定します（以下はその手順も含みます）。
>
> **公開物の中身**: コードは GitHub、人物の画像（修正済み 412 枚）と音声は Git 管理外です。`git push` だけでは素材は公開されません。
> `dist/` を作った PC から `npx wrangler deploy` した時点で、その PC の `assets/` の内容が公開されます。

`worker/index.js` が全リクエスト（HTML・JS・画像・音声）を静的アセットより先に処理し、
ログイン済みのブラウザにだけ `dist/` の内容を返します（`wrangler.jsonc` の `run_worker_first: true`）。

**現状**: `kiva.world-of-andersen.com` に公開済み（Worker `kiva-the-karate`、`worker/public.js` = パスワードなし）。
2026-10-18 に 107ba93 の dist をデプロイ（バージョン 8090e203）。以降の更新も同じ手順（手順 1 の `build-dist` → `npx wrangler deploy`）で、
デプロイ後は公開 URL のファイルが `dist/` と一致することと、ゲームの起動を確認します。
API トークン（`CLOUDFLARE_API_TOKEN`、テンプレート「Edit Cloudflare Workers」）と `CLOUDFLARE_ACCOUNT_ID` を環境変数に設定すれば
`wrangler login` なしでデプロイできます。以下のパスワード付き構成（`worker/index.js`）の手順は、限定公開に戻す場合に使います。

## 0. 公開前の確認（必須）

- KIVA さんの演武映像・音声・切り抜き画像を、この範囲（パスワードを知る人のみ）で配信してよいか許諾を確認する。
- `kiva.world-of-andersen.com` が未使用か確認する（Cloudflare ダッシュボード → world-of-andersen.com → DNS で
  `kiva` のレコードを検索）。**既にレコードがある場合は作業を止めて相談**（既存の DNS を変更・削除しない）。

## 1. 準備（PC の作業ディレクトリで）

```powershell
npm ci
npm install --no-save wrangler@4
npx wrangler login                     # ブラウザで Cloudflare にログイン（API トークンは作らない）
# 素材（Git 管理外）: 引き継ぎの seipai_transparent_repaired.zip（修正済み 412 枚）と元動画 seipai.mp4 を source\ に置く
python tools\frames-2d\ingest.py --zip source\seipai_transparent_repaired.zip --video source\seipai.mp4 --model pose_landmarker_heavy.task
sh tools/extract_audio.sh source/seipai.mp4 assets/seipai   # audio.m4a（AAC-LC、元動画からそのまま）と audio_opus.m4a（予備）
# 背景 IMG_7441.JPG・IMG_7439.JPG を assets\stage\ に置く
node tools/build-dist.mjs              # 公開用 dist/ を作成（source/ は含まれない。素材・音声が欠けていると止まる）
```

## 2. パスワードと署名鍵（Git に保存しない）

```powershell
node tools/hash-password.mjs           # 12文字以上の強いパスワードを入力 → pbkdf2$... が出力される
npx wrangler secret put KIVA_PASSWORD_HASH   # 上の出力を貼り付け
npx wrangler secret put SESSION_SECRET       # 32文字以上のランダム文字列（パスワード管理ツールで生成）
```

- `kiva2026` のような推測しやすいパスワードは `hash-password.mjs` が拒否します。
- パスワードは KIVA さんへ別経路（対面・別のメッセージ）で伝えてください。

## 3. デプロイとカスタムドメイン

```powershell
npx wrangler deploy
```

`wrangler.jsonc` の `routes`（`custom_domain: true`）により、Cloudflare が `kiva.world-of-andersen.com` の
DNS レコードと HTTPS 証明書を作成します。`workers_dev: false` / `preview_urls: false` で workers.dev の URL は作られず、
Worker もホスト名が `kiva.world-of-andersen.com` 以外のアクセスを 404 にします。

`ratelimits` の `namespace_id`（`1001`）はアカウント内で一意の整数です。既存の Worker と重なる場合は変更してください。

## 4. 公開後の確認（すべて確認するまで「公開完了」としない）

| 確認 | 期待 |
|---|---|
| シークレットウィンドウで `https://kiva.world-of-andersen.com/` | ログイン画面へ転送 |
| 未ログインで `/app/main.js`・`/assets/seipai/audio.m4a`・`/assets/seipai/manifest.json` | ログイン画面 / 401（中身が返らない） |
| `http://kiva.world-of-andersen.com/` | `https://` へ転送 |
| 誤ったパスワード | 「ID またはパスワードが違います」 |
| 正しいパスワード | ゲームが起動し、設定欄にログアウトが表示 |
| ログアウト後に再読み込み | ログイン画面 |
| スマートフォン（縦・横）でログイン〜プレイ | 正常 |
| `*.workers.dev` の URL | 存在しない（または 404） |

## 公開後の確認（音声・iPhone）

設定欄の音声の行に、そのブラウザが使っている音声ファイル・コーデック・AudioContext の状態・音声セッション（iOS 17 以降）・
出力信号の有無が出ます。「再生中の音声」と出るのは、AudioContext が動いていて音楽の出力に信号があるときだけです。
`audio.m4a（AAC）` なら AAC、`audio_opus.m4a（Opus（予備…））` なら AAC をデコードできずに予備へ切り替わっています。
iPhone では Web Audio が消音スイッチで無音になるため、開始ボタンで音声セッションを「再生」（navigator.audioSession、
iOS 16 以前は無音の audio 要素）に切り替えます。iPhone のスピーカーから実際に音が出るかは、ブラウザ内からは測れません（実機で確認）。

iPhone（Safari）での確認手順:
1. `https://kiva.world-of-andersen.com/` を開き、消音スイッチを切って音量を上げる
2. 「▶ 開始」の後に「設定」を開き、「再生中の音声: audio.m4a（AAC） ／ 出力信号あり ／ AudioContext: running ／ 音声セッション: playback」
   と出ていることを確認（Opus と出たら AAC をデコードできていない。「再生できていません」と出たら理由を控えて「🔈 音声を再試行」）
3. 「▶ 開始」→ 音が出る。冒頭 Y（約 5.8 秒）の呼吸の動きと音・レーンの判定線が合っている
4. 一時停止 → 音と人物が同時に止まる。再開 → 同じ位置から続く
5. 下のバーで 40 秒付近へシーク → 音・人物・ノーツが同じ位置から再開する
6. 設定で速度 0.5× → 音・人物・ノーツが同じ速さで遅くなる（1× に戻しても位置がずれない）
7. 横向きに回転 → 再生が続き、背景が横用に変わる
8. AUTO → 最後まで再生されて結果が出る

## 運用

- **パスワード変更**: 手順2をやり直す（`KIVA_PASSWORD_HASH` を更新）。既存のログインはすべて無効になります。
- **全員を強制ログアウト**: `SESSION_SECRET` を新しい値に更新。
- セッション有効期間は 12 時間（`SESSION_TTL` 秒）。Cookie は `HttpOnly; Secure; SameSite=Strict`。
- ログイン試行は IP ごとに 60 秒 10 回まで（`LOGIN_LIMITER`）。
- 制約: セッションは署名付き Cookie のため、ログアウトはそのブラウザの Cookie を消す方式です。
  漏えいが疑われる場合は `SESSION_SECRET` を更新してください。

## ローカルでの認証確認（開発用）

```powershell
node tools/build-dist.mjs --allow-missing-assets
# .dev.vars（Git 対象外）にテスト用の KIVA_PASSWORD_HASH と SESSION_SECRET を書く
npx wrangler dev --local --local-protocol https --host localhost:8787 --var ALLOWED_HOST:localhost
```
