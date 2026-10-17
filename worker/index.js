// KIVA THE KARATE 限定公開用の認証ゲート（Cloudflare Workers + Static Assets）。
// wrangler.jsonc で run_worker_first: true とし、HTML・JS・画像・音声を含む全リクエストが
// 静的アセットより先にこの関数を通る。認証前は ASSETS を一切呼ばない。
//
// 必要な設定（パスワードやトークンを Git に書かない）:
//   secret  KIVA_PASSWORD_HASH  … tools/hash-password.mjs で作る PBKDF2 ハッシュ
//   secret  SESSION_SECRET      … 32 文字以上のランダム文字列（セッション署名鍵）
//   var     KIVA_USER           … ログインID（既定 kiva）
//   var     ALLOWED_HOST        … 公開ホスト名（これ以外のホスト=workers.dev 等は 404）
//   binding LOGIN_LIMITER       … Workers Rate Limiting（任意。無ければ isolate 内の簡易制限）

const COOKIE = '__Host-kiva_s';
const enc = new TextEncoder();
const memoryLimiter = new Map(); // ip → {n, reset}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      // 失敗時は閉じる（素材を返さない）。詳細はログに出すが認証情報は含めない
      console.error('auth gate error:', e && e.name);
      return text(500, '一時的なエラーです。');
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  const cfg = config(env);
  if (!cfg.ok) return text(500, 'サーバーの認証設定が未完了です（管理者へ連絡してください）。');

  // 1) 公開ホスト以外（*.workers.dev・プレビューURL 等）からの到達は拒否
  if (url.hostname !== cfg.host) return text(404, 'Not Found');
  // 2) HTTPS 必須
  if (url.protocol !== 'https:') {
    url.protocol = 'https:';
    return new Response(null, { status: 301, headers: { location: url.toString() } });
  }

  const path = url.pathname;
  if (path === '/__auth/login' && request.method === 'GET') return loginPage(url.searchParams.get('next'), '');
  if (path === '/__auth/login' && request.method === 'POST') return login(request, env, cfg, url);
  if (path === '/__auth/logout' && request.method === 'POST') {
    if (!sameOrigin(request, url)) return text(403, 'Forbidden');
    return new Response(null, { status: 303, headers: { location: '/__auth/login', 'set-cookie': clearCookie(), ...security(true) } });
  }

  const session = await readSession(request, cfg);
  if (path === '/__auth/me') {
    if (!session) return json(401, { error: 'unauthenticated' });
    return json(200, { user: session.u, exp: session.exp });
  }
  if (!session) {
    const wantsHtml = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
    if (wantsHtml) {
      const next = path + url.search;
      return new Response(null, { status: 302, headers: { location: `/__auth/login?next=${encodeURIComponent(next)}`, ...security(true) } });
    }
    return text(401, 'Unauthorized');
  }

  // 3) 認証済み: 静的アセットを返す（キャッシュは本人のブラウザ内のみ）
  if (path.startsWith('/__auth/')) return text(404, 'Not Found');
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  const type = out.headers.get('content-type') || '';
  for (const [k, v] of Object.entries(security(type.includes('text/html')))) out.headers.set(k, v);
  out.headers.set('cache-control', type.includes('text/html') ? 'private, no-store' : 'private, max-age=3600');
  return out;
}

function config(env) {
  const host = env.ALLOWED_HOST;
  const hash = env.KIVA_PASSWORD_HASH;
  const secret = env.SESSION_SECRET;
  const ok = !!host && typeof hash === 'string' && hash.startsWith('pbkdf2$') && typeof secret === 'string' && secret.length >= 32;
  return { ok, host, hash, secret, user: env.KIVA_USER || 'kiva', ttl: Number(env.SESSION_TTL || 12 * 3600) };
}

