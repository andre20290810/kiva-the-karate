// Responsive layout / rotation regression for desktop Edge (Playwright Core).
// Run with npm run test:layout after "npm start" (PORT=8177).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const localEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const linuxChromium = '/opt/pw-browsers/chromium';
const executablePath = process.env.CHROME_PATH || (existsSync(localEdge) ? localEdge : existsSync(linuxChromium) ? linuxChromium : undefined);
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const base = (process.env.BASE || 'http://127.0.0.1:8177/') + (process.env.CHART ? `?chart=${encodeURIComponent(process.env.CHART)}` : '');
const shots = process.env.SHOTS || 'source/rotation-shots';
mkdirSync(shots, { recursive: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
page.on('pageerror', e => { throw e; });

const screens = [
  ['phone-portrait', 390, 844],
  ['small-phone-portrait', 320, 568],
  ['short-phone-portrait', 320, 480],
  ['phone-landscape', 844, 390],
  ['small-phone-landscape', 568, 320],
  ['compact-landscape', 667, 375],
  ['tablet-portrait', 768, 1024],
  ['tablet-landscape', 1024, 768],
  ['desktop', 1280, 800],
  ['desktop-fullhd', 1920, 1080],
  ['tiny-landscape', 480, 320],
];

const rect = r => ({
  x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
});
const overlap = (a, b) => a.x < b.right - .5 && b.x < a.right - .5 && a.y < b.bottom - .5 && b.y < a.bottom - .5;

function requireVisible(label, key, dims, width, height) {
  const r = dims[key];
  assert.ok(r && r.width >= 1 && r.height >= 1, label + ': missing ' + key);
  assert.ok(r.x >= -.5 && r.y >= -.5 && r.right <= width + .5 && r.bottom <= height + .5,
    label + ': offscreen ' + key + ': ' + JSON.stringify(r));
}

async function measure(label, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(220);
  const m = await page.evaluate(() => {
    const selectors = ['#hud','#stageWrap','#stage','#side','#track','#pad','#controls',
      '#btnStart','#btnPause','#btnRestart','#status', ...Array.from({length: 4}, (_,i)=>'#pad .face:nth-child('+(i+1)+')')];
    const boxes = Object.fromEntries(selectors.map(s => {
      const r = document.querySelector(s).getBoundingClientRect();
      return [s, { x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height }];
    }));
    const inside = s => {
      const r = boxes[s];
      return r.x >= -.5 && r.y >= -.5 && r.right <= innerWidth+.5 && r.bottom <= innerHeight+.5;
    };
    const stage = document.querySelector('#stage');
    const track = document.querySelector('#track');
    return {
      width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      stagePixels: [stage.width,stage.height],
      trackPixels: [track.width,track.height],
      state: window.__game.state,
      boxes, sideScrollHeight: document.querySelector('#side').scrollHeight,
      sideClientHeight: document.querySelector('#side').clientHeight,
      settingsOpen: document.querySelector('#settings').open,
      settingsHidden: getComputedStyle(document.querySelector('.settings')).display === 'none',
    };
  });
  assert.equal(m.width, w, label + ' viewport width');
  assert.equal(m.height, h, label + ' viewport height');
  assert.equal(m.scrollWidth, w, label + ' horizontal page scroll');
  assert.equal(m.scrollHeight, h, label + ' vertical page scroll');
  for (const key of ['#hud','#stageWrap','#side','#track','#pad','#btnStart','#btnPause','#btnRestart','#status']) {
    requireVisible(label, key, m.boxes, w, h);
  }
  for (let i = 1; i <= 4; i++) {
    const k = '#pad .face:nth-child(' + i + ')';
    requireVisible(label, k, m.boxes, w, h);
    assert.ok(m.boxes[k].width >= 40 && m.boxes[k].height >= 40, label + ' touch target ' + i);
  }
  assert.ok(m.boxes['#stage'].height >= 150, label + ': stage too short');
  assert.ok(!overlap(m.boxes['#stage'],m.boxes['#side']), label + ': stage/side overlap');
  assert.ok(!overlap(m.boxes['#stage'],m.boxes['#hud']),label+ ': stage/HUD overlap');
  assert.ok(!overlap(m.boxes['#track'],m.boxes['#pad']),label+ ': track/pad overlap');
  assert.ok(m.stagePixels[0] >= m.boxes['#stage'].width*.95 &&
    m.stagePixels[1] >= m.boxes['#stage'].height*.95,label+ ': stage canvas stale after rotation');
  assert.ok(m.settingsHidden && !m.settingsOpen,label+ ': closed settings occupy space');
  console.log('PASS '+label+' '+w+'x'+h+' stage='+Math.round(m.boxes['#stage'].width)+'x'+Math.round(m.boxes['#stage'].height));
  await page.screenshot({ path:join(shots,label+'.png') });
  return m;
}

try {
  await page.goto(base, { waitUntil:'domcontentloaded' });
  await page.waitForFunction(()=>['ready','error'].includes(window.__game?.state),null,{timeout:90000});
  const st=await page.evaluate(()=>window.__game.state);
  assert.equal(st,'ready',await page.locator('#status').textContent());
  for(const [label,w,h] of screens) await measure(label,w,h);

  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(100);
  await page.locator('#settings summary').click();
  assert.equal(await page.locator('#settings').evaluate(e=>e.open),true,'advanced settings expand');
  assert.equal(await page.locator('#volume').isVisible(),true);
  await page.locator('#volume').fill('0.6');
  await page.locator('#settings summary').click();
  assert.equal(await page.locator('#settings').evaluate(e=>e.open),false);

  await page.click('#btnStart');
  await page.waitForTimeout(650);
  const before = await page.evaluate(()=>window.__game.clock.now());
  assert.equal(await page.evaluate(()=>window.__game.state),'playing');

  for(const [label,w,h] of [['rotate-landscape',844,390],['rotate-portrait',390,844]]) {
    await measure(label,w,h);
    assert.equal(await page.evaluate(()=>window.__game.state),'playing',label+' playback interrupted');
  }
  const after = await page.evaluate(()=>window.__game.clock.now());
  assert.ok(after>before+0.3,'audio timeline stopped during rotation');
  await page.locator('#btnPause').click();
  assert.equal(await page.evaluate(()=>window.__game.state),'paused','pause after rotation');
  const pausedTime = await page.evaluate(()=>window.__game.clock.now());
  await page.waitForTimeout(250);
  assert.ok(Math.abs((await page.evaluate(()=>window.__game.clock.now()))-pausedTime)<.01,'paused time drift');
  console.log('PASS rotation keeps playback, timing and controls intact');
} finally {
  await browser.close();
}
