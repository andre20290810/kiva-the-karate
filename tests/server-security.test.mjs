import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server,'listening');
  const port=server.address().port;
  server.close();
  await once(server,'close');
  return port;
}

test('dev server protects source footage, dotfiles, Git internals and dependencies', async () => {
  const port = await unusedPort();
  const child = spawn(process.execPath, ['tools/serve.mjs', String(port)], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {...process.env,HOST:'127.0.0.1'},
    windowsHide: true,
    stdio: ['ignore','pipe','pipe'],
  });
  let logs = '';
  child.stdout.on('data',b=>{logs+=b.toString()});
  child.stderr.on('data',b=>{logs+=b.toString()});
  try {
    let ready = false;
    for(let i=0;i<70;i++) {
      if(child.exitCode!=null) throw new Error('server exited: '+logs);
      try {
        const res=await fetch('http://127.0.0.1:'+port+'/');
        if(res.ok){ready=true;break}
      } catch {}
      await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(ready, 'server not ready: '+logs);
    for(const p of ['/source/seipai.mp4','/source/seipai_frames.zip',
      '/source/smoke-ready.png','/.git/config','/node_modules/playwright-core/package.json','/.env']) {
      const res=await fetch('http://127.0.0.1:'+port+p);
      assert.equal(res.status,403, p+' should never be HTTP-accessible');
    }
    const home=await fetch('http://127.0.0.1:'+port+'/index.html');
    assert.equal(home.status,200);
    const game=await fetch('http://127.0.0.1:'+port+'/src/game.js');
    assert.equal(game.status,200);
  } finally {
    child.kill();
    await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,2000))]);
  }
});
