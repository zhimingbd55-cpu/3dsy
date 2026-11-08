import test from 'node:test';
import assert from 'node:assert/strict';
import {promotionUrl,agentPromotionUrl} from '../src/promotion-links.ts';
test('visitor poster retains API-provided attribution and rejects external or malformed paths',()=>{
  assert.equal(promotionUrl('https://tryon.example.test/a/B','/a/A_123-abc'),'https://tryon.example.test/a/A_123-abc');
  for(const value of [null,undefined,'https://bad.invalid/a/x','//bad.invalid','/a/../admin','/a/x?ref=B','/a/x#B','/a/','/a/a/b',42])assert.equal(promotionUrl('https://tryon.example.test',value),'https://tryon.example.test/');
});
test('admin posters have distinct selected-agent URLs regardless of the current browser path',()=>{
  const origin='https://tryon.example.test/a/visitor-A';
  assert.equal(agentPromotionUrl(origin,{code:'agent-A',active:true}),'https://tryon.example.test/a/agent-A');
  assert.equal(agentPromotionUrl(origin,{code:'agent-B',active:true}),'https://tryon.example.test/a/agent-B');
});
test('missing, disabled or malformed agents cannot silently become official posters',()=>{
  assert.throws(()=>agentPromotionUrl('https://tryon.example.test',null),/不存在/);
  for(const active of [false,0,1,'true',null,undefined])assert.throws(()=>agentPromotionUrl('https://tryon.example.test',{code:'agent-A',active}),/停用/);
  for(const code of ['',null,undefined,1,'x/y','x?ref=B','//other.example','a'.repeat(101)])assert.throws(()=>agentPromotionUrl('https://tryon.example.test',{code,active:true}),/无效/);
});
