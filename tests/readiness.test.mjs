import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { attachRealtime } from '../server/realtime.mjs';

test('a queued try-on accepts a fresh three-second readiness report after admission and defaults to garment category', async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'amen-ready-'));
  const context=createApp({dataDirectory:directory,minFreeBytes:0,apiKey:'mock',origin:'http://127.0.0.1'});
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);const realtime=attachRealtime(server,context);context.attach(realtime);
  t.after(async()=>{realtime.close();context.media.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));context.store.close();await rm(directory,{recursive:true,force:true});});
  context.store.run("UPDATE settings SET value='1' WHERE key='concurrent'");
  context.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,created_at) VALUES ('g','g','g','files/g','image/webp','files/g',1,?)",Date.now());
  async function person(){const response=await fetch(origin+'/api/me'),cookie=response.headers.get('set-cookie').split(';')[0];return {headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},call:(url,method='GET',body)=>fetch(origin+url,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})};}
  const first=await person(),second=await person();
  const begin=person=>person.call('/api/tryons','POST',{garmentId:'g',preparationMs:900,countdownMs:3000,acceptRecording:true,queue:true}).then(response=>response.json());
  const active=await begin(first),queued=await begin(second);
  assert.equal(active.status,'reserved');assert.equal(queued.status,'queued');assert.equal(queued.target,'outfit');
  assert.equal((await second.call(`/api/tryons/${queued.id}/ready`,'POST',{preparationMs:300,countdownMs:3000})).status,409);
  await first.call(`/api/tryons/${active.id}/finish`,'POST',{interrupted:true});
  const admitted=await second.call(`/api/tryons/${queued.id}/queue`,'POST').then(response=>response.json());
  assert.equal(admitted.status,'reserved');assert.equal(admitted.startup.readyAt,null);
  assert.equal((await second.call(`/api/tryons/${queued.id}/ready`,'POST',{preparationMs:700,countdownMs:2499})).status,400);
  const ready=await second.call(`/api/tryons/${queued.id}/ready`,'POST',{preparationMs:700,countdownMs:3000}).then(response=>response.json());
  assert.equal(ready.status,'reserved');assert.ok(ready.startup.readyAt);assert.equal(ready.startup.preparationMs,1600);assert.equal(ready.startup.countdownMs,6000);
  assert.equal((await first.call(`/api/tryons/${queued.id}/ready`,'POST',{preparationMs:1,countdownMs:3000})).status,404);
  await second.call(`/api/tryons/${queued.id}/finish`,'POST',{interrupted:true});
  assert.equal(context.store.get('SELECT COALESCE(SUM(used),0) AS n FROM usage').n,0);
});

test('countdown validation is independent of a user-selected target field', async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'amen-ready-no-target-'));
  const context=createApp({dataDirectory:directory,minFreeBytes:0,apiKey:'mock',origin:'http://127.0.0.1'});
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);const realtime=attachRealtime(server,context);context.attach(realtime);
  t.after(async()=>{realtime.close();context.media.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));context.store.close();await rm(directory,{recursive:true,force:true});});
  context.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,category,created_at) VALUES ('g','g','g','files/g','image/webp','files/g',1,'top',?)",Date.now());
  const response=await fetch(origin+'/api/me'),cookie=response.headers.get('set-cookie').split(';')[0];
  const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
  const invalid=await fetch(origin+'/api/tryons',{method:'POST',headers,body:JSON.stringify({garmentId:'g',countdownMs:100,acceptRecording:true})});assert.equal(invalid.status,400);
  const valid=await fetch(origin+'/api/tryons',{method:'POST',headers,body:JSON.stringify({garmentId:'g',countdownMs:3000,acceptRecording:true})}).then(value=>value.json());
  assert.equal(valid.target,'top');await fetch(origin+`/api/tryons/${valid.id}/finish`,{method:'POST',headers,body:JSON.stringify({interrupted:true})});
});

test('countdown v2 requires the full eight-second standing guide and preserves the protocol version', async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'amen-ready-v2-'));
  const context=createApp({dataDirectory:directory,minFreeBytes:0,apiKey:'mock',origin:'http://127.0.0.1'});
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);const realtime=attachRealtime(server,context);context.attach(realtime);
  t.after(async()=>{realtime.close();context.media.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));context.store.close();await rm(directory,{recursive:true,force:true});});
  context.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,category,created_at) VALUES ('g','g','g','files/g','image/webp','files/g',1,'outfit',?)",Date.now());
  const response=await fetch(origin+'/api/me'),cookie=response.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
  const short=await fetch(origin+'/api/tryons',{method:'POST',headers,body:JSON.stringify({garmentId:'g',countdownVersion:2,countdownMs:7899,acceptRecording:true})});assert.equal(short.status,400);
  const created=await fetch(origin+'/api/tryons',{method:'POST',headers,body:JSON.stringify({garmentId:'g',countdownVersion:2,countdownMs:8000,acceptRecording:true})}).then(value=>value.json());
  assert.equal(created.startup.countdownVersion,2);assert.equal(created.startup.countdownMs,8000);
  const shortReady=await fetch(origin+`/api/tryons/${created.id}/ready`,{method:'POST',headers,body:JSON.stringify({countdownVersion:2,countdownMs:7000})});assert.equal(shortReady.status,400);
  const ready=await fetch(origin+`/api/tryons/${created.id}/ready`,{method:'POST',headers,body:JSON.stringify({countdownVersion:2,countdownMs:8000})}).then(value=>value.json());
  assert.equal(ready.startup.countdownVersion,2);assert.equal(ready.startup.countdownMs,8000);
  await fetch(origin+`/api/tryons/${created.id}/finish`,{method:'POST',headers,body:JSON.stringify({interrupted:true})});
});

