import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';import {scryptSync} from 'node:crypto';
import {createStore} from '../server/store.mjs';
import {createApp} from '../server/app.mjs';import {attachRealtime} from '../server/realtime.mjs';

async function fixture(t,capacity=1){
 const directory=await mkdtemp(path.join(os.tmpdir(),'amen-queue-'));let now=Date.parse('2026-10-10T06:00:00Z');
 const s=createStore(directory,{minFreeBytes:0,now:()=>now});t.after(async()=>{s.close();await rm(directory,{recursive:true,force:true});});
 s.run("UPDATE settings SET value=? WHERE key='concurrent'",String(capacity));
 s.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,created_at) VALUES ('g','g','g','files/g','image/webp','files/g',1,?)",now);
 const garment=s.get("SELECT * FROM garments WHERE id='g'");let counter=0;
 const reserve=()=>{const id=String(++counter);s.run('INSERT INTO visitors(id,token_hash,created_at,consent_at) VALUES (?,?,?,?)',id,id,now,now);return s.reserve(s.get('SELECT * FROM visitors WHERE id=?',id),garment,{allowQueue:true});};
 const release=id=>{s.run("UPDATE tryons SET status='failed',reserved_bytes=0 WHERE id=?",id);s.pumpQueue();};
 return {s,reserve,release,advance:ms=>{now+=ms;}};
}
test('FIFO queue position falls 2 -> 1 -> 0; cancellation refunds held quota without generation',async t=>{
 const {s,reserve,release,advance}=await fixture(t);const active=reserve(),first=reserve(),second=reserve(),last=reserve();
 assert.equal(active.status,'reserved');assert.equal(last.status,'queued');assert.equal(s.queueInfo(last.id).ahead,2);
 assert.equal(s.get('SELECT COUNT(*) n FROM usage').n,0);assert.equal(s.quota(first.visitor_id).userUsed,1);
 release(first.id);assert.equal(s.queueInfo(last.id).ahead,1);assert.equal(s.quota(first.visitor_id).userUsed,0);
 advance(2500);release(active.id);assert.equal(s.get('SELECT status FROM tryons WHERE id=?',second.id).status,'reserved');assert.equal(s.queueInfo(last.id).ahead,0);
 advance(2500);release(second.id);const admitted=s.get('SELECT * FROM tryons WHERE id=?',last.id);assert.equal(admitted.status,'reserved');assert.ok(admitted.admitted_at>admitted.created_at);assert.equal(admitted.charged,0);assert.equal(s.queueInfo(last.id),null);
});
test('queue is one per visitor; stale heartbeat, five-minute wait and Beijing day rollover release reservations',async t=>{
 const {s,reserve,advance}=await fixture(t);reserve();const waiting=reserve();const user=s.get('SELECT * FROM visitors WHERE id=?',waiting.visitor_id),g=s.get("SELECT * FROM garments WHERE id='g'");
 assert.throws(()=>s.reserve(user,g,{allowQueue:true}),e=>e.status===409);
 advance(19000);assert.equal(s.heartbeatQueue(waiting.id).status,'queued');advance(21000);
 assert.equal(s.heartbeatQueue(waiting.id).status,'failed');assert.equal(s.quota(user.id).userUsed,0);
 s.run("UPDATE tryons SET status='recording' WHERE status='reserved'");const timeout=reserve();
 for(let n=0;n<19;n++){advance(15000);assert.equal(s.heartbeatQueue(timeout.id).status,'queued');}advance(15000);assert.equal(s.heartbeatQueue(timeout.id).status,'failed');
 const rollover=reserve();s.run("UPDATE tryons SET day='2026-10-09' WHERE id=?",rollover.id);s.pumpQueue();assert.equal(s.get('SELECT reserved_bytes FROM tryons WHERE id=?',rollover.id).reserved_bytes,0);
});
test('raising capacity admits FIFO up to the new ceiling; lowering does not interrupt existing users; pause releases queue',async t=>{
 const {s,reserve,release}=await fixture(t);const items=Array.from({length:9},reserve);
 s.run("UPDATE settings SET value='6' WHERE key='concurrent'");s.pumpQueue();assert.equal(s.get("SELECT COUNT(*) n FROM tryons WHERE status='reserved'").n,6);assert.equal(s.queueInfo(items[8].id).ahead,2);
 s.run("UPDATE settings SET value='2' WHERE key='concurrent'");s.pumpQueue();assert.equal(s.get("SELECT COUNT(*) n FROM tryons WHERE status='reserved'").n,6);
 for(const row of items.slice(0,4))release(row.id);assert.equal(s.get('SELECT status FROM tryons WHERE id=?',items[6].id).status,'queued');
 release(items[4].id);assert.equal(s.get('SELECT status FROM tryons WHERE id=?',items[6].id).status,'reserved');
 s.run("UPDATE settings SET value='true' WHERE key='paused'");s.pumpQueue();assert.equal(s.get("SELECT COUNT(*) n FROM tryons WHERE status='queued'").n,0);assert.equal(s.quota(items[8].visitor_id).userUsed,0);
});
test('queued sessions survive a restart without acquiring a cloud session, and unavailable garments release their reservation',async t=>{
 const {s,reserve,advance}=await fixture(t);const active=reserve(),queued=reserve();const directory=s.directory;
 // A second store models reopening the durable database with the same queue order.
 const reopened=createStore(directory,{minFreeBytes:0,now:s.now});try{assert.equal(reopened.queueInfo(queued.id).ahead,0);assert.equal(reopened.get('SELECT charged FROM tryons WHERE id=?',queued.id).charged,0);}finally{reopened.close();}
 s.run("UPDATE garments SET published=0 WHERE id='g'");s.run("UPDATE tryons SET status='failed',reserved_bytes=0 WHERE id=?",active.id);s.pumpQueue();assert.equal(s.get('SELECT status FROM tryons WHERE id=?',queued.id).status,'failed');assert.equal(s.quota(queued.visitor_id).userUsed,0);
});
test('queue admission holds site quota and storage instead of overselling the daily limit',async t=>{
 const {s,reserve}=await fixture(t);s.run("UPDATE settings SET value='2' WHERE key='dailySite'");reserve();reserve();assert.throws(reserve,e=>e.status===429);
 s.run("UPDATE settings SET value='300' WHERE key='dailySite'");const usage=s.storage();s.run("UPDATE settings SET value=? WHERE key='storageBytes'",String(usage.used+usage.reserved+100));assert.throws(reserve,e=>e.status===507);
});
test('parallel API starts obey capacity; queue status is private, queued transport is blocked, and admin changes persist',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'amen-queue-http-'));let providerCalls=0;
 const c=createApp({dataDirectory:folder,minFreeBytes:0,apiKey:'mock',origin:'http://127.0.0.1',adminHash:'scrypt$q$'+scryptSync('queue-test','q',64).toString('hex'),fetcher:async()=>{providerCalls++;return Response.json({apiKey:'mock-token'});}});
 const server=http.createServer(c.app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;c.setOrigin(origin);const relay=attachRealtime(server,c);c.attach(relay);
 t.after(async()=>{relay.close();c.media.close();server.closeAllConnections();await new Promise(r=>server.close(r));c.store.close();await rm(folder,{recursive:true,force:true});});
 await writeFile(c.store.safeFile('files/g'),'mock');c.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,created_at) VALUES ('g','g','g','files/g','image/webp','files/g',1,?)",Date.now());
 const person=async()=>{const res=await fetch(origin+'/api/me'),cookie=res.headers.get('set-cookie').split(';')[0];return (url,method='GET',body)=>fetch(origin+url,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});};
 const admin=await person();assert.equal((await admin('/api/admin/settings','PATCH',{concurrent:6})).status,401);assert.equal((await admin('/api/admin/login','POST',{username:'admin',password:'queue-test'})).status,200);
 // Admin authentication is a separate cookie, as it is in a real browser.
 const login=await fetch(origin+'/api/admin/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'queue-test'})});const adminCookie=login.headers.get('set-cookie').split(';')[0];
 const setting=value=>fetch(origin+'/api/admin/settings',{method:'PATCH',headers:{Origin:origin,Cookie:adminCookie,'Content-Type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await setting({concurrent:21})).status,400);assert.equal((await setting({concurrent:6})).status,200);
 const users=await Promise.all(Array.from({length:12},person));const responses=await Promise.all(users.map(u=>u('/api/tryons','POST',{garmentId:'g',acceptRecording:true,queue:true})));assert.ok(responses.every(r=>r.status===201));const items=await Promise.all(responses.map(r=>r.json()));
 assert.equal(items.filter(x=>x.status==='reserved').length,6);assert.equal(items.filter(x=>x.status==='queued').length,6);assert.equal(providerCalls,0);
 const q=items.findIndex(x=>x.status==='queued'),other=(q+1)%users.length;
 assert.equal((await users[other](`/api/tryons/${items[q].id}/queue`,'POST')).status,404);assert.equal((await users[q](`/api/tryons/${items[q].id}/transport`)).status,409);
 assert.equal((await users[q](`/api/tryons/${items[q].id}/queue`,'POST')).status,200);assert.equal((await users[q](`/api/tryons/${items[q].id}/finish`,'POST')).status,200);assert.equal(c.store.quota(items[q].visitorId).userUsed,0);
 assert.equal((await setting({concurrent:8})).status,200);assert.equal(c.store.get("SELECT COUNT(*) n FROM tryons WHERE status='reserved'").n,8);assert.equal(c.store.settings().concurrent,8);assert.equal(providerCalls,0);
});
