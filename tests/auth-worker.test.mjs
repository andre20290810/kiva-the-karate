import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import worker, { hashPassword, sign } from '../worker/index.js';

// テスト専用の値（本番の認証情報ではない）
const PASSWORD = 'test-only-Long-Passphrase-42';
const HOST = 'kiva.example.test';
const ORIGIN = `https://${HOST}`;

async function makeEnv(over = {}) {
  const calls = [];
  const env = {
    ALLOWED_HOST: HOST,
    KIVA_USER: 'kiva',
    KIVA_PASSWORD_HASH: await hashPassword(PASSWORD, { iterations: 20000 }),
    SESSION_SECRET: 'x'.repeat(48),
    ASSETS: {
      fetch: async (req) => {
        calls.push(new URL(req.url).pathname);
        const html = new URL(req.url).pathname.endsWith('/') || new URL(req.url).pathname.endsWith('.html');
        return new Response(html ? '<html>game</html>' : 'BINARY', { status: 200, headers: { 'content-type': html ? 'text/html' : 'audio/mp4' } });
      },
    },
    ...over,
  };
  return { env, calls };
}

const get = (path, { cookie, host = HOST, accept = 'text/html', proto = 'https' } = {}) =>
  new Request(`${proto}://${host}${path}`, { headers: { accept, ...(cookie ? { cookie } : {}) } });

const post = (path, form, { origin = ORIGIN, cookie, ip = '203.0.113.7' } = {}) => {
  const body = new URLSearchParams(form);
  return new Request(`https://${HOST}${path}`, {
    method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), 'cf-connecting-ip': ip },
  });
};

async function loginCookie(env, ip) {
  const res = await worker.fetch(post('/__auth/login', { user: 'kiva', password: PASSWORD, next: '/' }, { ip }), env);
  assert.equal(res.status, 303);
  const sc = res.headers.get('set-cookie');
  return { sc, cookie: sc.split(';')[0] };
}

test('未認証: HTML はログインへ転送、JS・画像・音声は 401。素材配信は一度も呼ばれない', async () => {
  const { env, calls } = await makeEnv();
  const r1 = await worker.fetch(get('/'), env);
  assert.equal(r1.status, 302);
  assert.match(r1.headers.get('location'), /^\/__auth\/login\?next=%2F$/);
  for (const p of ['/index.html', '/app/main.js', '/app/style.css', '/assets/seipai/audio.m4a', '/assets/seipai/cut/frame_0001.webp', '/assets/seipai/manifest.json', '/charts/seipai.json']) {
    const r = await worker.fetch(get(p, { accept: '*/*' }), env);
    assert.equal(r.status, 401, p);
  }
  assert.deepEqual(calls, []);
});

test('間違った ID・パスワードは拒否され、Cookie は発行されない', async () => {
  const { env, calls } = await makeEnv();
  for (const form of [{ user: 'kiva', password: 'wrong' }, { user: 'kiva', password: 'kiva2026' }, { user: 'other', password: PASSWORD }, { user: 'kiva', password: '' }]) {
    const r = await worker.fetch(post('/__auth/login', form, { ip: `198.51.100.${Math.random() * 200 | 0}` }), env);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
  }
  assert.deepEqual(calls, []);
});

test('認証成功: HttpOnly・Secure・SameSite=Strict の Cookie で素材を取得できる', async () => {
  const { env, calls } = await makeEnv();
  const { sc, cookie } = await loginCookie(env, '192.0.2.1');
  assert.match(sc, /^__Host-kiva_s=/);
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\//);
  const page = await worker.fetch(get('/', { cookie }), env);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  // no-referrer にするとブラウザのフォーム送信で Origin: null になり、ログインできなくなる
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  const audio = await worker.fetch(get('/assets/seipai/audio.m4a', { cookie, accept: '*/*' }), env);
  assert.equal(audio.status, 200);
  assert.match(audio.headers.get('cache-control'), /^private/);
  const me = await (await worker.fetch(get('/__auth/me', { cookie }), env)).json();
  assert.equal(me.user, 'kiva');
  assert.deepEqual(calls, ['/', '/assets/seipai/audio.m4a']);
});

test('ログアウトで Cookie が消え、再度認証が必要になる', async () => {
  const { env } = await makeEnv();
  await loginCookie(env, '192.0.2.2');
  const out = await worker.fetch(post('/__auth/logout', {}, {}), env);
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  // Cookie を消したブラウザ（Cookie なし）は再び拒否される
  assert.equal((await worker.fetch(get('/'), env)).status, 302);
});

test('改ざん・期限切れ・別の署名鍵の Cookie は無効', async () => {
  const { env, calls } = await makeEnv();
  const { cookie } = await loginCookie(env, '192.0.2.3');
  const [name, token] = cookie.split('=');
  const [body, mac] = token.split('.');
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
  forged.exp += 999999;
  const tampered = `${name}=${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${mac}`;
  assert.equal((await worker.fetch(get('/', { cookie: tampered }), env)).status, 302);
  const expired = await sign({ ...forged, exp: Math.floor(Date.now() / 1000) - 1 }, env.SESSION_SECRET);
  assert.equal((await worker.fetch(get('/', { cookie: `${name}=${expired}` }), env)).status, 302);
  const otherKey = await sign({ ...forged, exp: Math.floor(Date.now() / 1000) + 60 }, 'y'.repeat(48));
  assert.equal((await worker.fetch(get('/', { cookie: `${name}=${otherKey}` }), env)).status, 302);
  assert.deepEqual(calls, []);
});

