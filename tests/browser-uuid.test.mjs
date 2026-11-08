import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {browserUuid} from '../src/browser-uuid.ts';

const pattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
test('native UUID keeps its crypto receiver and does not need the fallback',()=>{
  const expected='a9b2940f-bde3-471e-b3e2-f1dc8e7e4468';
  const source={randomUUID(){assert.equal(this,source);return expected;},getRandomValues(){throw Error('fallback not expected');}};
  assert.equal(browserUuid(source),expected);
});
test('secure byte fallback writes v4 version and RFC variant while retaining all other random bytes',()=>{
  const source={getRandomValues(bytes){assert.equal(this,source);assert.equal(bytes.byteLength,16);bytes.fill(255);return bytes;}};
  assert.equal(browserUuid(source),'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(browserUuid({getRandomValues:bytes=>bytes.fill(0)}),'00000000-0000-4000-8000-000000000000');
});
test('a blocked native method falls back to secure bytes, never an insecure generator',()=>{
  let calls=0;const source={randomUUID(){throw new Error('blocked native method');},getRandomValues(bytes){calls++;return webcrypto.getRandomValues(bytes);}};
  assert.match(browserUuid(source),pattern);assert.equal(calls,1);
  assert.throws(()=>browserUuid({}),/安全随机/);
  assert.throws(()=>browserUuid({getRandomValues(){throw new Error('secure generator failed');}}),/secure generator failed/);
});
test('fallback generates distinct valid identifiers with the actual secure byte source',()=>{
  const source={getRandomValues:bytes=>webcrypto.getRandomValues(bytes)},ids=Array.from({length:1000},()=>browserUuid(source));
  assert(ids.every(value=>pattern.test(value)));assert.equal(new Set(ids).size,ids.length);
});
test('upload lock module initializes on a browser with only getRandomValues',async t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:bytes=>webcrypto.getRandomValues(bytes)}});
  t.after(()=>Object.defineProperty(globalThis,'crypto',previous));
  const lock=await import('../src/upload-lock.ts?uuid-fallback-regression');
  assert.equal(typeof lock.holdUploadLock,'function');assert.match(browserUuid(),pattern);
});
