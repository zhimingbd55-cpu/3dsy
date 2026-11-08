import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createStore } from '../server/store.mjs';
import { createMedia } from '../server/media.mjs';
import { createApiKeys } from '../server/api-keys.mjs';
import { config } from '../server/config.mjs';
import { recordingPolicy, recordingIsShort, posterTime } from '../server/recording-policy.mjs';
const execute=promisify(execFile);

test('recording budgets follow persisted mode and expected completed timeline',()=>{
  assert.equal(recordingPolicy({}).maxSeconds,30);
  assert.equal(recordingPolicy({}).maxInputSeconds,50);
  assert.equal(recordingPolicy({flow_version:1,flow_mode:'fixed'}).maxSeconds,30);
  const auto={flow_version:1,flow_mode:'auto',expected_recording_seconds:94};
  assert.equal(recordingPolicy(auto).maxSeconds,180);
  assert.equal(recordingPolicy(auto).maxInputSeconds,185);
  assert.equal(recordingIsShort(auto,[{duration:94},{duration:93.5}]),false);
  assert.equal(recordingIsShort(auto,[{duration:94},{duration:91}]),true);
  assert.equal(recordingIsShort({},[{duration:28}]),true);
});

test('paired posters prefer the manually locked stable segment and stay inside partial media',()=>{
  const session={recording_started_at:1000};
  const segments=[{stable_at:1000,is_locked:0},{stable_at:12000,is_locked:0},{stable_at:25000,is_locked:1}];
  assert.equal(posterTime(session,segments,60),24.5);
  assert.equal(posterTime(session,segments.slice(0,2),60),.5);
  assert.equal(posterTime(session,segments,20),19.9);
  assert.equal(posterTime(session,[],60),0);
});

async function fixture(t){
  const folder=await mkdtemp(path.join(os.tmpdir(),'oneplus-long-'));
  let now=Date.now();
  const store=createStore(folder,{minFreeBytes:0,now:()=>now});
  store.run('INSERT INTO visitors(id,token_hash,created_at,consent_at) VALUES (?,?,?,?)','viewer','hash',now,now);
  const session=store.reserve(store.get("SELECT * FROM visitors WHERE id='viewer'"),{id:'test-garment',name:'Test garment'});
  store.run('UPDATE tryons SET flow_version=1,flow_mode=\'auto\',connection_started_at=?,hard_deadline_at=? WHERE id=?',now,now+225000,session.id);
  const media=createMedia(store,config);
  const idle=async()=>{for(let i=0;i<2000&&!media.idle();i++)await new Promise(r=>setTimeout(r,20));assert.equal(media.idle(),true);};
  t.after(async()=>{media.close();await idle();store.close();await rm(folder,{force:true,recursive:true});});
  return {folder,store,session,media,idle,now:()=>now,advance:ms=>{now+=ms;},rec:kind=>store.get('SELECT * FROM recordings WHERE tryon_id=? AND kind=?',session.id,kind)};
}

test('70-second originals/results and admin recovery are not truncated to 30 seconds',async t=>{
  const f=await fixture(t),start=f.now()-70000;
  f.store.run("UPDATE tryons SET status='saving',generation_seconds=70,charged=1,first_frame_at=?,recording_started_at=?,ended_at=?,expected_recording_seconds=70 WHERE id=?",start,start,f.now(),f.session.id);
  const input=path.join(f.folder,'sample.mp4');
  await execute(config.ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x160:rate=12','-t','70','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',input],{windowsHide:true,timeout:30000});
  const bytes=await readFile(input);
  for(const kind of ['result','original']){
    const recording=f.rec(kind);
    await f.media.uploadChunk(recording,0,bytes,'video/mp4');
    if(kind==='original'){
      await f.media.recoverPartial(recording);
      const recovered=f.media.playable(f.rec(kind));
      assert.equal(recovered.recovered,true);assert.ok(recovered.duration>69&&recovered.duration<71);
    }
    await f.media.manifest(recording,1,'video/mp4');await f.idle();
    assert.equal(f.rec(kind).status,'ready');assert.ok(f.rec(kind).duration>69&&f.rec(kind).duration<71);
  }
  assert.equal(f.store.get('SELECT status FROM tryons WHERE id=?',f.session.id).status,'ready');
});

test('provider usage above 60 seconds is retained, duplicates do not double bill, restart has a hard bound',async t=>{
  const f=await fixture(t);
  const options={apiKey:'dct_'+ 'test'.repeat(8),fetcher:async()=>Response.json({apiKey:'mock-token'})};
  let keys=createApiKeys(f.store,options);t.after(()=>keys.close());
  await keys.token('lucy-vton-3.6',225,'https://example.test',{tryonId:f.session.id});
  keys.beginUsage(f.session.id);keys.reportUsage(f.session.id,100);keys.reportUsage(f.session.id,100);
  let usage=f.store.get('SELECT * FROM provider_key_usage WHERE tryon_id=?',f.session.id);
  assert.equal(usage.reported_seconds,100);assert.equal(usage.billed_seconds,100);
  keys.close();f.advance(900000);
  keys=createApiKeys(f.store,options);
  usage=f.store.get('SELECT * FROM provider_key_usage WHERE tryon_id=?',f.session.id);
  assert.equal(usage.local_seconds,225);assert.equal(usage.billed_seconds,225);
  assert.equal(usage.end_reason,'service_restart_recovery');
});
