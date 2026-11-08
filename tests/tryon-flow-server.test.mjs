import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {WebSocket,WebSocketServer} from 'ws';
import {createStore} from '../server/store.mjs';
import {createApp} from '../server/app.mjs';
import {attachRealtime} from '../server/realtime.mjs';
import {FLOW_VERSION,DEMO_GARMENT_IDS,flowLimits,createTryonFlow,flowJson} from '../server/tryon-flow.mjs';

const stability=seq=>({seq,stableWindowMs:2000,stableFrames:3,stabilityMode:'video-frame-callback'});
function seed(store){for(const [i,id] of [...DEMO_GARMENT_IDS,'selected'].entries())store.run('INSERT INTO garments(id,name,category,category_known,details,original_name,original_path,image_path,mime,published,created_at) VALUES (?,?,?,1,?,?,?,?,?,1,?)',id,id,'top',`Visible garment ${i}`,'ref',`files/${id}`,`files/${id}`,'image/webp',store.now());}
async function fixture(mode='auto',customSend){
  const directory=await mkdtemp(path.join(os.tmpdir(),'amen-flow-unit-'));let time=1700000000000,timerSeq=0;
  const timers=new Map(),store=createStore(directory,{minFreeBytes:0,now:()=>time}),sent=[],ended=[];
  seed(store);store.run("INSERT INTO visitors(id,token_hash,created_at,consent_at) VALUES ('visitor','hash',?,?)",time,time);
  const reserved=store.reserve(store.get("SELECT * FROM visitors WHERE id='visitor'"),store.get('SELECT * FROM garments WHERE id=?',DEMO_GARMENT_IDS[0]),{flowVersion:FLOW_VERSION,mode});
  const id=reserved.id;
  store.run("UPDATE tryons SET status='connecting',connection_started_at=?,hard_deadline_at=? WHERE id=?",time,time+flowLimits(reserved).connectionSeconds*1000,id);
  let flow;
  flow=createTryonFlow({store,id,setTimer:(fn,ms)=>{const key=++timerSeq;timers.set(key,{at:time+ms,fn});return key;},clearTimer:key=>timers.delete(key),sendReference:customSend||((garment,seq,guard)=>{if(guard()){sent.push({garmentId:garment.id,seq});store.run('UPDATE tryon_segments SET sent_at=? WHERE tryon_id=? AND seq=?',time,id,seq);}}),finish:(interrupted,reason)=>{ended.push({interrupted,reason});flow.stop(reason);store.run("UPDATE tryons SET status='saving',end_reason=?,ended_at=?,interrupted=? WHERE id=?",reason,time,Number(interrupted),id);}});
  const advance=ms=>{const target=time+ms;while(true){const next=[...timers].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;timers.delete(next[0]);next[1].fn();}time=target;};
  const row=()=>store.get('SELECT * FROM tryons WHERE id=?',id);
  const start=async()=>{await flow.requestImage();flow.acknowledge();store.generation(id);flow.generationStarted();advance(2000);flow.stable(stability(1),true);store.run("UPDATE tryons SET first_frame_at=?,recording_started_at=?,recording_deadline_at=?,status='recording' WHERE id=?",time,time,time+flowLimits(row()).recordingSeconds*1000+350,id);flow.recordingStarted();};
  return {store,id,flow,sent,ended,advance,row,start,jump:ms=>time+=ms,close:async()=>{flow.stop();store.close();await rm(directory,{recursive:true,force:true});}};
}

test('flow budgets preserve legacy audit cap and versioned auto/fixed recording limits',async()=>{
  assert.deepEqual(flowLimits({}),{recordingSeconds:30,connectionSeconds:45,generationSeconds:60});
  assert.deepEqual(flowLimits({flow_version:1,flow_mode:'fixed'}),{recordingSeconds:30,connectionSeconds:75,generationSeconds:75});
  const f=await fixture();try{assert.equal(flowLimits(f.row()).recordingSeconds,180);f.store.generation(f.id,120);assert.equal(f.row().generation_seconds,120);f.store.generation(f.id,900);assert.equal(f.row().generation_seconds,225);assert.equal(f.store.get('SELECT used FROM usage').used,1);}finally{await f.close();}
});

