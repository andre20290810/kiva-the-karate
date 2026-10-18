import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const reportPath=new URL('../source/retarget-prototype/pose_quality_audit.json',import.meta.url);
test('pose audit covers entire kata and reports unsafe intervals without invented 3D',{skip:!existsSync(reportPath)},()=>{
 const report=JSON.parse(readFileSync(reportPath,'utf8'));
 assert.equal(report.totalFrames,412);
 assert.equal(report.fps,5);
 assert.ok(report.unreliableFrames>0);
 assert.ok(report.segments.every(s=>s.start<=s.end&&s.frames>0));
 assert.match(report.warning,/Not real 3D/);
});
