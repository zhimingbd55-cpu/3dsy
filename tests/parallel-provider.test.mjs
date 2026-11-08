import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WebSocket,WebSocketServer} from 'ws';
import {createStore} from '../server/store.mjs';
import {createApiKeys} from '../server/api-keys.mjs';
import {attachParallelProvider} from '../server/parallel-provider.mjs';

const key='dct_'+ 'X'.repeat(30)+'BROKER',bridge='test-bridge-token-'.repeat(3);
async function until(check){const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw new Error('wait timed out');await new Promise(r=>setTimeout(r,10));}}
async function fixture(run,{fetcher}={}){
  const folder=await mkdtemp(path.join(os.tmpdir(),'parallel-broker-'));let time=Date.now();
  const store=createStore(folder,{minFreeBytes:0,now:()=>time}),tokens=[];
  const apiKeys=createApiKeys(store,{apiKey:key,fetcher:fetcher||(async(url,init)=>{tokens.push(JSON.parse(init.body));return Response.json({apiKey:'temporary-test-token'});})});
  const cloud=new WebSocketServer({port:0,host:'127.0.0.1'});await once(cloud,'listening');const upstreams=[];
  cloud.on('connection',(ws,req)=>{upstreams.push(ws);ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='livekit_join')ws.send(JSON.stringify({type:'livekit_room_info',server_url:'wss://room.test',token:'room-test-token'}));if(m.type==='set_image')ws.send(JSON.stringify({type:'set_image_ack',success:true}));});});
  const server=http.createServer(),broker=attachParallelProvider(server,{store,apiKeys,options:{parallelAdminBridgeToken:bridge,parallelPublicOrigin:'https://mirror.test',parallelUpstreamUrl:`ws://127.0.0.1:${cloud.address().port}`}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const clients=[],connect=(id=randomUUID(),headers={})=>{const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/internal/parallel-provider/${id}`,{headers:{Authorization:`Bearer ${bridge}`,...headers}});clients.push(ws);ws.events=[];ws.on('message',raw=>ws.events.push(JSON.parse(raw)));return ws;};
  try{await run({store,apiKeys,broker,tokens,upstreams,connect,advance:ms=>time+=ms});}
  finally{broker.close();for(const ws of clients)ws.terminate();for(const ws of upstreams)ws.terminate();await new Promise(r=>cloud.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));apiKeys.close();store.close();await rm(folder,{recursive:true,force:true});}
}
test('broker mints only Lucy2.5 bounded token and proxies paired prompt/image without root key exposure',()=>fixture(async({connect,tokens,upstreams,store,apiKeys})=>{
  const id=randomUUID(),ws=connect(id);await once(ws,'open');ws.send(JSON.stringify({type:'livekit_join',passthrough:false}));ws.send(JSON.stringify({type:'set_image',image_data:'cmVmZXJlbmNl',prompt:'A complete paired look.',enhance_prompt:false}));
  await until(()=>ws.events.some(m=>m.type==='set_image_ack'));
  assert.deepEqual(tokens[0].allowedModels,['lucy-2.5']);assert.deepEqual(tokens[0].allowedOrigins,['https://mirror.test']);assert.equal(tokens[0].constraints.realtime.maxSessionDuration,105);
  upstreams[0].send(JSON.stringify({type:'generation_started'}));upstreams[0].send(JSON.stringify({type:'generation_tick',seconds:90}));await until(()=>apiKeys.list().items[0].usedSeconds>=90);
  upstreams[0].send(JSON.stringify({type:'generation_tick',seconds:90}));await new Promise(r=>setTimeout(r,20));assert.ok(apiKeys.list().items[0].usedSeconds<90.2);
  assert.doesNotMatch(JSON.stringify(ws.events),new RegExp(key+'|temporary-test-token'));
  ws.close();await until(()=>store.get('SELECT ended_at FROM provider_key_usage WHERE tryon_id=?',`parallel:${id}`)?.ended_at);
  const row=store.get('SELECT * FROM provider_key_usage WHERE tryon_id=?',`parallel:${id}`);assert.equal(row.source,'parallel-self');assert.equal(row.limit_seconds,105);assert.ok(row.billed_seconds>=90);
}));
test('shared 450 guard terminates old and new project leases together without generating again',()=>fixture(async({connect,apiKeys,upstreams,store})=>{
  const oldId=randomUUID();let oldRetired=false;await apiKeys.token('lucy-vton-3.6',45,'https://old.test',{tryonId:oldId,onRetire:()=>oldRetired=true});apiKeys.beginUsage(oldId);
  const ws=connect();await once(ws,'open');await until(()=>upstreams.length===1);upstreams[0].send(JSON.stringify({type:'generation_started'}));await until(()=>store.get("SELECT COUNT(*) n FROM provider_key_usage WHERE source='parallel-self' AND clock_started=1").n===1);
  const keyId=apiKeys.list().activeId;apiKeys.recordUsage(keyId,449);apiKeys.reportUsage(oldId,1);
  await until(()=>oldRetired&&ws.events.some(m=>m.reason==='lifetime_limit'));
  assert.equal(apiKeys.list().items.length,0);assert.equal(apiKeys.list().retired[0].usedSeconds,450);
  assert.equal(store.get('SELECT COUNT(*) n FROM provider_key_usage WHERE ended_at IS NULL').n,0);
}));
test('broker rejects missing credentials, browser-origin requests, forwarded requests and duplicate sessions',()=>fixture(async({connect})=>{
  for(const headers of [{Authorization:'Bearer invalid'},{Origin:'https://mirror.test'},{'X-Forwarded-For':'127.0.0.1'},{Cookie:'admin=anything'}]){
    const ws=connect(randomUUID(),headers);const [error]=await once(ws,'error');assert.match(error.message,/403/);
  }
  const id=randomUUID(),ws=connect(id);await once(ws,'open');ws.close();await once(ws,'close');
  const repeat=connect(id);const [error]=await once(repeat,'error');assert.match(error.message,/403/);
}));
test('external slots are limited to two independently of old user rows',()=>fixture(async({connect})=>{
  const a=connect(),b=connect();await Promise.all([once(a,'open'),once(b,'open')]);const c=connect();const [error]=await once(c,'error');assert.match(error.message,/403/);
}));
for(const status of [402,429])test(`broker HTTP ${status} stops without another key/token attempt`,async()=>{
  let count=0;await fixture(async({connect})=>{const ws=connect();await once(ws,'open');await until(()=>ws.events.some(m=>m.type==='error'));assert.equal(ws.events.find(m=>m.type==='error').code,status===402?'INSUFFICIENT_CREDITS':'RATE_LIMITED');assert.equal(count,1);},{fetcher:async()=>{count++;return new Response('{}',{status});}});
});
test('late token success cannot resurrect a retired broker session',async()=>{
  let release;await fixture(async({connect,apiKeys,upstreams})=>{
    const ws=connect();await once(ws,'open');await until(()=>release);apiKeys.recordUsage(apiKeys.list().activeId,450);release(Response.json({apiKey:'late-temporary-token'}));
    await until(()=>ws.events.some(m=>m.reason==='lifetime_limit'));await new Promise(r=>setTimeout(r,30));assert.equal(upstreams.length,0);
  },{fetcher:()=>new Promise(resolve=>release=resolve)});
});
test('restart conservatively settles a persisted external token lease up to 105 seconds without a tryons row',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'parallel-usage-'));let now=Date.now();const store=createStore(folder,{minFreeBytes:0,now:()=>now});let keys=createApiKeys(store,{apiKey:key,fetcher:async()=>Response.json({apiKey:'external-temporary-token'})});
  try{
    const id=`parallel:${randomUUID()}`;await keys.token('lucy-2.5',105,'https://mirror.test',{tryonId:id,usageSource:'parallel-self',usageLimitSeconds:105,usageDeadlineAt:now+105000});keys.close();now+=300000;
    keys=createApiKeys(store,{apiKey:key,fetcher:async()=>{throw new Error('must not call');}});
    const row=store.get('SELECT * FROM provider_key_usage WHERE tryon_id=?',id);assert.equal(row.end_reason,'service_restart_recovery');assert.equal(row.billed_seconds,105);assert.equal(keys.list().items[0].usedSeconds,105);assert.equal(store.get('SELECT COUNT(*) n FROM tryons').n,0);
  }finally{keys.close();store.close();await rm(folder,{recursive:true,force:true});}
});
