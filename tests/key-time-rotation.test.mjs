import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {createStore} from '../server/store.mjs';
import {createApiKeys,KEY_TIME_LIMIT} from '../server/api-keys.mjs';
import {createApp} from '../server/app.mjs';
import {attachRealtime} from '../server/realtime.mjs';

const values=['A','B','C','D'].map(letter=>'dct_'+letter.repeat(30)+'DEMO0'+letter);
const good=()=>Response.json({apiKey:'ephemeral-test-token'});
const call=(keys,options)=>keys.token('lucy-vton-3.6',45,'https://example.test',options);
async function fixture(fetcher,count=3){
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-key-time-'));
  assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));
  let now=Date.now();const store=createStore(folder,{minFreeBytes:0,now:()=>now});
  const keys=createApiKeys(store,{apiKey:values[0],fetcher});
  if(count>1)keys.importKeys(values.slice(1,count).join('\n'));
  const row=index=>keys.list().items.find(item=>item.masked.endsWith(values[index].slice(-6)));
  return {folder,store,keys,row,advance:ms=>{now+=ms;},close:async()=>{keys.close();store.close();await rm(folder,{recursive:true,force:true});}};
}

test('the per-key budget is 450 seconds and accumulation shows in list',async()=>{
  const f=await fixture(async()=>good());
  try{
    assert.equal(KEY_TIME_LIMIT.limitSeconds,450);
    assert.equal(f.keys.list().usageLimitSeconds,450);
    f.keys.recordUsage(f.row(0).id,29.5);f.keys.recordUsage(f.row(0).id,30);f.keys.recordUsage(f.row(0).id,0);f.keys.recordUsage(f.row(0).id,-5);
    assert.equal(f.row(0).usedSeconds,59.5);
    assert.equal(f.row(0).active,true);assert.equal(f.keys.list().items.length,3);assert.equal(f.keys.configured(),true);
  }finally{await f.close();}
});

test('reaching 450 seconds switches selection to the next key and deletes the row',async()=>{
  const f=await fixture(async()=>good());
  try{
    const first=f.row(0).id,second=f.row(1).id;
    f.keys.recordUsage(first,440);assert.equal(f.row(0).usedSeconds,440);
    f.keys.recordUsage(first,30);
    const data=f.keys.list();
    assert.equal(data.items.some(x=>x.id===first),false);
    assert.equal(data.activeId,second);
    assert.equal(data.items.find(x=>x.id===second).active,true);
    assert.equal(f.keys.configured(),true);
    await call(f.keys);assert.equal(f.keys.list().activeId,second);
  }finally{await f.close();}
});

test('a single overshooting report retires the key exactly once',async()=>{
  const f=await fixture(async()=>good());
  try{
    const first=f.row(0).id;
    f.keys.recordUsage(first,5000);
    const data=f.keys.list();
    assert.equal(data.items.some(x=>x.id===first),false);
    assert.equal(data.activeId,f.row(1).id);
    f.keys.recordUsage(first,10);
    assert.equal(f.keys.list().items.length,2);
  }finally{await f.close();}
});

test('449 to 450 retires on the boundary and duplicate provider reports add no extra usage',async()=>{
  const f=await fixture(async()=>good());
  try{
    const first=f.row(0).id,retired=[];
    f.keys.recordUsage(first,449);
    await call(f.keys,{tryonId:'boundary',onRetire:reason=>retired.push(reason)});
    assert.equal(f.keys.beginUsage('boundary'),true);
    f.keys.reportUsage('boundary',1);
    f.keys.reportUsage('boundary',1);
    assert.equal(f.keys.list().items.some(item=>item.id===first),false);
    assert.deepEqual(retired,['lifetime_limit']);
    assert.equal(f.store.get('SELECT used_seconds FROM retired_provider_keys WHERE fingerprint IS NOT NULL').used_seconds,450);
    const usage=f.store.get("SELECT billed_seconds,end_reason FROM provider_key_usage WHERE tryon_id='boundary'");
    assert.equal(usage.billed_seconds,1);assert.equal(usage.end_reason,'lifetime_limit');
  }finally{await f.close();}
});

