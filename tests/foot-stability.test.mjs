import test from 'node:test';
import assert from 'node:assert/strict';
import {smoothFootCorrections,correctionAt} from '../src/foot-stability.js';
test('floor correction is bounded and smooths isolated tracking spikes',()=>{
 const raw=[-0.145,-0.15,-0.155,0.7,-0.15,-0.145,-0.14];
 const result=smoothFootCorrections(raw);
 assert.equal(result.length,raw.length);
 assert.ok(result.every(x=>Number.isFinite(x)&&Math.abs(x)<=.24));
 assert.ok(Math.abs(result[3])<.04,'single frame spike should be suppressed');
});
test('missing foot measurements and interpolation stay finite',()=>{
 const result=smoothFootCorrections([NaN,-0.1,Infinity,-0.2,-0.15]);
 assert.ok(result.every(Number.isFinite));
 assert.equal(correctionAt([0,0.2],.1,5),.1);
 assert.equal(correctionAt([],1),0);
});