test('five automatic references keep exact order and each stable hold lasts ten seconds',async()=>{
  const f=await fixture();try{
    await f.start();
    for(let seq=1;seq<=5;seq++){
      const state=flowJson(f.store,f.row());assert.equal(state.rotation.seq,seq);assert.equal(state.rotation.status,'holding');assert.equal(state.rotation.holdDurationSeconds,10);
      f.advance(9999);assert.equal(f.sent.length,seq);assert.equal(f.ended.length,0);
      f.advance(1);
      if(seq<5){assert.equal(f.sent.length,seq+1);assert.equal(f.flow.acknowledge(),true);f.advance(2000);f.flow.stable(stability(seq+1));}
    }
    assert.deepEqual(f.sent.map(x=>x.garmentId),DEMO_GARMENT_IDS);assert.deepEqual(f.ended,[{interrupted:false,reason:'flow_completed'}]);
    assert.equal(f.row().expected_recording_seconds,58);assert.equal(f.store.all('SELECT * FROM tryon_segments WHERE stable_at IS NOT NULL').length,5);
  }finally{await f.close();}
});

test('a first lock during pending ACK serializes the selected reference and cannot extend thirty seconds',async()=>{
  const f=await fixture();try{
    await f.start();f.advance(10000);assert.equal(f.sent.length,2);
    f.flow.lock('selected');f.flow.lock('selected');assert.equal(f.sent.length,2);assert.throws(()=>f.flow.lock(DEMO_GARMENT_IDS[0]),{status:409});
    f.advance(1500);f.flow.acknowledge();assert.equal(f.sent.length,3);assert.equal(f.sent[2].garmentId,'selected');
    assert.throws(()=>f.flow.stable(stability(2)),{status:409});f.flow.acknowledge();f.advance(2000);f.flow.stable(stability(3));
    const end=flowJson(f.store,f.row()).rotation.holdEndsAt;f.advance(1000);f.flow.stable(stability(3));f.flow.lock('selected');assert.equal(flowJson(f.store,f.row()).rotation.holdEndsAt,end);
    assert.equal(flowLimits(f.row()).connectionSeconds,225);f.advance(29000);assert.deepEqual(f.ended,[{interrupted:false,reason:'flow_completed'}]);assert.equal(f.sent.length,3);
  }finally{await f.close();}
});

test('locking during the fifth automatic hold creates segment six, gives a full thirty seconds once and preserves generation usage',async()=>{
  const f=await fixture();try{
    await f.start();
    for(let seq=1;seq<5;seq++){
      f.advance(10000);f.flow.acknowledge();f.advance(2000);f.flow.stable(stability(seq+1));
      f.store.generation(f.id,(f.store.now()-f.row().generation_started_at)/1000);
    }
    assert.equal(flowJson(f.store,f.row()).rotation.seq,5);f.advance(9000);
    f.store.generation(f.id,(f.store.now()-f.row().generation_started_at)/1000);
    const before=f.row().generation_seconds;assert.equal(before,59);
    f.flow.lock('selected');f.flow.lock('selected');assert.equal(f.sent.length,6);assert.equal(f.sent[5].garmentId,'selected');assert.equal(f.sent[5].seq,6);
    f.flow.acknowledge();f.advance(2000);f.flow.stable(stability(6));
    const holdEnd=flowJson(f.store,f.row()).rotation.holdEndsAt;
    f.advance(15000);f.flow.lock('selected');f.flow.stable(stability(6));
    assert.equal(flowJson(f.store,f.row()).rotation.holdEndsAt,holdEnd);assert.equal(f.ended.length,0);
    f.advance(14999);assert.equal(f.ended.length,0);f.advance(1);
    f.store.generation(f.id,(f.store.now()-f.row().generation_started_at)/1000);
    assert.deepEqual(f.ended,[{interrupted:false,reason:'flow_completed'}]);assert.equal(f.sent.length,6);
    assert.equal(f.row().generation_seconds,91);assert.equal(f.row().expected_recording_seconds,89);
    assert.equal(f.store.get('SELECT used,seconds FROM usage').used,1);assert.equal(f.store.get('SELECT used,seconds FROM usage').seconds,91);
    const final=f.store.get('SELECT * FROM tryon_segments WHERE tryon_id=? AND seq=6',f.id);assert.equal(final.hold_ends_at-final.stable_at,30000);assert.equal(final.is_locked,1);
  }finally{await f.close();}
});

