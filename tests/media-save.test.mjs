import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {createStore} from '../server/store.mjs';import {createMedia} from '../server/media.mjs';import {config} from '../server/config.mjs';
import {savedSummary,recordingSaveStatus} from '../src/save-status.ts';
const execute=promisify(execFile);
async function fixture(t){
 const folder=await mkdtemp(path.join(os.tmpdir(),'amen-save-'));let now=Date.now();const store=createStore(folder,{minFreeBytes:0,now:()=>now});let media=createMedia(store,config);
 store.run('INSERT INTO visitors(id,token_hash,created_at,consent_at) VALUES (?,?,?,?)','a','a',now,now);const session=store.reserve(store.get("SELECT * FROM visitors WHERE id='a'"),{id:'g',name:'garment'});
 store.generation(session.id,30);store.run("UPDATE tryons SET status='saving',first_frame_at=?,ended_at=? WHERE id=?",now-30000,now,session.id);
 const rec=kind=>store.get('SELECT * FROM recordings WHERE tryon_id=? AND kind=?',session.id,kind);
 const bytes=async()=>{const file=path.join(folder,'sample.mp4');await execute(config.ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x160:rate=12','-t','1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',file],{windowsHide:true});return readFile(file);};
 const idle=async()=>{for(let i=0;i<400&&!media.idle();i++)await new Promise(r=>setTimeout(r,20));assert.equal(media.idle(),true);};
 t.after(async()=>{media.close();await idle();store.close();await rm(folder,{recursive:true,force:true});});
 return {store,session,rec,bytes,idle,get media(){return media;},advance:ms=>{now+=ms;},restart(options=config){media.close();media=createMedia(store,options);media.start();}};
}
test('completed result plus abandoned original upload is waiting for upload, never perpetual processing',async t=>{
 const f=await fixture(t);f.store.run("UPDATE tryons SET status='processing' WHERE id=?",f.session.id);f.store.run("UPDATE recordings SET status='ready',duration=30 WHERE id=?",f.rec('result').id);
 await f.media.uploadChunk(f.rec('original'),0,Buffer.from('partial'),'video/mp4');f.advance(91000);f.media.settle(f.session.id);
 assert.equal(f.store.get('SELECT status FROM tryons WHERE id=?',f.session.id).status,'saving');
 const original={...f.rec('original'),...f.media.describe(f.rec('original'))};assert.equal(original.waitingForUpload,true);assert.equal(original.receivedChunks,1);assert.equal(original.expectedChunks,null);
 const item={status:'saving',interrupted:false,recordings:[{kind:'result',status:'ready'},original]};assert.equal(savedSummary(item),'成片已保存 · 原片待续传');assert.match(recordingSaveStatus(original),/等待手机续传/);
});
test('declared upload auto-processes on the final chunk and resumes after restart without a complete notification',async t=>{
 const f=await fixture(t),data=await f.bytes(),middle=Math.floor(data.length/2),result=f.rec('result'),original=f.rec('original');
 await f.media.manifest(result,2,'video/mp4');await f.media.manifest(original,1,'video/mp4');await f.media.uploadChunk(result,0,data.subarray(0,middle),'video/mp4');
 await assert.rejects(f.media.manifest(result,3,'video/mp4'),e=>e.status===409);await assert.rejects(f.media.uploadChunk(result,0,Buffer.from('wrong'),'video/mp4'),e=>e.status===409);
 f.restart();await f.idle();assert.equal(f.rec('result').status,'uploading');assert.equal(f.media.describe(f.rec('result')).receivedChunks,1);
 await f.media.uploadChunk(result,1,data.subarray(middle),'video/mp4');await f.idle();assert.equal(f.rec('result').status,'ready');assert.equal(f.store.get('SELECT status FROM tryons WHERE id=?',f.session.id).status,'saving');
 await f.media.complete(result,2);assert.equal(f.media.describe(f.rec('result')).receivedChunks,2);
 await f.media.uploadChunk(original,0,data,'video/mp4');await f.idle();assert.equal(f.rec('original').status,'ready');assert.equal(f.store.get('SELECT status FROM tryons WHERE id=?',f.session.id).status,'interrupted');
});
test('a declaration arriving after all stored chunks recovers a lost final notification',async t=>{
 const f=await fixture(t),data=await f.bytes(),result=f.rec('result');await f.media.uploadChunk(result,0,data,'video/mp4');assert.equal(f.rec('result').status,'uploading');
 await f.media.manifest(result,1,'video/mp4');await f.idle();assert.equal(f.rec('result').status,'ready');
});
test('failed server processing can retry retained complete chunks without regenerating or discarding the other video',async t=>{
 const f=await fixture(t),data=await f.bytes(),result=f.rec('result');f.restart({...config,ffmpeg:'missing-ffmpeg'});
 await f.media.manifest(result,1,'video/mp4');await f.media.uploadChunk(result,0,data,'video/mp4');await f.idle();assert.equal(f.rec('result').status,'failed');assert.equal(f.media.describe(f.rec('result')).retryable,true);
 f.restart();await f.media.retry(result);await f.idle();assert.equal(f.rec('result').status,'ready');assert.equal(f.store.get('SELECT used FROM usage').used,1);
 await assert.rejects(f.media.retry(f.rec('original')),e=>e.status===409);
});

test('zero completion cannot replace a positive declared upload, even before its first chunk',async t=>{
 const f=await fixture(t),recording=f.rec('original');await f.media.manifest(recording,2,'video/mp4');
 const before=f.rec('original');
 await assert.rejects(f.media.complete(recording,0),error=>error.status===409);
 await assert.rejects(f.media.manifest(recording,0,'video/mp4'),error=>error.status===409);
 assert.deepEqual(f.rec('original'),before);
 await f.media.uploadChunk(recording,0,Buffer.from('retained-prefix'),'video/mp4');
 const partial=f.rec('original');
 await assert.rejects(f.media.complete(recording,0),error=>error.status===409);
 assert.deepEqual(f.rec('original'),partial);assert.equal(f.media.describe(partial).receivedChunks,1);
});

test('early chunks survive a false zero declaration and a late complete queues only a contiguous full recording',async t=>{
 const f=await fixture(t),data=await f.bytes(),recording=f.rec('result'),a=Math.floor(data.length/3),b=2*a;
 await f.media.uploadChunk(recording,0,data.subarray(0,a),'video/mp4');
 await f.media.uploadChunk(recording,2,data.subarray(b),'video/mp4');
 const before=f.rec('result'),kept=f.store.all('SELECT * FROM chunks WHERE recording_id=? ORDER BY seq',recording.id);
 await assert.rejects(f.media.complete(recording,0),error=>error.status===409);
 await assert.rejects(f.media.manifest(recording,0,'video/mp4'),error=>error.status===409);
 await assert.rejects(f.media.complete(recording,2),error=>error.status===409);
 await assert.rejects(f.media.complete(recording,3),error=>error.status===409);
 assert.deepEqual(f.rec('result'),before);assert.deepEqual(f.store.all('SELECT * FROM chunks WHERE recording_id=? ORDER BY seq',recording.id),kept);
 await assert.rejects(f.media.manifest(recording,2,'video/mp4'),error=>error.status===409);
 await f.media.uploadChunk(recording,1,data.subarray(a,b),'video/mp4');
 assert.equal(f.rec('result').status,'uploading');assert.equal(f.rec('result').expected_chunks,null);
 await f.media.complete(recording,3);await f.idle();assert.equal(f.rec('result').status,'ready');assert.equal(f.rec('result').expected_chunks,3);assert.equal(f.rec('original').status,'uploading');
 await f.media.complete(recording,3);await f.media.manifest(recording,3,'video/mp4');
 await assert.rejects(f.media.complete(recording,0),error=>error.status===409);
 await assert.rejects(f.media.complete(recording,2),error=>error.status===409);
 assert.equal(f.rec('result').status,'ready');assert.ok(f.media.playable(f.rec('result')));
});

test('empty recording completion is idempotent and terminal acknowledgments reject invalid totals',async t=>{
 const f=await fixture(t),empty=f.rec('original');
 await f.media.complete(empty,0);assert.equal(f.rec('original').status,'failed');assert.equal(f.rec('original').expected_chunks,0);
 await f.media.complete(empty,0);await f.media.manifest(empty,0,'video/mp4');
 for(const total of [-1,0.5,2049,'0',null])await assert.rejects(f.media.complete(empty,total),error=>error.status===400);
 await assert.rejects(f.media.complete(empty,1),error=>error.status===409);
 const result=f.rec('result');f.media.close();await f.media.manifest(result,1,'video/mp4');await f.media.uploadChunk(result,0,Buffer.from('queued-container'),'video/mp4');
 assert.equal(f.rec('result').status,'queued');await f.media.complete(result,1);
 await assert.rejects(f.media.complete(result,0),error=>error.status===409);
 await assert.rejects(f.media.complete(result,2),error=>error.status===409);
 await assert.rejects(f.media.complete(result,'1'),error=>error.status===400);
 assert.equal(f.rec('result').status,'queued');assert.equal(f.media.describe(f.rec('result')).receivedChunks,1);
});