async function countdownFixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'amen-ready-v3-'));
  const context=createApp({dataDirectory:directory,minFreeBytes:0,apiKey:'mock',origin:'http://127.0.0.1'});
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);const realtime=attachRealtime(server,context);context.attach(realtime);
  t.after(async()=>{realtime.close();context.media.close();context.apiKeys.close();context.analytics.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));context.store.close();await rm(directory,{recursive:true,force:true});});
  context.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,category,created_at) VALUES ('g','g','g','files/g','image/webp','files/g',1,'top',?)",Date.now());
  const person=async()=>{const response=await fetch(origin+'/api/me'),cookie=response.headers.get('set-cookie').split(';')[0];return {call:(url,method='GET',body)=>fetch(origin+url,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})};};
  return {context,person};
}

test('countdown v3 creation accepts 4900–30000 ms and rejects missing, short, fractional or unknown protocol data',async t=>{
  const f=await countdownFixture(t),user=await f.person();
  const begin={garmentId:'g',acceptRecording:true,countdownVersion:3,countdownMs:5000};
  for(const change of [{countdownMs:4899},{countdownMs:30001},{countdownMs:undefined},{countdownMs:4900.5},{countdownVersion:0},{countdownVersion:4},{countdownVersion:'3'}]){
    const response=await user.call('/api/tryons','POST',{...begin,...change});assert.equal(response.status,400,JSON.stringify(change));
  }
  assert.equal(f.context.store.get('SELECT COUNT(*) n FROM tryons').n,0,'invalid countdowns must not allocate a session');
  for(const countdownMs of [4900,30000]){
    const response=await user.call('/api/tryons','POST',{...begin,countdownMs});assert.equal(response.status,201);
    const item=await response.json();assert.equal(item.startup.countdownVersion,3);assert.equal(item.startup.countdownMs,countdownMs);assert.equal(item.target,'top');
    assert.equal(f.context.store.get('SELECT countdown_version FROM tryons WHERE id=?',item.id).countdown_version,3);
    await user.call(`/api/tryons/${item.id}/finish`,'POST',{interrupted:true});
  }
  assert.equal(f.context.store.get('SELECT COALESCE(SUM(used),0) n FROM usage').n,0,'preparation never incurs generation usage');
});

test('queued countdown v3 retains its five-second minimum when version is omitted and rejects explicit downgrades',async t=>{
  const f=await countdownFixture(t),first=await f.person(),second=await f.person();
  f.context.store.run("UPDATE settings SET value='1' WHERE key='concurrent'");
  const create=await first.call('/api/tryons','POST',{garmentId:'g',acceptRecording:true,countdownMs:3000});const active=await create.json();assert.equal(create.status,201);
  const queuedResponse=await second.call('/api/tryons','POST',{garmentId:'g',acceptRecording:true,queue:true,preparationMs:100,countdownVersion:3,countdownMs:5000});const queued=await queuedResponse.json();assert.equal(queuedResponse.status,201);assert.equal(queued.status,'queued');
  assert.equal((await second.call(`/api/tryons/${queued.id}/ready`,'POST',{countdownVersion:3,countdownMs:5000})).status,409);
  await first.call(`/api/tryons/${active.id}/finish`,'POST',{interrupted:true});
  const admitted=await second.call(`/api/tryons/${queued.id}/queue`,'POST').then(response=>response.json());assert.equal(admitted.status,'reserved');assert.equal(admitted.startup.countdownVersion,3);assert.equal(admitted.startup.readyAt,null);
  for(const body of [{},{countdownMs:3000},{countdownVersion:1,countdownMs:3000},{countdownVersion:2,countdownMs:8000},{countdownVersion:3,countdownMs:4899},{countdownVersion:3,countdownMs:30001},{countdownVersion:4,countdownMs:5000}]){
    assert.equal((await second.call(`/api/tryons/${queued.id}/ready`,'POST',body)).status,400,JSON.stringify(body));
    const row=f.context.store.get('SELECT * FROM tryons WHERE id=?',queued.id);assert.equal(row.countdown_version,3);assert.equal(row.countdown_ms,5000);assert.equal(row.ready_at,null);
  }
  const raw=f.context.store.get('SELECT * FROM tryons WHERE id=?',queued.id);
  assert.throws(()=>f.context.store.markReady(queued.id,raw.visitor_id,{countdownVersion:2,countdownMs:8000}),error=>error.status===400,'store must not downgrade even when called directly');
  const readyResponse=await second.call(`/api/tryons/${queued.id}/ready`,'POST',{preparationMs:200,countdownMs:4900});assert.equal(readyResponse.status,200);const ready=await readyResponse.json();
  assert.equal(ready.startup.countdownVersion,3);assert.equal(ready.startup.countdownMs,9900);assert.equal(ready.startup.preparationMs,300);assert.ok(ready.startup.readyAt);assert.equal(ready.startup.connectionStartedAt,null);
  const repeated=await second.call(`/api/tryons/${queued.id}/ready`,'POST',{countdownVersion:3,countdownMs:30000}).then(response=>response.json());assert.equal(repeated.startup.countdownMs,9900,'readiness retries must not add another countdown');
  assert.equal((await second.call(`/api/tryons/${queued.id}/ready`,'POST',{countdownVersion:2,countdownMs:8000})).status,400,'a ready session cannot be downgraded either');
  assert.equal((await first.call(`/api/tryons/${queued.id}/ready`,'POST',{countdownVersion:3,countdownMs:5000})).status,404);
  await second.call(`/api/tryons/${queued.id}/finish`,'POST',{interrupted:true});
  assert.equal(f.context.store.get('SELECT COALESCE(SUM(used),0) n FROM usage').n,0);
});
