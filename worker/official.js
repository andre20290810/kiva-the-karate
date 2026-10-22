// 公式データの配布と更新（Cloudflare Worker）。
//   GET  /api/official            … 今の公式データ（だれでも読める。初回は公開ビルドに同梱した初期データ = 版 0）
//   GET  /api/official/versions   … 版の一覧（版・更新日時・対象・変更概要）
//   POST /api/official/publish    … 公式データとして保存・公開（パスワード必須）{password, baseVersion, targets, chart?, demos?}
//   POST /api/official/restore    … 以前の版に戻す（パスワード必須）{password, baseVersion, version}
// - パスワードはサーバーだけで照合する（secret OFFICIAL_PASSWORD_HASH = PBKDF2 のハッシュ。平文は保存しない）。
//   毎回の保存・復元で照合し、解除状態（セッション）は作らない。パスワードはログ・応答・保存データに出さない。
// - 連続した失敗は IP ごとに数え（KV）、5 回で 15 分止める。さらに Workers Rate Limiting（OFFICIAL_LIMITER）で 1 分あたりの回数を制限。
// - 版の競合: baseVersion が今の版と違えば 409（新しい変更を上書きしない）。
// - 永続保存: KV（binding OFFICIAL）。今の版 = official:current、以前の版 = official:v:<版>、一覧 = official:index。

import { verifyPassword } from './index.js';
import { prepareUpdate, OFFICIAL_SCHEMA, TARGETS, summaryText } from '../app/official.js';
import { normalizeChart } from '../app/chart.js';

const MAX_BODY = 3 * 1024 * 1024;
const FAIL_LIMIT = 5, LOCK_SEC = 15 * 60;
const BUNDLED = { chart: '/charts/seipai_v2.json', demos: '/charts/official-demos.json' };
const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });

export async function handleOfficial(request, env, url) {
  const p = url.pathname;
  if (p === '/api/official' && request.method === 'GET') return json(200, await current(env, url));
  if (p === '/api/official/versions' && request.method === 'GET') return json(200, { versions: await index(env) });
  if (p === '/api/official/publish' || p === '/api/official/restore') {
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'POST で送ってください' });
    return write(request, env, url, p.endsWith('restore') ? 'restore' : 'publish');
  }
  return json(404, { error: 'not-found' });
}

/** 今の公式データ（KV になければ公開ビルドの初期データ = 版 0） */
async function current(env, url) {
  const saved = env.OFFICIAL ? await env.OFFICIAL.get('official:current', 'json') : null;
  if (saved) return saved;
  const get = async (path) => {
    const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  };
  const chart = await get(BUNDLED.chart);
  let demos = [];
  try { demos = (await get(BUNDLED.demos)).records || []; } catch { demos = []; }
  return { schema: OFFICIAL_SCHEMA, version: 0, updatedAt: null, targets: [], summary: '公開ビルドに同梱した初期データ', chart, demos };
}

async function index(env) {
  return (env.OFFICIAL ? await env.OFFICIAL.get('official:index', 'json') : null) || [];
}

