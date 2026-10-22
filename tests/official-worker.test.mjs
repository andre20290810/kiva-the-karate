// 公式データの配布・更新 API（worker/official.js）の確認。KV と静的アセットは模擬（メモリ・ディスク）。
// パスワードはテスト専用の値（本番のパスワードはリポジトリに置かない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import worker from '../worker/public.js';
import { hashPassword } from '../worker/index.js';

const root = resolve(import.meta.dirname, '..');
const HOST = 'kiva.world-of-andersen.com', ORIGIN = `https://${HOST}`;
const PASS = 'test-only-pass-42';

function kv() {
  const m = new Map();
  return { m, async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
}
const assets = { fetch: async (req) => { const p = new URL(req.url).pathname.replace(/^\//, ''); try { return new Response(readFileSync(resolve(root, p))); } catch { return new Response('nf', { status: 404 }); } } };
async function env(extra = {}) { return { OFFICIAL: kv(), OFFICIAL_PASSWORD_HASH: await hashPassword(PASS, { iterations: 20000 }), ASSETS: assets, ...extra }; }
const call = (e, path, { method = 'GET', body, origin = ORIGIN, type = 'application/json', ip = '1.2.3.4' } = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, {
  method, body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  headers: { ...(origin ? { origin } : {}), ...(type ? { 'content-type': type } : {}), 'cf-connecting-ip': ip },
}), e);
const chart = () => JSON.parse(readFileSync(resolve(root, 'charts/seipai_v2.json'), 'utf8'));
const demos = () => JSON.parse(readFileSync(resolve(root, 'charts/official-demos.json'), 'utf8')).records;

test('読み取り: KV が空なら公開ビルドの初期データ（版 0）。公式デモ 3 件を含む', async () => {
  const e = await env();
  const r = await call(e, '/api/official');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.version, 0); assert.equal(d.chart.notes.length, 59); assert.equal(d.demos.length, 3);
  assert.deepEqual(d.demos.map((x) => x.id), ['official-demo-90', 'official-demo-70', 'official-demo-50']);
});

test('認証なし・誤ったパスワード・別サイトからの送信・不正な JSON は保存しない', async () => {
  const e = await env();
  const c = chart(); c.settings.perfectWindowMs = 55;
  const body = { baseVersion: 0, targets: ['timing'], chart: c };
  assert.equal((await call(e, '/api/official/publish', { body })).status, 401);                          // パスワードなし
  const wrong = await call(e, '/api/official/publish', { body: { ...body, password: 'nope' } });
  assert.equal(wrong.status, 401); assert.match((await wrong.json()).message, /パスワードが違います（保存していません/);
  assert.equal((await call(e, '/api/official/publish', { body: { ...body, password: PASS }, origin: null })).status, 403);            // Origin なし
  assert.equal((await call(e, '/api/official/publish', { body: { ...body, password: PASS }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(e, '/api/official/publish', { body: '{"password":', type: 'application/json' })).status, 400);       // 不正な JSON
  assert.equal((await call(e, '/api/official/publish', { body: { ...body, password: PASS }, type: 'text/plain' })).status, 415);
  assert.equal((await call(e, '/api/official/publish', { method: 'GET' })).status, 405);
  assert.equal(e.OFFICIAL.m.has('official:current'), false); // 何も保存していない
});

test('正しいパスワード: 選んだ対象（判定設定）だけを更新し、版と更新日時を返す。以前の版を残す', async () => {
  const e = await env();
  const c = chart(); c.settings.perfectWindowMs = 55; c.notes[0].time += 0.5; // ノーツの変更は「判定設定」だけを選んだので反映しない
  const r = await call(e, '/api/official/publish', { body: { baseVersion: 0, targets: ['timing'], chart: c, password: PASS } });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d)); assert.equal(d.version, 1); assert.ok(d.updatedAt); assert.match(d.summary, /perfectWindowMs 60→55/);
  const cur = await (await call(e, '/api/official')).json();
  assert.equal(cur.version, 1); assert.equal(cur.chart.settings.perfectWindowMs, 55);
  assert.equal(cur.chart.notes.find((n) => n.id === c.notes[0].id).time, chart().notes[0].time); // 無関係なノーツは上書きしない
  assert.equal(cur.demos.length, 3);
  assert.ok(e.OFFICIAL.m.has('official:v:0'));
  assert.ok(!JSON.stringify([...e.OFFICIAL.m.values()]).includes(PASS)); // パスワードは保存しない
  const vs = await (await call(e, '/api/official/versions')).json();
  assert.deepEqual(vs.versions.map((v) => v.version), [1, 0]);
});

test('版の競合: 古い版を基にした保存は 409（新しい変更を上書きしない）', async () => {
  const e = await env();
  const c = chart(); c.settings.perfectWindowMs = 55;
  assert.equal((await call(e, '/api/official/publish', { body: { baseVersion: 0, targets: ['timing'], chart: c, password: PASS } })).status, 200);
  c.settings.perfectWindowMs = 50;
  const r = await call(e, '/api/official/publish', { body: { baseVersion: 0, targets: ['timing'], chart: c, password: PASS } });
  assert.equal(r.status, 409); assert.equal((await r.json()).version, 1);
  assert.equal((await (await call(e, '/api/official')).json()).chart.settings.perfectWindowMs, 55);
});

test('内容の検証: 不正な譜面・入力ログと一致しない公式デモ・変更なしは保存しない', async () => {
  const e = await env();
  const bad = chart(); bad.notes[0].button = 'Z';
  let r = await call(e, '/api/official/publish', { body: { baseVersion: 0, targets: ['notes'], chart: bad, password: PASS } });
  assert.equal(r.status, 400); assert.ok((await r.json()).errors.some((x) => /譜面/.test(x)));
  const ds = demos(); ds[0].summary.score += 1000; // 結果だけを書き換えた（入力ログと合わない）
  r = await call(e, '/api/official/publish', { body: { baseVersion: 0, targets: ['demos'], demos: ds, password: PASS } });
  assert.equal(r.status, 400); assert.ok((await r.json()).errors.some((x) => /一致しません/.test(x)));
  r = await call(e, '/api/official/publish', { body: { baseVersion: 0, targets: ['timing'], chart: chart(), password: PASS } });
  assert.equal(r.status, 400); assert.ok((await r.json()).errors.some((x) => /変更がありません/.test(x)));
  assert.equal(e.OFFICIAL.m.has('official:current'), false);
});

test('復元: 以前の版に戻す（同じ認証が必要）。戻した結果も新しい版として残る', async () => {
  const e = await env();
  const c = chart(); c.settings.goodWindowMs = 110;
  await call(e, '/api/official/publish', { body: { baseVersion: 0, targets: ['timing'], chart: c, password: PASS } });
  assert.equal((await call(e, '/api/official/restore', { body: { baseVersion: 1, version: 0, password: 'x' } })).status, 401);
  const r = await call(e, '/api/official/restore', { body: { baseVersion: 1, version: 0, password: PASS } });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d)); assert.equal(d.version, 2); assert.match(d.summary, /版 0 に戻す/);
  const cur = await (await call(e, '/api/official')).json();
  assert.equal(cur.chart.settings.goodWindowMs, 120); assert.equal(cur.restoredFrom, 0);
});

