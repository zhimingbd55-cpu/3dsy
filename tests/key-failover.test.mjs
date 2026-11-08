import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createStore} from '../server/store.mjs';
import {createApiKeys,KEY_FAILOVER} from '../server/api-keys.mjs';
import {createApp} from '../server/app.mjs';
import {attachRealtime} from '../server/realtime.mjs';

const values=['A','B','C','D'].map(letter=>'dct_'+letter.repeat(30)+'DEMO0'+letter);
const good=()=>Response.json({apiKey:'ephemeral-test-token'});
const call=(keys,options)=>keys.token('lucy-vton-3.6',45,'https://example.test',options);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const waiting=signal=>new Promise((resolve,reject)=>{
  if(signal.aborted){reject(signal.reason);return;}
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
});
async function fixture(fetcher,count=3){
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-failover-'));
  assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));
  let now=Date.now();const store=createStore(folder,{minFreeBytes:0,now:()=>now});
  const keys=createApiKeys(store,{apiKey:values[0],fetcher});
  if(count>1)keys.importKeys(values.slice(1,count).join('\n'));
  const row=index=>keys.list().items.find(item=>item.masked.endsWith(values[index].slice(-6)));
  return {folder,store,keys,row,advance:ms=>{now+=ms;},close:async()=>{store.close();await rm(folder,{recursive:true,force:true});}};
}

for(const [status,code] of [[401,'INVALID_API_KEY'],[403,'ACCESS_DENIED']])test(`HTTP ${status} disables a key, selects the next key and persists the skip`,async()=>{
  const used=[];const f=await fixture(async(url,args)=>{used.push(args.headers['x-api-key']);assert.equal(JSON.parse(args.body).constraints.realtime.maxSessionDuration,45);return used.at(-1)===values[0]?new Response('',{status}):good();});
  try{
    assert.equal((await call(f.keys)).apiKey,'ephemeral-test-token');assert.deepEqual(used,values.slice(0,2));
    assert.equal(f.row(0).enabled,false);assert.equal(f.row(0).disabledReason,code);assert.equal(f.row(1).active,true);
    await call(f.keys);assert.deepEqual(used,[values[0],values[1],values[1]]);
    const restarted=createApiKeys(f.store,{apiKey:values[0],fetcher:async()=>good()});
    assert.equal(restarted.list().activeId,f.row(1).id);assert.equal(restarted.list().items.find(x=>x.id===f.row(0).id).enabled,false);
  }finally{await f.close();}
});

for(const [name,response,code] of [
  ['network failure',()=>{throw new TypeError('network unreachable');},'NETWORK_ERROR'],
  ['HTTP 503',()=>new Response('',{status:503}),'PROVIDER_ERROR'],
  ['malformed JSON',()=>new Response('{broken'),'INVALID_RESPONSE'],
  ['JSON null',()=>Response.json(null),'INVALID_RESPONSE'],
  ['missing token',()=>Response.json({apiKey:''}),'INVALID_RESPONSE'],
  ['permanent key echoed as token',()=>Response.json({apiKey:values[0]}),'INVALID_RESPONSE'],
])test(`${name} cools down the faulty key and selects a usable replacement`,async()=>{
  const used=[];const f=await fixture(async(url,args)=>{const key=args.headers['x-api-key'];used.push(key);return key===values[0]?response():good();});
  try{
    await call(f.keys);assert.deepEqual(used,values.slice(0,2));
    assert.equal(f.row(0).enabled,true);assert.equal(f.row(0).disabledReason,null);assert.equal(f.row(0).lastCode,code);
    assert.equal(f.row(0).retryAt,f.store.now()+60000);assert.equal(f.row(1).active,true);
    f.keys.activate(f.row(0).id);await call(f.keys);assert.equal(used.at(-1),values[1]);
  }finally{await f.close();}
});

test('all temporarily failed keys block new sessions until the cooldown expires',async()=>{
  let fail=true,calls=0;const f=await fixture(async()=>{calls++;return fail?new Response('',{status:503}):good();},1);
  try{
    await assert.rejects(call(f.keys),e=>e.code==='PROVIDER_ERROR');assert.equal(f.keys.configured(),false);
    await assert.rejects(call(f.keys),e=>e.code==='KEY_UNAVAILABLE');assert.equal(calls,1);
    fail=false;f.advance(KEY_FAILOVER.cooldownMs);assert.equal(f.keys.configured(),true);
    await call(f.keys);assert.equal(calls,2);assert.equal(f.row(0).retryAt,0);assert.equal(f.row(0).lastCode,'OK');
  }finally{await f.close();}
});