async function write(request, env, url, kind) {
  // 同じサイトの画面からの送信だけ（ほかのサイトからの送信・Origin なしは拒否）
  const origin = request.headers.get('origin');
  if (origin !== url.origin) return json(403, { error: 'origin', message: 'この画面以外からは更新できません' });
  if (!(request.headers.get('content-type') || '').includes('application/json')) return json(415, { error: 'type', message: 'JSON で送ってください' });
  // サーバーの設定（パスワードのハッシュ・保存先）がなければ更新しない
  const need = [];
  if (typeof env.OFFICIAL_PASSWORD_HASH !== 'string' || !env.OFFICIAL_PASSWORD_HASH.startsWith('pbkdf2$')) need.push('secret OFFICIAL_PASSWORD_HASH');
  if (!env.OFFICIAL) need.push('KV binding OFFICIAL');
  if (need.length) return json(503, { error: 'not-configured', message: `サーバーの設定が不足しています: ${need.join('、')}`, need });
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  // 試行の制限（認証の前）
  if (env.OFFICIAL_LIMITER?.limit) {
    const { success } = await env.OFFICIAL_LIMITER.limit({ key: `official:${ip}` });
    if (!success) return json(429, { error: 'rate', message: '試行回数が多すぎます。しばらく待ってから再度お試しください。' }, { 'retry-after': '60' });
  }
  const failKey = `official:fail:${ip}`;
  const fail = (await env.OFFICIAL.get(failKey, 'json')) || { n: 0, until: 0 };
  const now = Math.floor(Date.now() / 1000);
  if (fail.until > now) return json(429, { error: 'locked', message: `パスワードの失敗が続いたため、${Math.ceil((fail.until - now) / 60)} 分ほど更新できません。`, retryAfter: fail.until - now }, { 'retry-after': String(fail.until - now) });
  // 本文（大きさ・JSON の形）
  const text = await request.text();
  if (text.length > MAX_BODY) return json(413, { error: 'size', message: '送信データが大きすぎます' });
  let body;
  try { body = JSON.parse(text); } catch { return json(400, { error: 'json', message: 'JSON として読めません（保存していません）' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'json', message: '送信データの形式が違います（保存していません）' });
  // パスワード（毎回照合。平文は保存・記録しない）
  const password = typeof body.password === 'string' ? body.password : '';
  delete body.password;
  const ok = password.length > 0 && password.length <= 200 && await verifyPassword(password, env.OFFICIAL_PASSWORD_HASH);
  if (!ok) {
    const n = (fail.until && fail.until <= now ? 0 : fail.n) + 1;
    const next = { n, until: n >= FAIL_LIMIT ? now + LOCK_SEC : 0 };
    await env.OFFICIAL.put(failKey, JSON.stringify(next), { expirationTtl: LOCK_SEC + 60 });
    await new Promise((r) => setTimeout(r, 400)); // 総当たりを遅くする
    return json(401, { error: 'password', message: n >= FAIL_LIMIT ? `パスワードが違います。失敗が ${FAIL_LIMIT} 回続いたため 15 分ほど更新できません（保存していません）` : `パスワードが違います（保存していません。あと ${FAIL_LIMIT - n} 回失敗すると一時的に止めます）` });
  }
  if (fail.n) await env.OFFICIAL.delete(failKey);

  const cur = await current(env, url);
  if (!Number.isInteger(body.baseVersion) || body.baseVersion !== cur.version) {
    return json(409, { error: 'conflict', message: `公式データはほかの更新で版 ${cur.version} になっています（あなたが見ていたのは版 ${body.baseVersion ?? '不明'}）。最新を読み込み、変更を確かめてからもう一度保存してください（保存していません）`, version: cur.version, updatedAt: cur.updatedAt });
  }
  const frameCount = cur.chart?.source?.frameCount, gameVersion = cur.chart?.gameVersion;
  let next;
  if (kind === 'restore') {
    const v = body.version;
    if (!Number.isInteger(v) || v < 0 || v >= cur.version) return json(400, { error: 'version', message: '戻す版が正しくありません' });
    const old = await env.OFFICIAL.get(`official:v:${v}`, 'json');
    if (!old) return json(404, { error: 'version', message: `版 ${v} は保存されていません` });
    const prep = prepareUpdate({ chart: normalizeChart(cur.chart), demos: cur.demos }, { targets: Object.keys(TARGETS), chart: old.chart, demos: old.demos }, { frameCount, gameVersion });
    if (prep.errors.length) return json(400, { error: 'invalid', message: '戻せません', errors: prep.errors });
    next = { chart: old.chart, demos: old.demos, targets: Object.keys(TARGETS), summary: `版 ${v} に戻す（${summaryText(prep.summary)}）`, restoredFrom: v };
  } else {
    const prep = prepareUpdate({ chart: normalizeChart(cur.chart), demos: cur.demos }, body, { frameCount, gameVersion });
    if (prep.errors.length) return json(400, { error: 'invalid', message: '公開できません（保存していません）', errors: prep.errors.slice(0, 30) });
    next = { chart: prep.chart, demos: prep.demos, targets: prep.targets, summary: summaryText(prep.summary) };
  }
  // 以前の版を残してから、新しい版を保存
  const updatedAt = new Date().toISOString();
  const doc = { schema: OFFICIAL_SCHEMA, version: cur.version + 1, updatedAt, targets: next.targets, summary: next.summary, restoredFrom: next.restoredFrom ?? null, chart: next.chart, demos: next.demos };
  await env.OFFICIAL.put(`official:v:${cur.version}`, JSON.stringify(cur));
  await env.OFFICIAL.put('official:current', JSON.stringify(doc));
  const list = await index(env);
  if (!list.some((x) => x.version === cur.version)) list.unshift({ version: cur.version, updatedAt: cur.updatedAt, targets: cur.targets || [], summary: cur.summary || '' });
  list.unshift({ version: doc.version, updatedAt, targets: doc.targets, summary: doc.summary, restoredFrom: doc.restoredFrom });
  await env.OFFICIAL.put('official:index', JSON.stringify(list.sort((a, b) => b.version - a.version).slice(0, 100)));
  console.log(`official ${kind}: v${doc.version}`); // パスワード・本文は出さない
  return json(200, { ok: true, version: doc.version, updatedAt, targets: doc.targets, summary: doc.summary });
}
