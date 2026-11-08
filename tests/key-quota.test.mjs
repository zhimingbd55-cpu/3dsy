import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createStore} from '../server/store.mjs';import {createApiKeys} from '../server/api-keys.mjs';import {createProvider} from '../server/provider.mjs';
const key='dct_'+'A'.repeat(32)+'DEMO1';
async function fixture(t,fetcher){const dir=await mkdtemp(path.join(os.tmpdir(),'amen-quota-'));let now=Date.now();const store=createStore(dir,{minFreeBytes:0,now:()=>now}),keys=createApiKeys(store,{apiKey:key,fetcher});t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return {store,keys,id:keys.list().activeId,advance:ms=>{now+=ms;}};}
test('quota reads preserve unknown counters, redact secrets, coalesce requests and cache for 30 seconds',async t=>{
 let calls=0;const f=await fixture(t,async(url,args)=>{calls++;assert.equal(url,'https://api.decart.ai/v1/realtime/quota');assert.equal(args.headers['x-api-key'],key);await new Promise(r=>setTimeout(r,20));return Response.json({limit:null,active:null,remaining:null,secret:key});});
 await Promise.all([f.keys.refreshQuota(f.id),f.keys.refreshQuota(f.id)]);assert.equal(calls,1);const row=f.keys.list().items[0];assert.deepEqual(row.quota,{limit:null,active:null,remaining:null});assert.equal(row.creditState,'unknown');assert.equal(row.lastCode,null);assert.ok(!JSON.stringify(f.keys.list()).includes(key));
 await f.keys.refreshQuota(f.id);assert.equal(calls,1);f.advance(31000);await f.keys.refreshQuota(f.id);assert.equal(calls,2);
});
test('invalid quota responses and failed queries never become zero balances or alter key selection',async t=>{
 for(const data of [{limit:2,active:0}, {limit:'2',active:0,remaining:2},{limit:2,active:-1,remaining:3}])await assert.rejects(createProvider(key,async()=>Response.json(data)).quota(),e=>e.code==='INVALID_RESPONSE');
 const f=await fixture(t,async()=>new Response('',{status:429}));await f.keys.refreshQuota(f.id);const row=f.keys.list().items[0];assert.equal(row.quota,null);assert.equal(row.quotaCode,'RATE_LIMITED');assert.equal(row.creditState,'unknown');assert.equal(row.enabled,true);assert.equal(row.active,true);
});
test('exhausted credits are visible and stop calls instead of rotating accounts; quota success cannot erase the warning',async t=>{
 let tokenCalls=0;const f=await fixture(t,async url=>{if(url.endsWith('/quota'))return Response.json({limit:4,active:0,remaining:4});tokenCalls++;return new Response('',{status:402});});f.keys.importKeys('dct_'+'B'.repeat(38));
 await assert.rejects(f.keys.token('lucy-vton-3.6',45,'https://example.test'),e=>e.code==='INSUFFICIENT_CREDITS');assert.equal(tokenCalls,1);assert.equal(f.keys.list().activeId,f.id);assert.equal(f.keys.list().items.find(x=>x.id===f.id).creditState,'insufficient');
 await f.keys.refreshQuota(f.id);assert.equal(f.keys.list().items.find(x=>x.id===f.id).creditState,'insufficient');f.keys.creditState(f.id,'unknown');assert.equal(f.keys.list().items.find(x=>x.id===f.id).creditState,'unknown');
});