test('simultaneous users sum against the same key budget and retire both leases',async()=>{
  const f=await fixture(async()=>good());
  try{
    const first=f.row(0).id,retired=[];
    f.keys.recordUsage(first,449);
    await call(f.keys,{tryonId:'one',onRetire:reason=>retired.push(['one',reason])});
    await call(f.keys,{tryonId:'two',onRetire:reason=>retired.push(['two',reason])});
    assert.equal(f.keys.beginUsage('one'),true);assert.equal(f.keys.beginUsage('two'),true);
    f.keys.reportUsage('one',.5);f.keys.reportUsage('two',.5);
    assert.equal(f.keys.list().items.some(item=>item.id===first),false);
    assert.deepEqual(retired,[['one','lifetime_limit'],['two','lifetime_limit']]);
    const usage=f.store.all('SELECT tryon_id,billed_seconds,end_reason FROM provider_key_usage ORDER BY tryon_id');
    assert.equal(usage.length,2);assert.ok(usage.every(item=>Math.abs(item.billed_seconds-.5)<.01&&item.end_reason==='lifetime_limit'));
    assert.equal(f.store.get('SELECT used_seconds FROM retired_provider_keys').used_seconds,450);
  }finally{await f.close();}
});

test('a missing cloud report is billed by the local generation clock',async()=>{
  const f=await fixture(async()=>good());
  try{
    const id='missing-report';await call(f.keys,{tryonId:id});assert.equal(f.keys.beginUsage(id),true);
    await new Promise(resolve=>setTimeout(resolve,450));
    f.keys.endUsage(id,'client_disconnect');
    const row=f.store.get('SELECT local_seconds,billed_seconds,end_reason FROM provider_key_usage WHERE tryon_id=?',id);
    assert.ok(row.local_seconds>=.3);assert.ok(row.billed_seconds>=.3);assert.equal(row.end_reason,'client_disconnect');
    assert.ok(f.row(0).usedSeconds>=.3);
  }finally{await f.close();}
});

test('startup conservatively settles an unfinished session instead of clearing its usage',async()=>{
  const f=await fixture(async()=>good());
  try{
    const id='restart-recovery';await call(f.keys,{tryonId:id});assert.equal(f.keys.beginUsage(id),true);f.keys.close();
    f.advance(2000);
    const restarted=createApiKeys(f.store,{apiKey:values[0],fetcher:async()=>good()});
    const row=f.store.get('SELECT local_seconds,billed_seconds,end_reason FROM provider_key_usage WHERE tryon_id=?',id);
    assert.equal(row.end_reason,'service_restart_recovery');assert.ok(row.billed_seconds>=2);assert.ok(restarted.list().items.find(item=>item.id===f.row(0).id).usedSeconds>=2);
    restarted.close();
  }finally{await f.close();}
});

test('automatic selection skips an older 405-second key already marked insufficient',async()=>{
  const used=[];const f=await fixture(async(url,args)=>{used.push(args.headers['x-api-key']);return good();});
  try{
    const active=f.row(0),old=f.row(1);f.keys.recordUsage(old.id,405);f.keys.creditState(old.id,'insufficient');f.keys.activate(active.id);
    f.keys.recordUsage(active.id,450);
    const next=f.row(2);await call(f.keys);
    assert.deepEqual(used,[values[2]]);assert.equal(f.keys.list().activeId,next.id);assert.equal(f.keys.list().items.find(item=>item.id===old.id).usedSeconds,405);
  }finally{await f.close();}
});

test('a non-active key retiring leaves the current selection untouched',async()=>{
  const f=await fixture(async()=>good());
  try{
    const first=f.row(0).id;
    f.keys.activate(f.row(1).id);
    f.keys.recordUsage(first,450);
    const data=f.keys.list();
    assert.equal(data.items.some(x=>x.id===first),false);
    assert.equal(data.activeId,f.row(1).id);
  }finally{await f.close();}
});

test('the last usable key retires, pauses new sessions, and an import restores service',async()=>{
  const f=await fixture(async()=>good(),1);
  try{
    const only=f.row(0).id;
    await call(f.keys);
    f.keys.recordUsage(only,450);
    assert.equal(f.keys.list().items.length,0);
    assert.equal(f.keys.list().activeId,null);
    assert.equal(f.keys.configured(),false);
    await assert.rejects(call(f.keys),e=>e.code==='KEY_MISSING');
    f.keys.importKeys(values[1]);
    const data=f.keys.list();
    assert.equal(data.activeId,data.items[0].id);
    assert.equal(data.items.length,1);assert.equal(data.items[0].usedSeconds,0);
    await call(f.keys);assert.equal(f.keys.configured(),true);
  }finally{await f.close();}
});

