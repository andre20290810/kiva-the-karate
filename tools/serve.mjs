// 依存なしの静的サーバー: node tools/serve.mjs [port]
// 既定はローカルPCのみ。LAN確認時だけ HOST=0.0.0.0 を明示し、信頼済みネットワークで実行。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8080);
const hostname = process.env.HOST || '127.0.0.1'; // Local-only by default; opt in to LAN explicitly.
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  let url, decoded;
  try {
    url = new URL(req.url, 'http://x');
    decoded = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('bad URL');
    return;
  }
  // Local source footage, Git internals and dependencies must NEVER be HTTP-served.
  const parts = decoded.split(/[\\/]+/).filter(Boolean);
  if (parts.some(part => part === 'source' || part === 'node_modules' || part.startsWith('.'))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let p = path.resolve(root, '.' + decoded);
  const rel = path.relative(root, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403).end('forbidden'); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  fs.stat(p, (err, st) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + url.pathname); return; }
    const headers = { 'content-type': types[path.extname(p).toLowerCase()] || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : st.size - 1;
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      fs.createReadStream(p, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'content-length': st.size });
      fs.createReadStream(p).pipe(res);
    }
  });
}).listen(port, hostname, () => {
  console.log(`http://localhost:${port}/  (local-only unless HOST overrides it)`);
  if (hostname === '0.0.0.0') {
    console.warn('WARNING: LAN-accessible test server. Use only on a trusted network.');
    for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || [])
      if (i.family === 'IPv4' && !i.internal) console.log(`http://${i.address}:${port}/  (LAN)`);
  }
});
