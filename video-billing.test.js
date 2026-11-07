import test from 'node:test';
import assert from 'node:assert/strict';
import { billableSeconds, billedPoints, RATE_POINTS_PER_SECOND } from './video-billing.js';

test('one second costs 0.65 point',()=>{assert.equal(RATE_POINTS_PER_SECOND,0.65);assert.equal(billableSeconds(1),1);assert.equal(billedPoints(1),'0.65');});
test('started seconds round up exactly once',()=>{assert.equal(billedPoints(0.25),'0.65');assert.equal(billedPoints(10),'6.50');assert.equal(billedPoints(10.1),'7.15');assert.equal(billedPoints(30),'19.50');assert.equal(billedPoints(60),'39.00');});
test('zero, negative, infinite and excessively long videos are rejected',()=>{for(const n of [0,-1,NaN,Infinity,1801])assert.throws(()=>billedPoints(n),RangeError);});