test('連続した認証の失敗: 5 回で一時的に止める（正しいパスワードでも保存しない）', async () => {
  const e = await env();
  const c = chart(); c.settings.perfectWindowMs = 55;
  for (let k = 0; k < 5; k++) assert.equal((await call(e, '/api/official/publish', { body: { baseVersion: 0, targets: ['timing'], chart: c, password: `bad${k}` }, ip: '9.9.9.9' })).status, 401);
  const r = await call(e, '/api/official/publish', { body: { baseVersion: 0, targets: ['timing'], chart: c, password: PASS }, ip: '9.9.9.9' });
  assert.equal(r.status, 429);
  assert.equal(e.OFFICIAL.m.has('official:current'), false);
  // 別の IP は影響なし
  assert.equal((await call(e, '/api/official/publish', { body: { baseVersion: 0, targets: ['timing'], chart: c, password: PASS }, ip: '5.5.5.5' })).status, 200);
});

test('サーバーの設定が不足していれば更新しない（画面だけの認証にしない）', async () => {
  const e = await env({ OFFICIAL_PASSWORD_HASH: undefined });
  const r = await call(e, '/api/official/publish', { body: { baseVersion: 0, targets: ['timing'], chart: chart(), password: PASS } });
  assert.equal(r.status, 503); assert.match((await r.json()).message, /OFFICIAL_PASSWORD_HASH/);
  const e2 = await env({ OFFICIAL: undefined });
  assert.equal((await call(e2, '/api/official/publish', { body: { baseVersion: 0, targets: ['timing'], chart: chart(), password: PASS } })).status, 503);
  assert.equal((await call(e2, '/api/official')).status, 200); // 読み取りは初期データで動く
});
