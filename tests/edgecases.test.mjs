import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createStore} from '../server/store.mjs';import {createMedia,validateGlb,normalizeImage} from '../server/media.mjs';
test('global quota, two-session cap, unfinished expiry, restarted jobs and invalid input',async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'amen-edge-'));let now=Date.now();const store=createStore(folder,{now:()=>now,minFreeBytes:0});const media=createMedia(store,{ffmpeg:'missing-ffmpeg',ffprobe:'missing-ffprobe'});
 try{
  const users=['a','b','c'].map(id=>{store.run('INSERT INTO visitors(id,token_hash,created_at,consent_at) VALUES (?,?,?,?)',id,id,now,now);return store.get('SELECT * FROM visitors WHERE id=?',id);});const garment={id:'test',name:'test'};
  const first=store.reserve(users[0],garment),second=store.reserve(users[1],garment);assert.throws(()=>store.reserve(users[2],garment),e=>e.status===429);store.run("UPDATE tryons SET status='failed',reserved_bytes=0 WHERE id=?",second.id);
  store.generation(first.id,3);store.run("UPDATE tryons SET status='failed',reserved_bytes=0 WHERE id=?",first.id);store.run("UPDATE settings SET value='1' WHERE key='dailySite'");assert.throws(()=>store.reserve(users[2],garment),e=>e.status===429);store.run("UPDATE settings SET value='300' WHERE key='dailySite'");
  const unfinished=store.reserve(users[2],garment);now+=61000;await media.cleanup();assert.equal(store.get('SELECT reserved_bytes FROM tryons WHERE id=?',unfinished.id).reserved_bytes,0);assert.equal(store.quota(users[2].id).userUsed,0);
  const interrupted=store.reserve(users[2],garment);store.generation(interrupted.id,2);store.run("UPDATE tryons SET status='recording',first_frame_at=? WHERE id=?",now,interrupted.id);media.start();assert.equal(store.get('SELECT interrupted FROM tryons WHERE id=?',interrupted.id).interrupted,1);assert.equal(store.get('SELECT status FROM tryons WHERE id=?',interrupted.id).status,'saving');
  for(const rec of store.all('SELECT * FROM recordings WHERE tryon_id=?',interrupted.id)){await media.uploadChunk(rec,0,Buffer.from('invalid-video'),'video/webm');await media.complete(rec,1);}for(let i=0;i<100&&!media.idle();i++)await new Promise(r=>setTimeout(r,10));assert.equal(store.get('SELECT status FROM tryons WHERE id=?',interrupted.id).status,'failed');assert.equal(store.get('SELECT reserved_bytes FROM tryons WHERE id=?',interrupted.id).reserved_bytes,0);
  assert.throws(()=>validateGlb(Buffer.from('bad')),e=>e.status===400);await assert.rejects(normalizeImage(Buffer.from('<svg/>')),e=>e.status===400);
  const partial=store.reserve(users[0],garment);store.generation(partial.id,30);
  store.run("UPDATE tryons SET status='processing',first_frame_at=? WHERE id=?",now,partial.id);
  store.run("UPDATE recordings SET status='ready',duration=30 WHERE tryon_id=? AND kind='result'",partial.id);
  now+=25*3600000;await media.cleanup();
  assert.equal(store.get('SELECT reserved_bytes FROM tryons WHERE id=?',partial.id).reserved_bytes,0);
  assert.equal(store.get("SELECT status FROM recordings WHERE tryon_id=? AND kind='original'",partial.id).status,'failed');
  assert.equal(store.get("SELECT status FROM recordings WHERE tryon_id=? AND kind='result'",partial.id).status,'ready');
  const quota=store.storage();store.run("UPDATE settings SET value=? WHERE key='storageBytes'",String(quota.used+quota.reserved+10));assert.throws(()=>store.reserveWrite(100),e=>e.status===507);
 }finally{media.close();store.close();await rm(folder,{recursive:true,force:true});}
 const lowDisk=await mkdtemp(path.join(os.tmpdir(),'amen-disk-')),diskStore=createStore(lowDisk,{minFreeBytes:Number.MAX_SAFE_INTEGER});try{assert.throws(()=>diskStore.canWrite(1),e=>e.status===507);}finally{diskStore.close();await rm(lowDisk,{recursive:true,force:true});}
});