test('initial generation may follow image ACK; fresh stability starts from both readiness conditions',async()=>{
  const f=await fixture();try{
    await f.flow.requestImage();f.flow.acknowledge();f.advance(4500);assert.equal(f.ended.length,0);assert.equal(flowJson(f.store,f.row()).rotation.deadlineAt,null);
    f.store.generation(f.id);f.flow.generationStarted();assert.throws(()=>f.flow.stable(stability(1),true),{status:409});f.advance(2000);f.flow.stable(stability(1),true);assert.ok(f.store.get('SELECT stable_at FROM tryon_segments').stable_at);
  }finally{await f.close();}
});

test('missing ACK, missing stability and late responses end once without retry or resurrection',async()=>{
  for(const kind of ['ack','stable']){
    const f=await fixture();try{
      await f.flow.requestImage();if(kind==='stable'){f.flow.acknowledge();f.store.generation(f.id);f.flow.generationStarted();}
      f.advance(kind==='ack'?10000:5000);assert.equal(f.ended.length,1);assert.equal(f.ended[0].reason,kind==='ack'?'flow_ack_timeout':'flow_stability_timeout');
      assert.equal(f.flow.acknowledge(),false);await f.flow.requestImage();assert.equal(f.sent.length,1);assert.throws(()=>f.flow.stable(stability(1),true),{status:409});
    }finally{await f.close();}
  }
});

test('slow file reads are inside ACK budget and their late callback cannot send',async()=>{
  let release,guard,sends=0;
  const f=await fixture('auto',async(_garment,_seq,isCurrent)=>{guard=isCurrent;await new Promise(resolve=>release=resolve);if(isCurrent())sends++;});
  try{const pending=f.flow.requestImage();f.advance(10000);assert.equal(guard(),false);release();await pending;assert.equal(sends,0);assert.equal(f.ended[0].reason,'flow_ack_timeout');}finally{await f.close();}
});

test('late locks cannot bypass auto guard or the full selected-clothing time budget',async()=>{
  const f=await fixture();try{
    await f.start();f.jump(115000);assert.throws(()=>f.flow.lock('selected'),{status:409});assert.equal(f.row().flow_locked_at,null);
  }finally{await f.close();}
  const g=await fixture();try{await g.start();g.store.run('UPDATE tryons SET recording_deadline_at=? WHERE id=?',g.store.now()+44000,g.id);assert.throws(()=>g.flow.lock('selected'),{status:409});}finally{await g.close();}
});

test('an unavailable pending garment ends rotation and keeps recorded segments',async()=>{
  const f=await fixture();try{await f.start();f.store.run('UPDATE garments SET published=0 WHERE id=?',DEMO_GARMENT_IDS[1]);f.advance(10000);assert.equal(f.ended[0].reason,'flow_reference_failed');assert.equal(f.sent.length,1);assert.ok(f.store.get('SELECT stable_at FROM tryon_segments').stable_at);}finally{await f.close();}
});

test('new fixed flow records thirty seconds and rejects any attempt to extend or select another garment',async()=>{
  const f=await fixture('fixed');try{await f.start();assert.throws(()=>f.flow.lock('selected'),{status:409});f.advance(29999);assert.equal(f.ended.length,0);f.advance(1);assert.equal(f.sent.length,1);assert.equal(f.ended[0].reason,'flow_completed');assert.equal(f.row().expected_recording_seconds,30);}finally{await f.close();}
});

