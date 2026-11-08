import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionFailureMessage} from '../src/session-failure.ts';

test('an early SDK disconnect uses the authoritative persisted credit failure',async()=>{
  assert.equal(await sessionFailureMessage(new Error('视频连接已断开，请重试。'),async()=>({error:'Decart 账户额度不足，请补充额度。'})),'试衣服务额度不足，请联系管理员。');
});
test('an offline phone retains useful connection guidance without assuming zero credit',async()=>{
  const fallback='视频连接未建立，请切换 Wi-Fi 或移动网络后重试。';
  for(const read of [async()=>{throw Error('offline');},async()=>({error:null})])assert.equal(await sessionFailureMessage(new Error(fallback),read),fallback);
});
test('terminal SDK reasons remain clear even when the cause lookup times out',async()=>{
  assert.equal(await sessionFailureMessage(new Error('insufficient_credits'),async()=>{throw new DOMException('deadline','TimeoutError');}),'试衣服务额度不足，请联系管理员。');
  assert.equal(await sessionFailureMessage(new Error('session_limit')),'云端并发已满，请稍后重试。');
});
test('a persisted timeout is not misclassified as an exhausted key',async()=>{
  assert.equal(await sessionFailureMessage(new Error('Connection closed'),async()=>({error:'连接或生成超时，请重试。'})),'连接或生成超时，请重试。');
});