test('accumulated seconds persist across restarts',async()=>{
  const f=await fixture(async()=>good());
  try{
    const first=f.row(0).id,second=f.row(1).id;
    f.keys.recordUsage(first,120);
    const restarted=createApiKeys(f.store,{apiKey:values[0],fetcher:async()=>good()});
    assert.equal(restarted.list().items.find(x=>x.id===first).usedSeconds,120);
    assert.equal(restarted.list().activeId,first);
    restarted.recordUsage(first,330);
    assert.equal(restarted.list().items.some(x=>x.id===first),false);
    assert.equal(restarted.list().activeId,second);
  }finally{await f.close();}
});

test('token() sweeps a capped row left behind by an interrupted retire',async()=>{
  const f=await fixture(async()=>good());
  try{
    const first=f.row(0).id;
    f.store.run('UPDATE provider_keys SET used_seconds=? WHERE id=?',450,first);
    assert.equal(f.keys.list().nextId,f.row(1).id);
    await call(f.keys);
    const data=f.keys.list();
    assert.equal(data.items.some(x=>x.id===first),false);
    assert.equal(data.activeId,f.row(1).id);
  }finally{await f.close();}
});

test('a realtime session accrues key usage from generation ticks and retires at the limit',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-key-time-ws-'));
  assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));
  const upstream=http.createServer();
  const upstreamWss=new WebSocketServer({noServer:true});
  upstream.on('upgrade',(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>{
    ws.on('message',raw=>{
      const msg=JSON.parse(raw.toString());
      if(msg.type==='livekit_join')ws.send(JSON.stringify({type:'livekit_room_info'}));
      if(msg.type==='set_image')for(const message of [{type:'set_image_ack',success:true},{type:'generation_started'},{type:'generation_tick',seconds:60},{type:'generation_ended',seconds:60,reason:'completed'}])ws.send(JSON.stringify(message));
    });
  }));
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const context=createApp({dataDirectory:folder,minFreeBytes:0,apiKey:values[0],origin:'http://127.0.0.1',fetcher:async()=>good()});
  context.apiKeys.importKeys(values[1]);
  context.options.upstreamUrl=`ws://127.0.0.1:${upstream.address().port}/v1/stream`;
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);
  const relay=attachRealtime(server,context);context.attach(relay);let ws;
  try{
    await writeFile(context.store.safeFile('files/ref'),'reference');
    context.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,created_at) VALUES ('test','test','ref','files/ref','image/webp','files/ref',1,?)",Date.now());
    const first=context.apiKeys.list().activeId;
    context.apiKeys.recordUsage(first,400);
    const response=await fetch(origin+'/api/me'),cookie=response.headers.get('set-cookie').split(';')[0];
    const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
    await fetch(origin+'/api/me/consent',{method:'POST',headers,body:'{}'});
    const session=await fetch(origin+'/api/tryons',{method:'POST',headers,body:JSON.stringify({garmentId:'test'})}).then(r=>r.json());
    ws=new WebSocket(origin.replace('http','ws')+`/api/realtime/${session.id}/v1/stream`,{headers});
    await once(ws,'open');
    ws.send(JSON.stringify({type:'livekit_join'}));
    ws.send(JSON.stringify({type:'set_image'}));
    await once(ws,'close');
    assert.equal(relay.active.size,0);
    assert.equal(context.store.get('SELECT generation_seconds AS n FROM tryons WHERE id=?',session.id).n,60);
    assert.equal(context.store.get('SELECT seconds AS n FROM usage').n,60);
    const keys=context.apiKeys.list();
    assert.equal(keys.items.some(x=>x.id===first),false);
    assert.equal(keys.items.length,1);
    assert.equal(keys.activeId,keys.items[0].id);
    assert.equal(keys.items[0].usedSeconds,0);
  }finally{
    ws?.terminate();context.close();server.closeAllConnections();await new Promise(r=>server.close(r));
    upstreamWss.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
    await rm(folder,{recursive:true,force:true});
  }
});
