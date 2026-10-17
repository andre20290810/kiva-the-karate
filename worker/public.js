// Public KIVA preview: no password. All game assets are intentionally public.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== 'kiva.world-of-andersen.com') return new Response('Not Found', { status: 404 });
    if (url.protocol !== 'https:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname.startsWith('/__auth/')) return new Response('Not Found', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
    return env.ASSETS.fetch(request);
  }
};