async function login(request, env, cfg, url) {
  if (!sameOrigin(request, url)) return text(403, 'Forbidden');
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await allow(env, ip))) return loginPage(null, '試行回数が多すぎます。しばらく待ってから再度お試しください。', 429);
  let form;
  try { form = await request.formData(); } catch { return loginPage(null, '入力を読み取れませんでした。', 400); }
  const user = String(form.get('user') || '');
  const pass = String(form.get('password') || '');
  const next = safeNext(String(form.get('next') || '/'));
  const okUser = timingSafeEqual(enc.encode(user), enc.encode(cfg.user));
  const okPass = await verifyPassword(pass, cfg.hash);
  if (!(okUser && okPass)) {
    await new Promise((r) => setTimeout(r, 400)); // 総当たりを遅くする
    return loginPage(next, 'ID またはパスワードが違います。', 401);
  }
  const exp = Math.floor(Date.now() / 1000) + cfg.ttl;
  const token = await sign({ u: cfg.user, exp, v: await passwordVersion(cfg.hash) }, cfg.secret);
  return new Response(null, {
    status: 303,
    headers: { location: next, 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${cfg.ttl}`, ...security(true) },
  });
}

// ---------- パスワード（PBKDF2-SHA256）----------
// 形式: pbkdf2$sha256$<iterations>$<salt base64url>$<hash base64url>
export async function hashPassword(password, { iterations = 100000, salt = crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  const bits = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${b64u(salt)}$${b64u(bits)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!(iterations >= 10000 && iterations <= 100000)) return false; // Workers の PBKDF2 上限は 100000
  const salt = unb64u(parts[3]);
  const expected = unb64u(parts[4]);
  const bits = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(bits, expected);
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

// パスワードを変えると以前のセッションは無効になる
async function passwordVersion(hash) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(hash)));
  return b64u(d.slice(0, 12));
}

// ---------- セッション（HMAC 署名付き Cookie）----------
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function sign(payload, secret) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64u(mac)}`;
}

async function readSession(request, cfg) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!m) return null;
  const token = m.slice(COOKIE.length + 1);
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  let macBytes;
  try { macBytes = unb64u(mac); } catch { return null; }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(cfg.secret), macBytes, enc.encode(body));
  if (!ok) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(unb64u(body))); } catch { return null; }
  if (!p || typeof p.exp !== 'number' || p.exp <= Math.floor(Date.now() / 1000)) return null;
  if (p.u !== cfg.user || p.v !== (await passwordVersion(cfg.hash))) return null;
  return p;
}

const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// ---------- 推測攻撃のレート制限 ----------
async function allow(env, ip) {
  if (env.LOGIN_LIMITER?.limit) {
    const { success } = await env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
    return success;
  }
  // バインディングが無い場合の簡易制限（isolate ごと・ベストエフォート）: 10分に10回
  const now = Date.now();
  const e = memoryLimiter.get(ip);
  if (!e || e.reset < now) { memoryLimiter.set(ip, { n: 1, reset: now + 600000 }); return true; }
  e.n++;
  return e.n <= 10;
}

// ---------- 補助 ----------
function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  return !origin || origin === url.origin;
}

function safeNext(n) {
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/__auth/') ? n : '/';
}

function timingSafeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function security(html) {
  const h = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin', // no-referrer だとフォーム送信の Origin が null になりログインが拒否される
    'x-robots-tag': 'noindex, nofollow',
    'strict-transport-security': 'max-age=31536000',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (html) {
    h['x-frame-options'] = 'DENY';
    h['content-security-policy'] = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    h['cache-control'] = 'private, no-store';
  }
  return h;
}

const text = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...security(false), 'cache-control': 'no-store' } });
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...security(false), 'cache-control': 'no-store' } });

function loginPage(next, message, status = 200) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const body = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>KIVA THE KARATE — ログイン</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:radial-gradient(120% 70% at 50% 0%,#14203d,#05060b 65%);color:#e9ecf3;font:15px/1.5 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;padding:16px}
form{box-sizing:border-box;width:min(360px,100%);background:#0d111c;border:1px solid #273150;border-radius:14px;padding:22px;box-shadow:0 0 40px rgba(69,200,255,.12)}
h1{margin:0 0 4px;font-size:18px;letter-spacing:.14em}h1 b{color:#45c8ff}p{margin:0 0 16px;color:#8b93a8;font-size:13px}
label{display:block;font-size:13px;color:#aab2c5;margin:10px 0 4px}input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2d3650;background:#070910;color:#fff;font-size:16px}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:10px;background:linear-gradient(180deg,#ffd65c,#e0a417);color:#1a1200;font-weight:800;font-size:15px}
.err{color:#ff8a8a;margin-top:10px;font-size:13px;min-height:1em}
</style></head><body><form method="post" action="/__auth/login" autocomplete="on">
<h1>KIVA <b>THE KARATE</b></h1><p>限定公開ページです。ID とパスワードを入力してください。</p>
<label for="u">ログインID</label><input id="u" name="user" autocomplete="username" required autocapitalize="none" spellcheck="false">
<label for="p">パスワード</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<input type="hidden" name="next" value="${esc(safeNext(next || '/'))}">
<button type="submit">ログイン</button><div class="err" role="alert">${esc(message)}</div></form></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...security(true) } });
}
