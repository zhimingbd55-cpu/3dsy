import test from 'node:test';
import assert from 'node:assert/strict';
import {watchConnection} from '../src/connection-watch.ts';
globalThis.window=globalThis;

test('a failure missed by the SDK releases the waiting screen once',async()=>{
  const messages=[];let reads=0;
  await watchConnection(async()=>++reads===1?{status:'connecting'}:{status:'failed',error:'服装参考图处理失败，请更换图片重试。'},()=>true,m=>messages.push(m),new AbortController().signal,1);
  assert.equal(reads,2);assert.deepEqual(messages,['服装参考图处理失败，请更换图片重试。']);
});

test('a transient lookup failure does not fabricate a session failure',async()=>{
  let reads=0;const messages=[];
  await watchConnection(async()=>{if(++reads===1)throw Error('offline');return {status:'failed',error:'cloud failed'};},()=>true,m=>messages.push(m),new AbortController().signal,1);
  assert.equal(reads,2);assert.deepEqual(messages,['cloud failed']);
});

test('an old response cannot end a newer try-on',async()=>{
  let active=true;const messages=[];
  await watchConnection(async()=>{active=false;return {status:'failed',error:'old failure'};},()=>active,m=>messages.push(m),new AbortController().signal,1);
  assert.deepEqual(messages,[]);
});

test('cancellation aborts a pending delay without another session read',async()=>{
  const controller=new AbortController();let reads=0;
  const waiting=watchConnection(async()=>{reads++;return {status:'failed'};},()=>true,()=>assert.fail('cancelled'),controller.signal,5000);
  controller.abort();await waiting;assert.equal(reads,0);
});
