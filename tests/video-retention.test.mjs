import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';
import {scryptSync} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {createApp} from '../server/app.mjs';
const execute=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'amen-retention-'));let now=Date.now();
 const c=createApp({dataDirectory:dir,minFreeBytes:0,now:()=>now,origin:'http://127.0.0.1',apiKey:'mock-only',adminHash:'scrypt$test$'+scryptSync('test-password','test',64).toString('hex')});
 const server=http.createServer(c.app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;c.setOrigin(origin);
 const idle=async()=>{for(let i=0;i<1500&&!c.media.idle();i++)await sleep(20);assert.ok(c.media.idle());};
 t.after(async()=>{c.media.close();await idle();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));c.store.close();await rm(dir,{recursive:true,force:true});});
 const person=()=>{let cookie='';return async(url,method='GET',body,extra={})=>{const r=await fetch(origin+url,{method,headers:{Origin:origin,Cookie:cookie,...(body&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}),...extra},body:Buffer.isBuffer(body)?body:body?JSON.stringify(body):undefined});const next=r.headers.get('set-cookie');if(next)cookie=next.split(';')[0];return r;};};
 const owner=person(),stranger=person(),admin=person();await owner('/api/me');await stranger('/api/me');assert.equal((await admin('/api/admin/login','POST',{username:'admin',password:'test-password'})).status,200);
 await writeFile(c.store.safeFile('files/g'),'image');c.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,created_at) VALUES ('g','g','g','files/g','image/webp','files/g',1,?)",now);
 const session=await owner('/api/tryons','POST',{garmentId:'g',acceptRecording:true}).then(r=>r.json());
 const rec=kind=>c.store.get('SELECT * FROM recordings WHERE tryon_id=? AND kind=?',session.id,kind);
 return {...c,dir,idle,owner,stranger,admin,session,rec,advance:ms=>now+=ms,record:()=>{c.store.generation(session.id,30);c.store.run("UPDATE tryons SET status='saving',first_frame_at=?,ended_at=? WHERE id=?",now-30000,now,session.id);}};
}
test('legacy user removal endpoints are disabled and never cancel retained uploads',async t=>{
 const c=await fixture(t),url=`/api/tryons/${c.session.id}`,recording=c.rec('result');
 assert.equal((await c.owner(url+'/hide','POST')).status,409);c.record();
 assert.equal((await c.stranger(url+'/hide','POST')).status,404);
 assert.equal((await c.owner(url,'DELETE')).status,409);
 assert.equal((await c.owner(`/api/admin/tryons/${c.session.id}`,'DELETE')).status,401);
 assert.equal((await c.owner(`/api/admin/tryons/${c.session.id}/restore`,'POST')).status,401);
 assert.equal((await c.owner(`/api/admin/tryons/${c.session.id}/recordings/result/recover`,'POST')).status,401);
 await c.media.manifest(recording,3,'video/mp4');await c.media.uploadChunk(recording,0,Buffer.from('retained-prefix'),'video/mp4');
 const chunk=c.store.get('SELECT * FROM chunks WHERE recording_id=?',recording.id);
 for(let i=0;i<2;i++)assert.equal((await c.owner(url+'/hide','POST')).status,409);
 assert.equal((await c.owner('/api/tryons').then(r=>r.json())).length,1);
 assert.equal((await c.owner(url)).status,200);assert.equal((await c.stranger(url)).status,404);
 const listed=await c.admin('/api/admin/tryons').then(r=>r.json());assert.equal(listed.total,1);assert.equal(listed.items[0].userHiddenAt,null);
 assert.equal((await readFile(c.store.safeFile(chunk.file_path))).toString(),'retained-prefix');
 assert.equal((await c.owner(url+'/recordings/result/chunks/1','PUT',Buffer.from('more-data'),{'Content-Type':'application/octet-stream','X-Recording-Type':'video/mp4'})).status,204);
 assert.equal(c.store.get("SELECT COUNT(*) AS n FROM video_actions WHERE action='hide'").n,0);assert.equal(c.store.get('SELECT used FROM usage').used,1);
 assert.equal((await c.admin(`/api/admin/tryons/${c.session.id}/restore`,'POST')).status,204);assert.equal((await c.owner('/api/tryons').then(r=>r.json())).length,1);
 assert.equal((await c.admin(`/api/admin/tryons/${c.session.id}`,'DELETE')).status,204);
 assert.equal((await c.admin(url)).status,404);await assert.rejects(readFile(c.store.safeFile(chunk.file_path)));
 assert.equal(c.store.get('SELECT COUNT(*) AS n FROM recordings').n,0);assert.equal(c.store.get("SELECT actor FROM video_actions WHERE action='delete'").actor,'admin');assert.equal(c.store.get('SELECT used FROM usage').used,1);
});
test('truncated fragmented MP4 recovers actual playable duration while complete upload can still resume',async t=>{
 const c=await fixture(t);c.record();const file=path.join(c.dir,'source.mp4');
 await execute(c.options.ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x160:rate=12','-t','6','-an','-c:v','libx264','-threads','1','-g','12','-pix_fmt','yuv420p','-movflags','+frag_keyframe+empty_moov+default_base_moof',file],{windowsHide:true});
 const bytes=await readFile(file),offsets=[];for(let offset=0;offset+8<=bytes.length;){const size=bytes.readUInt32BE(offset);assert.ok(size>=8);if(bytes.toString('ascii',offset+4,offset+8)==='moof')offsets.push(offset);offset+=size;}
 assert.ok(offsets.length>=5);const boundary=offsets[3],prefix=bytes.subarray(0,boundary),tail=bytes.subarray(boundary),rec=c.rec('result');
 await c.media.manifest(rec,2,'video/mp4');await c.media.uploadChunk(rec,0,prefix,'video/mp4');
 assert.equal(c.media.describe(c.rec('result')).recoveryAvailable,true);
 const response=await c.admin(`/api/admin/tryons/${c.session.id}/recordings/result/recover`,'POST');assert.equal(response.status,200,await response.clone().text());
 const recovered=(await response.json()).recordings.find(x=>x.kind==='result');assert.equal(recovered.recovered,true);assert.ok(recovered.duration>2.5&&recovered.duration<4);assert.equal(recovered.status,'uploading');assert.equal(recovered.expectedChunks,2);assert.equal(recovered.receivedChunks,1);
 assert.equal(c.media.describe(c.rec('result')).recoveryAvailable,false);
 const stored=c.store.get('SELECT * FROM chunks WHERE recording_id=?',rec.id);assert.deepEqual(await readFile(c.store.safeFile(stored.file_path)),prefix);
 assert.equal((await c.stranger(recovered.url)).status,404);assert.equal((await c.admin(recovered.url)).status,200);
 const range=await c.owner(recovered.url,'GET',null,{Range:'bytes=0-31'});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,32);
 const previewPath=c.store.get('SELECT final_path FROM recording_recoveries WHERE recording_id=?',rec.id).final_path;
 const preview=await c.media.probe(c.store.safeFile(previewPath));assert.equal(preview.streams[0].codec_name,'h264');assert.equal(preview.streams.length,1);
 // A stale empty-finish request must not turn a recoverable prefix into a
 // terminal failed upload, or prevent the same phone sending the missing tail.
 assert.equal((await c.owner(`/api/tryons/${c.session.id}/recordings/result/complete`,'POST',{chunks:0})).status,409);
 assert.equal((await c.owner(`/api/tryons/${c.session.id}/recordings/result/manifest`,'POST',{chunks:0,mime:'video/mp4'})).status,409);
 assert.equal(c.rec('result').status,'uploading');assert.equal(c.rec('result').expected_chunks,2);
 assert.equal(c.media.playable(c.rec('result')).recovered,true);assert.deepEqual(await readFile(c.store.safeFile(stored.file_path)),prefix);
 assert.equal((await c.owner(`/api/tryons/${c.session.id}/hide`,'POST')).status,409);await c.media.uploadChunk(rec,1,tail,'video/mp4');await c.idle();
 const complete=(await c.admin(`/api/tryons/${c.session.id}`).then(r=>r.json())).recordings.find(x=>x.kind==='result');assert.equal(complete.status,'ready');assert.equal(complete.recovered,false);assert.ok(complete.duration>5.5);assert.equal((await c.owner('/api/tryons').then(r=>r.json())).length,1);
 c.advance(31*86400000);await c.media.cleanup();assert.equal(c.store.get('SELECT COUNT(*) AS n FROM tryons').n,0);assert.equal(c.store.get('SELECT COUNT(*) AS n FROM recording_recoveries').n,0);await assert.rejects(readFile(c.store.safeFile(previewPath)));
});
test('empty, missing-initial and corrupt retained chunks never become a saved video',async t=>{
 const c=await fixture(t);c.record();const rec=c.rec('original');
 await assert.rejects(c.media.recoverPartial(rec),error=>error.status===409);
 await c.media.manifest(rec,3,'video/mp4');await c.media.uploadChunk(rec,1,Buffer.from('missing-first'),'video/mp4');
 assert.equal(c.media.describe(c.rec('original')).recoveryAvailable,false);await assert.rejects(c.media.recoverPartial(rec),error=>error.status===409);
 await c.media.uploadChunk(rec,0,Buffer.from('invalid-container'),'video/mp4');await assert.rejects(c.media.recoverPartial(rec),error=>error.status===422);
 assert.equal(c.media.playable(c.rec('original')),null);assert.equal(c.store.get('SELECT COUNT(*) AS n FROM chunks').n,2);assert.equal(c.media.idle(),true);
 c.advance(25*3600000);await c.media.cleanup();assert.equal(c.store.get('SELECT COUNT(*) AS n FROM chunks').n,0);
 await c.admin('/api/admin/login','POST',{username:'admin',password:'test-password'});
 const list=await c.admin('/api/admin/tryons').then(r=>r.json());assert.equal(list.total,1);assert.equal(list.items[0].recordings.some(r=>r.url),false);
});