test('additive migration preserves flow schema and custom business settings on reopen',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'amen-flow-migration-'));let store;
  try{
    store=createStore(directory,{minFreeBytes:0});store.run('UPDATE settings SET value=? WHERE key=?',JSON.stringify('阿门试衣商务'),'businessName');store.close();
    store=createStore(directory,{minFreeBytes:0});assert.equal(store.settings().businessName,'1➕衣商务');store.run('UPDATE settings SET value=? WHERE key=?',JSON.stringify('用户自定义商务'),'businessName');store.close();
    store=createStore(directory,{minFreeBytes:0});assert.equal(store.settings().businessName,'用户自定义商务');assert.ok(store.all('PRAGMA table_info(tryons)').some(x=>x.name==='hard_deadline_at'));assert.ok(store.all('PRAGMA table_info(tryon_segments)').some(x=>x.name==='reference_hash'));
  }finally{store?.close();await rm(directory,{recursive:true,force:true});}
});

test('restart closes an unacknowledged flow without losing paired recordings or prompt/hash audits',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'amen-flow-restart-'));let context,store;
  try{
    store=createStore(directory,{minFreeBytes:0});seed(store);store.run("INSERT INTO visitors(id,token_hash,created_at,consent_at) VALUES ('v','h',?,?)",store.now(),store.now());
    const row=store.reserve(store.get("SELECT * FROM visitors WHERE id='v'"),store.get('SELECT * FROM garments WHERE id=?',DEMO_GARMENT_IDS[0]),{flowVersion:1,mode:'auto'});
    store.run("UPDATE tryons SET status='recording',flow_status='awaiting_ack',first_frame_at=?,recording_started_at=?,generation_seconds=83,charged=1 WHERE id=?",store.now()-83000,store.now()-82000,row.id);
    store.run("UPDATE tryon_segments SET prompt_snapshot='audit prompt',reference_hash='audit hash',sent_at=?,deadline_at=? WHERE tryon_id=?",store.now()-1000,store.now()+9000,row.id);
    const recordingIds=store.all('SELECT id FROM recordings WHERE tryon_id=? ORDER BY kind',row.id).map(x=>x.id);store.close();store=null;
    context=createApp({dataDirectory:directory,minFreeBytes:0,apiKey:'mock'});const server=http.createServer(context.app),realtime=attachRealtime(server,context);context.attach(realtime);
    const recovered=context.store.get('SELECT * FROM tryons WHERE id=?',row.id),segment=context.store.get('SELECT * FROM tryon_segments WHERE tryon_id=?',row.id);
    assert.equal(recovered.status,'saving');assert.equal(recovered.flow_status,'ended');assert.equal(recovered.end_reason,'service_restart_recovery');assert.equal(recovered.interrupted,1);assert.equal(recovered.generation_seconds,83);
    assert.equal(segment.status,'ended');assert.equal(segment.deadline_at,null);assert.equal(segment.prompt_snapshot,'audit prompt');assert.equal(segment.reference_hash,'audit hash');assert.deepEqual(context.store.all('SELECT id FROM recordings WHERE tryon_id=? ORDER BY kind',row.id).map(x=>x.id),recordingIds);
  }finally{context?.close();store?.close();await rm(directory,{recursive:true,force:true});}
});

