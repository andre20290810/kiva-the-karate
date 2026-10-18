import test from 'node:test';import assert from 'node:assert/strict';
import {DISPLAY_MODES,findDisplayMode,canActivateMode} from '../src/display-modes.js';
test('Display modes keep stable IDs: video, two 3D views, two frame-animation views',()=>{
 assert.deepEqual(DISPLAY_MODES.map(x=>x.id),['kiva-video','kiva-3d','alexandre-3d','kiva-frames','alexandre-frames']);
 assert.equal(new Set(DISPLAY_MODES.map(x=>x.id)).size,5);
 assert.deepEqual(DISPLAY_MODES.filter(x=>x.kind==='frames').map(x=>x.character),['kiva','alexandre']);
});
test('All three development views selectable with stable IDs',()=>{
 assert.equal(canActivateMode('kiva-video'),true);
 assert.equal(canActivateMode('kiva-3d'),true);
 assert.equal(canActivateMode('alexandre-3d'),true);
 assert.equal(findDisplayMode('unknown').id,'kiva-video');
});