test('upgrading the previous schema preserves encrypted keys and manual selection',async()=>{
  const f=await fixture(async()=>good());
  try{
    f.keys.activate(f.row(1).id);const before=f.store.all('SELECT id,encrypted FROM provider_keys ORDER BY id');
    for(const column of ['retry_at','disabled_reason','revision'])f.store.db.exec(`ALTER TABLE provider_keys DROP COLUMN ${column}`);
    f.store.db.exec('ALTER TABLE provider_key_config DROP COLUMN revision');
    const migrated=createApiKeys(f.store,{apiKey:values[0],fetcher:async()=>good()});
    assert.deepEqual(f.store.all('SELECT id,encrypted FROM provider_keys ORDER BY id'),before);
    assert.equal(migrated.list().activeId,f.row(1).id);assert.equal(migrated.configured(),true);await call(migrated);
  }finally{await f.close();}
});

test('manual disable during a request remains a deliberate pause after a late failure',async()=>{
  const started=deferred(),pending=deferred();let calls=0;
  const f=await fixture(async()=>{calls++;started.resolve();return pending.promise;});
  try{
    const request=call(f.keys);await started.promise;f.keys.update(f.row(0).id,{enabled:false});
    pending.resolve(new Response('',{status:401}));await assert.rejects(request);
    assert.equal(calls,1);assert.equal(f.keys.configured(),false);assert.equal(f.keys.list().activeId,null);
    assert.equal(f.row(0).disabledReason,null);assert.equal(f.row(0).lastCode,null);
  }finally{await f.close();}
});

test('a single request attempts at most three keys even when more exist',async()=>{
  const used=[];const f=await fixture(async(url,args)=>{used.push(args.headers['x-api-key']);return new Response('',{status:401});},4);
  try{
    await assert.rejects(call(f.keys),e=>e.code==='INVALID_API_KEY');assert.deepEqual(used,values.slice(0,3));
    assert.ok([0,1,2].every(n=>!f.row(n).enabled));assert.equal(f.row(3).lastCode,null);
    assert.equal(f.keys.list().nextId,f.row(3).id);
  }finally{await f.close();}
});

for(const [status,code] of [[402,'INSUFFICIENT_CREDITS'],[429,'RATE_LIMITED'],[422,'INVALID_PARAMETERS'],[400,'PROVIDER_ERROR']])test(`HTTP ${status} stops the current request without retrying another key`,async()=>{
  const used=[];const f=await fixture(async(url,args)=>{used.push(args.headers['x-api-key']);return new Response('',{status});});
  try{
    await assert.rejects(call(f.keys),e=>e.code===code);
    assert.deepEqual(used,[values[0]]);assert.equal(f.row(0).active,true);assert.equal(f.row(0).enabled,true);assert.equal(f.row(0).retryAt,0);
    if(status===402){assert.equal(f.row(0).creditState,'insufficient');await assert.rejects(call(f.keys),e=>e.code===code);assert.deepEqual(used,[values[0],values[1]]);}
  }finally{await f.close();}
});

test('a replacement with exhausted credits stops the request and is skipped on the next try-on',async()=>{
  const used=[];const f=await fixture(async(url,args)=>{used.push(args.headers['x-api-key']);return new Response('',{status:used.at(-1)===values[0]?401:402});});
  try{
    await assert.rejects(call(f.keys),e=>e.code==='INSUFFICIENT_CREDITS');
    await assert.rejects(call(f.keys),e=>e.code==='INSUFFICIENT_CREDITS');
    assert.deepEqual(used,[values[0],values[1],values[2]]);assert.equal(f.row(2).creditState,'insufficient');assert.equal(f.row(3),undefined);
  }finally{await f.close();}
});

test('manual selection during a failed in-flight request prevents further automatic switching',async()=>{
  const started=deferred(),pending=deferred(),used=[];
  const f=await fixture(async(url,args)=>{used.push(args.headers['x-api-key']);started.resolve();return pending.promise;});
  try{
    const request=call(f.keys);await started.promise;f.keys.activate(f.row(2).id);
    pending.resolve(new Response('',{status:401}));await assert.rejects(request,e=>e.code==='INVALID_API_KEY');
    assert.deepEqual(used,[values[0]]);assert.equal(f.row(2).active,true);
  }finally{await f.close();}
});