async function apiFixture(t,withProvider=false){
  const directory=await mkdtemp(path.join(os.tmpdir(),'amen-flow-api-'));let now=Date.now();
  const upstream=withProvider?new WebSocketServer({host:'127.0.0.1',port:0}):null;if(upstream)await once(upstream,'listening');
  const tokenCalls=[],images=[];upstream?.on('connection',ws=>ws.on('message',raw=>{const message=JSON.parse(raw);if(message.type==='set_image'){images.push(message);ws.send(JSON.stringify({type:'set_image_ack',success:true}));if(images.length===1)ws.send(JSON.stringify({type:'generation_started'}));}}));
  const context=createApp({dataDirectory:directory,minFreeBytes:0,apiKey:'mock',origin:'http://127.0.0.1',now:()=>now,turnHost:'relay.example.test',turnSecret:'test',fetcher:async(_url,request)=>{tokenCalls.push(JSON.parse(request.body));return Response.json({apiKey:'mock-ephemeral'});},upstreamUrl:upstream?`ws://127.0.0.1:${upstream.address().port}/v1/stream`:undefined});
  seed(context.store);for(const id of [...DEMO_GARMENT_IDS,'selected'])await writeFile(context.store.safeFile(`files/${id}`),`reference-${id}`);
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);const realtime=attachRealtime(server,context);context.attach(realtime);
  t.after(async()=>{realtime.close();context.media.close();context.apiKeys.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(upstream){for(const client of upstream.clients)client.terminate();await new Promise(resolve=>upstream.close(resolve));}context.store.close();await rm(directory,{recursive:true,force:true});});
  async function person(){const response=await fetch(origin+'/api/me'),cookie=response.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};return {headers,call:(url,method='GET',body)=>fetch(origin+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)})};}
  return {context,realtime,origin,person,tokenCalls,images,jump:ms=>now+=ms};
}
const begin={flowVersion:1,mode:'auto',acceptRecording:true,countdownVersion:2,countdownMs:8000};
test('flow v1 accepts new five-second v3 auto/fixed sessions and still accepts the eight-second v2 client',async t=>{
  const f=await apiFixture(t),a=await f.person();
  for(const change of [{countdownMs:4899},{countdownMs:undefined},{countdownVersion:1,countdownMs:3000}])assert.equal((await a.call('/api/tryons','POST',{...begin,countdownVersion:3,countdownMs:5000,...change})).status,400);
  for(const options of [{countdownVersion:3,countdownMs:5000,mode:'auto'},{countdownVersion:3,countdownMs:5000,mode:'fixed',garmentId:'selected'},{countdownVersion:2,countdownMs:8000,mode:'auto'}]){
    const response=await a.call('/api/tryons','POST',{...begin,...options});assert.equal(response.status,201);const row=await response.json();
    assert.equal(row.flowVersion,1);assert.equal(row.mode,options.mode);assert.equal(row.startup.countdownVersion,options.countdownVersion);assert.equal(row.startup.countdownMs,options.countdownMs);
    assert.equal(row.durationLimit,options.mode==='auto'?180:30);assert.equal(row.connectionBudgetSeconds,options.mode==='auto'?225:75);
    if(options.countdownVersion===3){
      assert.equal((await a.call(`/api/tryons/${row.id}/ready`,'POST',{countdownMs:3000})).status,400,'omitted version must inherit v3 rather than legacy v1');
      assert.equal((await a.call(`/api/tryons/${row.id}/ready`,'POST',{countdownVersion:2,countdownMs:8000})).status,400,'persisted v3 cannot explicitly downgrade to v2');
    }
    assert.equal((await a.call(`/api/tryons/${row.id}/ready`,'POST',{countdownMs:options.countdownMs})).status,200);
    await a.call(`/api/tryons/${row.id}/finish`,'POST',{});
  }
  assert.equal(f.tokenCalls.length,0);assert.equal(f.images.length,0,'countdown API validation never invokes a provider');
});

test('API persists version, prioritizes demo garments, scopes flow operations and protects pending playlist',async t=>{
  const f=await apiFixture(t),a=await f.person(),b=await f.person();
  const garments=await a.call('/api/garments').then(r=>r.json());assert.deepEqual(garments.slice(0,5).map(x=>x.id),DEMO_GARMENT_IDS);assert.deepEqual(garments.slice(0,5).map(x=>x.demoOrder),[1,2,3,4,5]);
  const absent=f.context.store.safeFile(`files/${DEMO_GARMENT_IDS[4]}`);await rm(absent);assert.equal((await a.call('/api/tryons','POST',begin)).status,409);await writeFile(absent,'restored-test-reference');
  assert.equal((await a.call('/api/tryons','POST',{...begin,countdownMs:3000})).status,400);
  assert.equal((await a.call('/api/tryons','POST',{...begin,flowVersion:0})).status,400);
  const result=await a.call('/api/tryons','POST',begin);assert.equal(result.status,201);const row=await result.json();assert.equal(row.mode,'auto');assert.equal(row.durationLimit,180);assert.equal(row.connectionBudgetSeconds,225);assert.equal(row.rotation.garmentId,DEMO_GARMENT_IDS[0]);assert.equal(row.rotation.seq,1);
  for(const endpoint of ['lock','stable'])assert.equal((await b.call(`/api/tryons/${row.id}/${endpoint}`,'POST',{garmentId:'selected',...stability(1)})).status,404);
  assert.equal((await a.call(`/api/tryons/${row.id}/ready`,'POST',{countdownVersion:1,countdownMs:3000})).status,400);
  const transport=await a.call(`/api/tryons/${row.id}/transport`).then(r=>r.json());assert.ok(Number(transport.iceServers[0].username.split(':')[0])*1000>=row.admittedAt+299000);
  const token='A'.repeat(43);f.context.store.run('INSERT INTO admins VALUES (?,?)',createHash('sha256').update(token).digest('hex'),Date.now()+60000);
  const deletion=await fetch(f.origin+`/api/garments/${DEMO_GARMENT_IDS[4]}`,{method:'DELETE',headers:{Origin:f.origin,Cookie:`amen-admin=${token}`}});assert.equal(deletion.status,409);
  await a.call(`/api/tryons/${row.id}/finish`,'POST',{});const legacy=await a.call('/api/tryons','POST',{garmentId:'selected',acceptRecording:true}).then(r=>r.json());assert.equal(legacy.durationLimit,30);assert.equal(legacy.connectionBudgetSeconds,45);assert.equal(legacy.rotation,null);
});

