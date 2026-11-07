import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestedPoints, validOrderId, cleanRemark, MAX_ORDER_POINTS, MAX_WALLET_POINTS } from './credit-core.js';

test('only bounded integer credit requests are accepted',()=>{
  for (const x of [1,100,MAX_ORDER_POINTS]) assert.equal(parseRequestedPoints(x),x);
  for (const x of [-5,0,MAX_ORDER_POINTS+1,1.5,NaN,Infinity,'100',null,{},true]) assert.equal(parseRequestedPoints(x),null);
  assert.equal(MAX_WALLET_POINTS,10000000);
});
test('order IDs must be UUIDs',()=>{
  assert.equal(validOrderId('49cb2974-c947-4078-b540-898bbda9ffc4'),true);
  for(const id of ['','../a','__proto__','49cb2974-c947-4078-b540-898bbda9ffc4 AND 1=1',null])assert.equal(validOrderId(id),false);
});
test('remarks reject control characters and overly long input',()=>{
  assert.equal(cleanRemark('  联系管理员  '),'联系管理员');
  assert.equal(cleanRemark(undefined),'');
  assert.equal(cleanRemark('x'.repeat(201)),null);
  assert.equal(cleanRemark('a\nb'),null);
  assert.equal(cleanRemark({x:1}),null);
});