test('パスワード変更で既存セッションが無効になる', async () => {
  const { env } = await makeEnv();
  const { cookie } = await loginCookie(env, '192.0.2.4');
  env.KIVA_PASSWORD_HASH = await hashPassword('another-Long-Passphrase-77', { iterations: 20000 });
  assert.equal((await worker.fetch(get('/', { cookie }), env)).status, 302);
});

test('認証の迂回路: 公開ホスト以外（workers.dev 等）は有効な Cookie でも 404、HTTP は HTTPS へ', async () => {
  const { env, calls } = await makeEnv();
  const { cookie } = await loginCookie(env, '192.0.2.5');
  for (const host of ['kiva-the-karate.someone.workers.dev', 'abc123-kiva-the-karate.someone.workers.dev', 'evil.example']) {
    assert.equal((await worker.fetch(get('/', { cookie, host }), env)).status, 404, host);
    assert.equal((await worker.fetch(get('/assets/seipai/audio.m4a', { cookie, host, accept: '*/*' }), env)).status, 404, host);
  }
  const http = await worker.fetch(get('/', { proto: 'http' }), env);
  assert.equal(http.status, 301);
  assert.match(http.headers.get('location'), /^https:/);
  assert.deepEqual(calls, []);
});

test('別サイトからのログイン・ログアウト送信は拒否（CSRF）', async () => {
  const { env } = await makeEnv();
  assert.equal((await worker.fetch(post('/__auth/login', { user: 'kiva', password: PASSWORD }, { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(post('/__auth/logout', {}, { origin: 'https://evil.example' }), env)).status, 403);
});

test('推測攻撃: 同じ IP から連続失敗すると 429（バインディング使用時もその判定に従う）', async () => {
  const { env } = await makeEnv();
  let last;
  for (let i = 0; i < 12; i++) last = await worker.fetch(post('/__auth/login', { user: 'kiva', password: `guess${i}` }, { ip: '203.0.113.99' }), env);
  assert.equal(last.status, 429);
  // 正しいパスワードでも制限中は通さない
  const blocked = await worker.fetch(post('/__auth/login', { user: 'kiva', password: PASSWORD }, { ip: '203.0.113.99' }), env);
  assert.equal(blocked.status, 429);
  const limited = await makeEnv({ LOGIN_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal((await worker.fetch(post('/__auth/login', { user: 'kiva', password: PASSWORD }, { ip: '203.0.113.5' }), limited.env)).status, 429);
});

test('ログイン後の転送先は同一サイト内のみ（オープンリダイレクト防止）', async () => {
  const { env } = await makeEnv();
  for (const next of ['https://evil.example/', '//evil.example/', '/__auth/logout']) {
    const r = await worker.fetch(post('/__auth/login', { user: 'kiva', password: PASSWORD, next }, { ip: `192.0.2.${10 + next.length}` }), env);
    assert.equal(r.headers.get('location'), '/');
  }
});

test('設定不足（秘密情報なし・弱い署名鍵）では素材を返さず 500（閉じた状態で失敗）', async () => {
  for (const over of [{ KIVA_PASSWORD_HASH: undefined }, { SESSION_SECRET: 'short' }, { ALLOWED_HOST: undefined }]) {
    const { env, calls } = await makeEnv(over);
    const r = await worker.fetch(get('/'), env);
    assert.equal(r.status, 500);
    assert.deepEqual(calls, []);
  }
});

test('秘密情報の混入防止: Git に入りうるファイルにパスワード・ハッシュ・署名鍵が書かれていない', () => {
  const root = resolve(import.meta.dirname, '..');
  // 追跡中 + 未追跡で .gitignore 対象外（= git add で入るもの）を検査。.dev.vars 等の除外ファイルは対象外
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(files.length > 20);
  const hits = [];
  for (const rel of files) {
    if (!/\.(js|mjs|json|jsonc|md|html|css|toml|txt|vars|env)$/.test(rel) && !/(^|\/)\.(dev\.vars|env)/.test(rel)) continue;
    if (rel.endsWith('auth-worker.test.mjs')) continue;
    const s = readFileSync(join(root, rel), 'utf8');
    if (/pbkdf2\$sha256\$\d+\$[A-Za-z0-9_-]{8,}\$/.test(s)) hits.push(`${rel}: パスワードハッシュ`);
    if (/(KIVA_PASSWORD_HASH|SESSION_SECRET)\s*[:=]\s*["'][^"'<]{8,}/.test(s)) hits.push(`${rel}: 秘密情報の値`);
    if (/password\s*[:=]\s*["']kiva2026["']/i.test(s)) hits.push(`${rel}: 推測されやすいパスワード`);
  }
  assert.deepEqual(hits, []);
  const ignored = execFileSync('git', ['check-ignore', '.dev.vars', 'dist/x', 'source/x', 'assets/x'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.equal(ignored.length, 4, '.dev.vars・dist・source・assets は Git 対象外');
});
