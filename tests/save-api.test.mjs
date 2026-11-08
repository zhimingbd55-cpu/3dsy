import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';import {scryptSync} from 'node:crypto';import {WebSocket,WebSocketServer} from 'ws';
import {createApp} from '../server/app.mjs';import {attachRealtime} from '../server/realtime.mjs';
async function fixture(t,extra={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'amen-save-api-'));const c=createApp({dataDirectory:dir,minFreeBytes:0,apiKey:'dct_'+'A'.repeat(40),origin:'http://127.0.0.1',adminHash:'scrypt$test$'+scryptSync('test-password','test',64).toString('hex'),fetcher:async()=>Response.json({apiKey:'ephemeral-mock'}),...extra});
 const server=http.createServer(c.app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;c.setOrigin(origin);const relay=attachRealtime(server,c);c.attach(relay);
 t.after(async()=>{relay.close();c.media.close();while(!c.media.idle())await new Promise(r=>setTimeout(r,20));server.closeAllConnections();await new Promise(r=>server.close(r));c.store.close();await rm(dir,{recursive:true,force:true});});
 await writeFile(c.store.safeFile('files/g'),'reference');c.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,created_at) VALUES ('g','g','g','files/g','image/webp','files/g',1,?)",Date.now());
 const person=async()=>{const r=await fetch(origin+'/api/me'),cookie=r.headers.get('set-cookie').split(';')[0],headers={Origin:origin,Cookie:cookie,'Content-Type':'application/json'};return {headers,call:(url,method='GET',body)=>fetch(origin+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)})};};
 return {...c,origin,person};
}
test('upload declarations and processing retries are owner-only and cannot start before generation',async t=>{
 const c=await fixture(t),a=await c.person(),b=await c.person();const row=await a.call('/api/tryons','POST',{garmentId:'g',acceptRecording:true}).then(r=>r.json());const base=`/api/tryons/${row.id}/recordings/result`;
 assert.equal((await b.call(base+'/manifest','POST',{chunks:2,mime:'video/mp4'})).status,404);assert.equal((await a.call(base+'/manifest','POST',{chunks:2,mime:'video/mp4'})).status,409);
 c.store.generation(row.id,30);c.store.run("UPDATE tryons SET first_frame_at=?,ended_at=?,status='saving' WHERE id=?",Date.now()-30000,Date.now(),row.id);
 assert.equal((await a.call(base+'/manifest','POST',{chunks:2,mime:'video/mp4'})).status,200);assert.equal((await b.call(base+'/retry','POST',{})).status,404);assert.equal((await a.call(base+'/retry','POST',{})).status,409);
 const record=(await a.call(`/api/tryons/${row.id}`).then(r=>r.json())).recordings.find(x=>x.kind==='result');assert.equal(record.expectedChunks,2);assert.equal(record.receivedChunks,0);assert.equal(record.retryable,false);
 assert.equal((await a.call(`/api/admin/api-keys/${c.apiKeys.list().activeId}/quota`,'POST',{})).status,401);
});
test('realtime insufficient_credits termination records exhausted status without acquiring a second token',async t=>{
 const upstream=new WebSocketServer({port:0,host:'127.0.0.1'});await once(upstream,'listening');t.after(()=>new Promise(r=>upstream.close(r)));let calls=0;
 upstream.on('connection',ws=>ws.send(JSON.stringify({type:'generation_ended',reason:'insufficient_credits',seconds:0})));
 const c=await fixture(t,{upstreamUrl:`ws://127.0.0.1:${upstream.address().port}`,fetcher:async()=>{calls++;return Response.json({apiKey:'ephemeral-mock'});}});c.apiKeys.importKeys('dct_'+'B'.repeat(40));const id=c.apiKeys.list().activeId,a=await c.person();
 const row=await a.call('/api/tryons','POST',{garmentId:'g',acceptRecording:true}).then(r=>r.json());
 const ws=new WebSocket(c.origin.replace('http:','ws:')+`/api/realtime/${row.id}/v1/stream`,{headers:a.headers});await once(ws,'close');
 assert.equal(calls,1);assert.equal(c.apiKeys.list().activeId,id);assert.equal(c.apiKeys.list().items.find(x=>x.id===id).creditState,'insufficient');assert.match(c.store.get('SELECT error FROM tryons WHERE id=?',row.id).error,/额度不足/);assert.equal(c.store.quota(row.visitorId).userUsed,0);
});