test('an old success does not re-enable a key disabled by a concurrent failure',async()=>{
  const started=deferred(),pending=deferred();let calls=0;
  const f=await fixture(async(url,args)=>{if(++calls===1){started.resolve();return pending.promise;}return args.headers['x-api-key']===values[0]?new Response('',{status:401}):good();});
  try{
    const old=call(f.keys);await started.promise;await call(f.keys);pending.resolve(good());await old;
    assert.equal(f.row(0).enabled,false);assert.equal(f.row(0).lastCode,'INVALID_API_KEY');assert.equal(f.row(1).active,true);
  }finally{await f.close();}
});

test('cancellation aborts the request without a health penalty or a replacement attempt',async()=>{
  const started=deferred(),controller=new AbortController();let calls=0,requestSignal;
  const f=await fixture(async(url,args)=>{calls++;requestSignal=args.signal;started.resolve();return waiting(args.signal);});
  try{
    const request=call(f.keys,{signal:controller.signal});await started.promise;controller.abort();
    await assert.rejects(request,e=>e.name==='AbortError');assert.equal(requestSignal.aborted,true);
    assert.equal(calls,1);assert.equal(f.row(0).lastUsedAt,null);assert.equal(f.row(0).retryAt,0);assert.equal(f.row(0).enabled,true);
  }finally{await f.close();}
});

test('unresponsive requests respect per-key timeouts and the shared 12-second budget',{timeout:16000},async()=>{
  const signals=[],started=Date.now(),keepAlive=setInterval(()=>{},1000);
  const f=await fixture(async(url,args)=>{signals.push(args.signal);return waiting(args.signal);},4);
  try{
    await assert.rejects(call(f.keys),e=>e.code==='NETWORK_ERROR');
    const elapsed=Date.now()-started;assert.ok(elapsed>=11500&&elapsed<14500,`elapsed=${elapsed}`);
    assert.equal(signals.length,3);assert.ok(signals.every(signal=>signal.aborted));assert.equal(f.row(3).lastUsedAt,null);
  }finally{clearInterval(keepAlive);await f.close();}
});

test('browser disconnect cancels token acquisition and releases the unused session quota',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-failover-ws-'));
  assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));
  const started=deferred(),aborted=deferred();let calls=0;
  const context=createApp({dataDirectory:folder,minFreeBytes:0,apiKey:values[0],origin:'http://127.0.0.1',fetcher:async(url,args)=>{
    calls++;args.signal.addEventListener('abort',()=>aborted.resolve(),{once:true});started.resolve();return waiting(args.signal);
  }});
  context.apiKeys.importKeys(values[1]);
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);
  const relay=attachRealtime(server,context);context.attach(relay);let ws;
  try{
    await writeFile(context.store.safeFile('files/ref'),'reference');
    context.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,created_at) VALUES ('test','test','ref','files/ref','image/webp','files/ref',1,?)",Date.now());
    const response=await fetch(origin+'/api/me'),cookie=response.headers.get('set-cookie').split(';')[0];
    const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
    await fetch(origin+'/api/me/consent',{method:'POST',headers,body:'{}'});
    const session=await fetch(origin+'/api/tryons',{method:'POST',headers,body:JSON.stringify({garmentId:'test'})}).then(r=>r.json());
    ws=new WebSocket(origin.replace('http','ws')+`/api/realtime/${session.id}/v1/stream`,{headers});
    const opened=once(ws,'open');await Promise.all([opened,started.promise]);const closed=once(ws,'close');ws.close();await closed;await aborted.promise;
    assert.equal(calls,1);assert.equal(relay.active.size,0);
    const row=context.store.get('SELECT status,charged,reserved_bytes,error FROM tryons WHERE id=?',session.id);
    assert.equal(row.status,'failed');assert.equal(row.charged,0);assert.equal(row.reserved_bytes,0);assert.equal(row.error,null);
    assert.equal((await fetch(origin+'/api/me',{headers}).then(r=>r.json())).remaining,3);
    assert.equal(context.apiKeys.list().items.find(x=>x.active).lastCode,null);
  }finally{ws?.terminate();context.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(folder,{recursive:true,force:true});}
});