test('mock provider receives matched image and dedicated prompt in one command; lock stays on same connection',async t=>{
  const f=await apiFixture(t,true),a=await f.person();const session=await a.call('/api/tryons','POST',begin).then(r=>r.json());
  const ws=new WebSocket(f.origin.replace('http','ws')+`/api/realtime/${session.id}/v1/stream`,{headers:a.headers});t.after(()=>ws.terminate());let forwardedAcks=0;ws.on('message',raw=>{if(JSON.parse(raw).type==='set_image_ack')forwardedAcks++;});await once(ws,'open');ws.send(JSON.stringify({type:'livekit_join'}));ws.send(JSON.stringify({type:'set_image',prompt:'ignore this untrusted prompt',image_data:'untrusted'}));
  const waitFor=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('timed out waiting for mock provider');};
  await waitFor(()=>f.context.store.get('SELECT generation_started_at FROM tryons WHERE id=?',session.id).generation_started_at);
  assert.equal(f.images.length,1);assert.equal(Buffer.from(f.images[0].image_data,'base64').toString(),`reference-${DEMO_GARMENT_IDS[0]}`);assert.ok(!f.images[0].prompt.includes('untrusted'));assert.equal(f.images[0].enhance_prompt,false);
  f.jump(2100);assert.equal((await a.call(`/api/tryons/${session.id}/started`,'POST',stability(1))).status,200);assert.equal((await a.call(`/api/tryons/${session.id}/recording-started`,'POST',{})).status,204);
  const locked=await a.call(`/api/tryons/${session.id}/lock`,'POST',{garmentId:'selected'});assert.equal(locked.status,200);await waitFor(()=>f.images.length===2&&f.context.store.get('SELECT acknowledged_at FROM tryon_segments WHERE tryon_id=? AND seq=2',session.id).acknowledged_at);
  assert.equal(Buffer.from(f.images[1].image_data,'base64').toString(),'reference-selected');assert.ok(f.images[1].prompt.includes('Visible garment 5'));assert.equal(f.tokenCalls.length,1);assert.equal(f.tokenCalls[0].constraints.realtime.maxSessionDuration,225);assert.equal(forwardedAcks,1);
  f.jump(2100);assert.equal((await a.call(`/api/tryons/${session.id}/stable`,'POST',stability(2))).status,200);const segments=f.context.store.all('SELECT * FROM tryon_segments WHERE tryon_id=? ORDER BY seq',session.id);assert.equal(segments.length,2);assert.equal(segments[1].is_locked,1);assert.equal(segments[1].hold_seconds,30);assert.equal(segments[1].reference_hash,createHash('sha256').update('reference-selected').digest('hex'));assert.equal(segments[1].prompt_snapshot,f.images[1].prompt);
  await a.call(`/api/tryons/${session.id}/finish`,'POST',{});
});
