// 公開版（パスワードなしで遊べる）。ゲームの素材はすべて公開。
// /api/official だけは公式データの配布と更新（更新はサーバーでパスワードを照合。worker/official.js）。
import { handleOfficial } from './official.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== 'kiva.world-of-andersen.com') return new Response('Not Found', { status: 404 });
    if (url.protocol !== 'https:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname.startsWith('/__auth/')) return new Response('Not Found', { status: 404 });
    if (url.pathname === '/api/official' || url.pathname.startsWith('/api/official/')) {
      try {
        return await handleOfficial(request, env, url);
      } catch (e) {
        console.error('official api error:', e && e.name); // 本文・パスワードは出さない
        return new Response(JSON.stringify({ error: 'server', message: 'サーバーでエラーが起きました（保存していません）' }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
    return env.ASSETS.fetch(request);
  }
};
