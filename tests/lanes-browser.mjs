// プレイ画面のレーンの確認（実素材が必要）: npm start（別ターミナル）→ node tests/lanes-browser.mjs（BASE=公開 URL でも可）
// - 流れるノーツ（文字・長押しの線・終端・光）は主人公より奥に描く（主人公の透明な部分からは見える）。見出し・判定線・判定位置の火は手前
// - 文字のノーツは太字の行書体（app/fonts の Web フォント）。読み込み後に寸法を測り、文字・縁取り・光が画像の端で切れない
// - 流れる文字と左端の判定の文字は同じ大きさ
// - 見出しの右に 4 つのボタンの配置（上 Y・右 B・下 A・左 X）。その行のボタンだけ強調。文字・案内・判定線の間に余白
// - 案内を足しても、ノーツが判定位置に着く時刻 = 正解の時刻（判定とずれない）
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}) });
const ready = (p) => p.waitForFunction(() => ['ready', 'paused', 'playing'].includes(window.__app?.state), null, { timeout: 120000 });

for (const [label, vp] of [['PC 1280x800', { width: 1280, height: 800 }], ['縦 393x852', { width: 393, height: 852 }], ['横 852x393', { width: 852, height: 393 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}?fresh=1`); await ready(p);

  // 1. 行書体の読み込み
  const font = await p.evaluate(async () => {
    await document.fonts.ready;
    return { loaded: window.__debug?.brushFont ?? window.__app.brushFont, check: document.fonts.check('40px KivaBrush', '息構撃旋'),
      faces: [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'KivaBrush').map((f) => f.status) };
  });
  check(font.loaded === true && font.check && font.faces.includes('loaded'), `${label}: 太字の行書体（Web フォント）を読み込んで文字のノーツに使う`, JSON.stringify(font));

  // 2. 描く順番: 背景のレーン → 流れるノーツ → 主人公 → 見出し・判定線
  const order = await p.evaluate(() => {
    const a = window.__app, seq = [];
    const n = a.chart.notes.find((x) => x.time > 20 && x.input !== 'hold');
    const t = n.time - a.chart.settings.laneLeadSeconds * 0.5; // そのノーツがレーンの途中にある時刻
    a.seek(t);
    const L = a.lanes, ctx = a.ctx;
    const dn = L.drawNotes.bind(L), df = L.draw.bind(L), di = ctx.drawImage.bind(ctx);
    L.drawNotes = (...x) => { seq.push('notes'); return dn(...x); };
    L.draw = (...x) => { seq.push('front'); return df(...x); };
    const fi = a.store.indexAt(Math.max(0, t));
    ctx.drawImage = (img, ...x) => { if (img === a.store.get(fi)?.bmp) seq.push('hero'); return di(img, ...x); };
    a.draw(t);
    L.drawNotes = dn; L.draw = df; ctx.drawImage = di;
    return seq;
  });
  check(order.join('>') === 'notes>hero>front', `${label}: 流れるノーツは主人公より奥、見出し・判定線は手前（描く順 ${order.join(' → ')}）`);

  // 3. 主人公と重なる位置: ノーツの色が主人公の不透明な部分では見えず、透明な部分では見える
  const overlap = await p.evaluate(async () => {
    const a = window.__app, d = window.__debug;
    // 主人公の見える範囲とレーンが重なる時刻・行を探す（なければ null）
    const L = d.lanes, jx = d.lanesInfo.jx, lead = a.chart.settings.laneLeadSeconds;
    for (const n of a.chart.notes) {
      if (n.input === 'hold') continue;
      const row = ['Y', 'X', 'A', 'B'].indexOf(n.button), y = L.y + row * L.rowH + L.rowH / 2;
      for (let t = n.time - lead; t < n.time; t += 0.02) {
        a.seek(t); a.draw(t);
        const v = window.__debug.visible;
        if (!v || y < v.y || y > v.y + v.h) continue;
        const right = L.x + L.w - 6, x = jx + ((n.time - t) / lead) * (right - jx);
        if (x < v.x || x > v.x + v.w) continue;
        // ノーツの位置の画素: 主人公の不透明な画素（主人公だけを描いた画像のアルファ）と比べる
        const g = a.store.get(window.__debug.frame);
        const r = a.transformFor(g.index, a.geometry()).crop();
        const c = new OffscreenCanvas(Math.ceil(a.cssW), Math.ceil(a.cssH)), cx = c.getContext('2d');
        cx.drawImage(g.bmp, r.x, r.y, r.w, r.h);
        const S = Math.round(L.rowH * 0.86);
        const hero = cx.getImageData(Math.round(x - S / 2), Math.round(y - S / 2), S, S);
        let opaque = 0;
        for (let i = 3; i < hero.data.length; i += 4) if (hero.data[i] > 250) opaque++;
        if (opaque < S * S * 0.15 || opaque > S * S * 0.85) continue; // 主人公の不透明な部分と透明な部分の両方にかかる位置
        const dpr = a.dpr, box = [Math.round((x - S / 2) * dpr), Math.round((y - S / 2) * dpr), Math.round(S * dpr), Math.round(S * dpr)];
        const shot = (noNotes, noHero) => {
          const dn = a.lanes.drawNotes, sg = a.store.get;
          if (noNotes) a.lanes.drawNotes = () => ({});
          if (noHero) a.store.get = () => null;
          a.draw(t);
          a.lanes.drawNotes = dn; a.store.get = sg;
          return a.ctx.getImageData(...box).data;
        };
        const A = shot(false, false), B = shot(true, false), C = shot(false, true), D = shot(true, true);
        a.draw(t);
        const diff = (P, Q, i) => Math.abs(P[i] - Q[i]) + Math.abs(P[i + 1] - Q[i + 1]) + Math.abs(P[i + 2] - Q[i + 2]);
        let heroPx = 0, hidden = 0, notePx = 0, shown = 0;
        for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) {
          const ha = hero.data[(yy * S + xx) * 4 + 3];
          const i = (Math.round(yy * dpr) * box[2] + Math.round(xx * dpr)) * 4;
          if (diff(C, D, i) < 30) continue;          // ノーツが描かれていない画素
          if (ha > 250) { heroPx++; if (diff(A, B, i) < 8) hidden++; }       // 主人公の不透明な画素: ノーツの影響なし
          else if (ha === 0) { notePx++; if (diff(A, C, i) < 8) shown++; }   // 主人公の透明な画素: ノーツがそのまま見える
        }
        if (heroPx < 10 || notePx < 10) continue;
        return { id: n.id, t: +t.toFixed(2), heroPx, coveredByHero: hidden / heroPx, transparentPx: notePx, noteVisibleInTransparent: shown / notePx };
      }
    }
    return null;
  });
  if (overlap) check(overlap.coveredByHero > 0.97 && overlap.noteVisibleInTransparent > 0.97,
    `${label}: 主人公と重なるノーツは主人公の不透明な部分では隠れ、透明な部分ではそのまま見える（四角く隠さない）`, JSON.stringify(overlap));
  else console.log(`--   ${label}: 主人公とノーツが重なる場面なし（描く順の確認のみ）`);

  // 4. 文字の画像の端に描画がない（筆のはみ出し・縁取り・光が切れない）・流れる文字と判定の文字が同じ大きさ
  const glyph = await p.evaluate(() => {
    const a = window.__app, g = a.lanes.glyph, calls = [];
    const dn = g.drawNote.bind(g); g.drawNote = (ctx, ch, x, y, size, ...r) => { calls.push({ ch, x, size }); return dn(ctx, ch, x, y, size, ...r); };
    const n = a.chart.notes.find((x) => x.time > 30);
    const t = n.time - 1; a.seek(t); a.draw(t);
    g.drawNote = dn;
    const jx = window.__debug.lanesInfo.jx;
    let edge = 0, imgs = 0;
    for (const [k, c] of g.cache) {
      if (!/^[nmh]\|/.test(k)) continue;
      imgs++;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
      for (let x = 0; x < W; x++) for (const y of [0, 1, H - 2, H - 1]) if (d[(y * W + x) * 4 + 3] > 8) edge++;
      for (let y = 0; y < H; y++) for (const x of [0, 1, W - 2, W - 1]) if (d[(y * W + x) * 4 + 3] > 8) edge++;
    }
    const head = new Set(calls.filter((c) => c.x < jx).map((c) => c.size)), flow = new Set(calls.filter((c) => c.x > jx).map((c) => c.size));
    return { edge, imgs, head: [...head], flow: [...flow] };
  });
  check(glyph.imgs >= 4 && glyph.edge === 0, `${label}: 行書体の文字の画像の端に描画なし（はみ出し・縁取り・影が切れない）`, `画像 ${glyph.imgs} 枚・端の画素 ${glyph.edge}`);
  check(glyph.head.length === 1 && glyph.flow.length === 1 && glyph.head[0] === glyph.flow[0], `${label}: 流れる文字と左端の判定の文字は同じ大きさ`, `${glyph.head} / ${glyph.flow}`);

  // 5. ボタン配置の案内（上 Y・右 B・下 A・左 X）と強調・余白
  const guide = await p.evaluate(async () => {
    const a = window.__app, { PAD_GUIDE, LANE_STYLE } = await import('/app/lanes.js');
    a.seek(1); a.draw(1);
    const lay = a.lanes._lay, L = window.__debug.lanes, dpr = a.dpr;
    const r = lay.D * 0.19, o = lay.D / 2 - r;
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const rows = ['Y', 'X', 'A', 'B'].map((b, k) => {
      const cy = L.y + k * L.rowH + L.rowH / 2;
      const px = PAD_GUIDE.map(([key, dx, dy]) => {
        const x = lay.dx + dx * o - r * 0.62, y = cy + dy * o; // 文字を避けて円の左寄り
        const d = a.ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
        const c = hex(LANE_STYLE[key].color);
        return { key, on: Math.abs(d[0] - c[0]) + Math.abs(d[1] - c[1]) + Math.abs(d[2] - c[2]) < 60, lum: d[0] + d[1] + d[2] };
      });
      return { b, lit: px.filter((q) => q.on).map((q) => q.key), lumOn: px.find((q) => q.key === b).lum, lumOff: Math.max(...px.filter((q) => q.key !== b).map((q) => q.lum)) };
    });
    a.ctx.font = `800 ${lay.fs}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
    const tw = Math.max(...['Y', 'X', 'A', 'B'].map((b) => a.ctx.measureText(`／${b}`).width));
    return { order: PAD_GUIDE.map(([k, dx, dy]) => `${k}:${dx},${dy}`).join(' '), rows, gapText: lay.dx - lay.D / 2 - (lay.tx + tw), gapJudge: (lay.jx - lay.GS * 0.5) - (lay.dx + lay.D / 2), D: lay.D, rowH: L.rowH };
  });
  check(guide.order === 'Y:0,-1 B:1,0 A:0,1 X:-1,0', `${label}: 案内の配置は 上 Y・右 B・下 A・左 X（固定）`, guide.order);
  check(guide.rows.every((r) => r.lit.length === 1 && r.lit[0] === r.b && r.lumOn > r.lumOff * 1.5), `${label}: 息／Y は上の Y、構／X は左の X、撃／A は下の A、旋／B は右の B だけを色と明るさで強調`,
    guide.rows.map((r) => `${r.b}:${r.lit.join('')}(${r.lumOn}/${r.lumOff})`).join(' '));
  check(guide.gapText >= 3 && guide.gapJudge >= 3 && guide.D < guide.rowH, `${label}: 文字・案内・判定線の間に余白（行の高さに収まる）`, `文字→案内 ${guide.gapText.toFixed(1)}px・案内→判定の文字 ${guide.gapJudge.toFixed(1)}px`);

  // 6. 案内を足しても判定時刻とずれない: 正解の時刻にノーツが判定位置（jx）に描かれる
  const timing = await p.evaluate(() => {
    const a = window.__app, g = a.lanes.glyph, out = [];
    for (const n of a.chart.notes.filter((x) => x.input !== 'hold').slice(0, 6)) {
      const calls = [];
      const dn = g.drawNote.bind(g); g.drawNote = (ctx, ch, x, y, size, ...r) => { calls.push(x); return dn(ctx, ch, x, y, size, ...r); };
      a.seek(n.time - 0.0001); a.newJudge(n.time - 0.0001); a.draw(n.time);
      g.drawNote = dn;
      const jx = window.__debug.lanesInfo.jx;
      out.push(Math.min(...calls.filter((x) => x >= jx - 1).map((x) => Math.abs(x - jx))));
    }
    return out;
  });
  check(timing.every((d) => d < 0.01), `${label}: 正解の時刻にノーツが判定位置に着く（判定時刻とずれない）`, timing.map((d) => d.toFixed(3)).join(','));
  check(errors.length === 0, `${label}: ページエラーなし`, errors.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
