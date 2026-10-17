# 限定公開（Cloudflare Workers + パスワード認証）

`worker/index.js` が全リクエスト（HTML・JS・画像・音声）を静的アセットより先に処理し、
ログイン済みのブラウザにだけ `dist/` の内容を返します（`wrangler.jsonc` の `run_worker_first: true`）。

**現状**: コードとローカル検証（workerd）は完了しています。Cloudflare へのデプロイ・DNS・本番での確認は**未実施**です
（作業環境から Cloudflare に接続できず、認証情報もないため）。以下は利用者が行う手順です。

## 0. 公開前の確認（必須）

- KIVA さんの演武映像・音声・切り抜き画像を、この範囲（パスワードを知る人のみ）で配信してよいか許諾を確認する。
- `kiva.world-of-andersen.com` が未使用か確認する（Cloudflare ダッシュボード → world-of-andersen.com → DNS で
  `kiva` のレコードを検索）。**既にレコードがある場合は作業を止めて相談**（既存の DNS を変更・削除しない）。

## 1. 準備（PC の作業ディレクトリで）

```powershell
npm ci
npm install --no-save wrangler@4
npx wrangler login                     # ブラウザで Cloudflare にログイン（API トークンは作らない）
node tools/prepare_assets.mjs          # 実素材から assets/seipai を作成（未実施なら）
node tools/build-dist.mjs              # 公開用 dist/ を作成（source/ は含まれない）
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
| 未ログインで `/src/game.js`・`/assets/seipai/audio.m4a`・`/assets/seipai/frames.json` | ログイン画面 / 401（中身が返らない） |
| `http://kiva.world-of-andersen.com/` | `https://` へ転送 |
| 誤ったパスワード | 「ID またはパスワードが違います」 |
| 正しいパスワード | ゲームが起動し、設定欄にログアウトが表示 |
| ログアウト後に再読み込み | ログイン画面 |
| スマートフォン（縦・横）でログイン〜プレイ | 正常 |
| `*.workers.dev` の URL | 存在しない（または 404） |

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