for(const message of [{type:'set_image_ack',success:false,error:'image decode failed'},{type:'error',error:'worker unavailable'},{type:'set_image_ack',success:false,error:'insufficient_credits'}]){
 test(`initial ${message.type} ${message.error} ends immediately even if the browser ignores SDK events`,{timeout:5000},async t=>{
  const upstream=new WebSocketServer({port:0,host:'127.0.0.1'});await once(upstream,'listening');t.after(()=>new Promise(r=>upstream.close(r)));let calls=0;
  upstream.on('connection',ws=>{ws.send(JSON.stringify({type:'livekit_room_info'}));ws.send(JSON.stringify(message));});
  const c=await fixture(t,{upstreamUrl:`ws://127.0.0.1:${upstream.address().port}`,fetcher:async()=>{calls++;return Response.json({apiKey:'ephemeral-mock'});}}),a=await c.person(),b=await c.person();
  const row=await a.call('/api/tryons','POST',{garmentId:'g',acceptRecording:true}).then(r=>r.json());
  const ws=new WebSocket(c.origin.replace('http:','ws:')+`/api/realtime/${row.id}/v1/stream`,{headers:a.headers});await once(ws,'close');
  const saved=await a.call(`/api/tryons/${row.id}`).then(r=>r.json());
  assert.equal(saved.status,'failed');assert.equal(calls,1);assert.equal(c.store.quota(row.visitorId).userUsed,0);
  assert.match(saved.error,message.error==='insufficient_credits'?/额度不足/:message.type==='set_image_ack'?/服装参考图处理失败/:/云端试衣服务返回错误/);
  assert.equal((await b.call(`/api/tryons/${row.id}/diagnostic`,'POST',{code:'SIGNAL_FAILED'})).status,404);
  await a.call(`/api/tryons/${row.id}/diagnostic`,'POST',{code:'SIGNAL_FAILED',platform:'ios'});
  assert.equal((await a.call(`/api/tryons/${row.id}`).then(r=>r.json())).error,saved.error);
 });
}

test('admin video pagination hides only empty failed connections, preserving short videos and recoverable uploads',async t=>{
 const c=await fixture(t),a=await c.person();
 const user=c.store.get('SELECT id FROM visitors').id;
 const add=(id,status,recordStatus,bytes=0,duration=null)=>{
  c.store.run('INSERT INTO tryons(id,visitor_id,garment_name,created_at,day,status,reserved_bytes) VALUES (?,?,?,?,?,?,0)',id,user,'test',Date.now(),'2026-10-10',status);
  c.store.run('INSERT INTO recordings(id,tryon_id,kind,status,bytes,duration) VALUES (?,?,?,?,?,?)','r-'+id,id,'result',recordStatus,bytes,duration);
 };
 for(let i=0;i<65;i++)add('empty-'+i,'failed','failed');
 // Stale byte counts alone do not mean there is still anything to recover.
 add('empty-old-bytes','failed','failed',999);
 for(let i=0;i<51;i++)add('saved-'+i,'ready','ready',999,30);
 add('short-video','failed','ready',100,0.5);
 add('processing','failed','processing',200);
 add('queued-media','failed','queued',200);
 add('uploading','saving','uploading');
 add('recoverable','failed','failed',200);
 c.store.run('INSERT INTO chunks VALUES (?,0,200,?,?)','r-recoverable','digest','temporary/recoverable');
 c.store.run('INSERT INTO usage VALUES (?,?,3,65)',user,'2026-10-10');
 const before=c.store.get('SELECT COUNT(*) AS n FROM tryons').n;
 assert.equal((await a.call('/api/admin/tryons')).status,401);
 const login=await a.call('/api/admin/login','POST',{username:'admin',password:'test-password'});assert.equal(login.status,200);
 const headers={Origin:c.origin,Cookie:login.headers.get('set-cookie').split(';')[0]};
 const get=offset=>fetch(c.origin+'/api/admin/tryons?offset='+offset,{headers}).then(r=>r.json());
 const first=await get(0),second=await get(50),after=await get(100);
 assert.equal(first.total,56);assert.equal(second.total,56);assert.equal(first.items.length,50);assert.equal(second.items.length,6);assert.equal(after.items.length,0);
 const ids=[...first.items,...second.items].map(x=>x.id);assert.equal(new Set(ids).size,56);assert.ok(ids.every(id=>!id.startsWith('empty-')));
 for(const id of ['short-video','processing','queued-media','uploading','recoverable'])assert.ok(ids.includes(id),id);
 assert.equal(c.store.get('SELECT COUNT(*) AS n FROM tryons').n,before);assert.equal(c.store.get('SELECT used FROM usage WHERE visitor_id=?',user).used,3);
 // Late, recoverable data is visible again; no permanent hidden flag is used.
 c.store.run('INSERT INTO chunks VALUES (?,0,100,?,?)','r-empty-0','digest','temporary/late');
 assert.equal((await get(0)).total,57);
  // A recorded session remains in the administrative archive even if every
  // upload expired. Only failures before the first real frame are omitted.
  c.store.run('UPDATE tryons SET first_frame_at=? WHERE id=?',Date.now()-60000,'empty-old-bytes');
  assert.equal((await get(0)).total,58);
});
