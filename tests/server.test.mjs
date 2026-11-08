import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp,rm,readFile,writeFile,mkdir,utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scryptSync,createHmac,createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { WebSocket,WebSocketServer } from 'ws';
import { createApp } from '../server/app.mjs';
import { attachRealtime } from '../server/realtime.mjs';
import { beijingDay } from '../server/store.mjs';
import { PROMPT_VERSION } from '../server/tryon-prompt.mjs';
const execute=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
function smallGlb(){const gltf={asset:{version:'2.0'},buffers:[{byteLength:0}],accessors:[{componentType:5126,count:3,type:'VEC3'}],meshes:[{primitives:[{attributes:{POSITION:0}}]}]};const text=JSON.stringify(gltf),json=Buffer.from(text.padEnd(Math.ceil(Buffer.byteLength(text)/4)*4,' ')),jh=Buffer.alloc(8),bh=Buffer.alloc(8),head=Buffer.alloc(12);jh.writeUInt32LE(json.length,0);jh.writeUInt32LE(0x4e4f534a,4);bh.writeUInt32LE(0,0);bh.writeUInt32LE(0x004e4942,4);head.write('glTF',0,'ascii');head.writeUInt32LE(2,4);head.writeUInt32LE(12+8+json.length+8,8);return Buffer.concat([head,jh,json,bh]);}

test('private wardrobe, paired MP4 processing, quota, retention and administration',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'amen-test-'));let now=Date.now();
 const context=createApp({dataDirectory:folder,minFreeBytes:0,now:()=>now,apiKey:'mock-only',origin:'http://127.0.0.1',turnSecret:'test-relay-secret',turnHost:'relay.example.test',adminHash:'scrypt$test$'+scryptSync('test-password','test',64).toString('hex')});
 const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);
 const {store,media}=context;const realtime=attachRealtime(server,context);context.attach(realtime);
 const person=()=>{let cookie='';return async(url,method='GET',body,headers={})=>{const r=await fetch(origin+url,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body&&!(body instanceof FormData)&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}),...headers},body:body instanceof FormData||Buffer.isBuffer(body)?body:body?JSON.stringify(body):undefined});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return r;};};
 const a=person(),b=person(),admin=person();
 try{
  store.run("INSERT INTO garments(id,name,category,original_name,original_path,mime,image_path,published,position,created_at) VALUES ('fantasy-outfit-07','幻想服饰 07','outfit','fantasy.glb','files/fantasy.glb','model/gltf-binary','files/fantasy.webp',1,0,?)",Date.now());
  await t.test('anonymous identities and explicit consent',async()=>{assert.equal((await a('/api/me')).status,200);await b('/api/me');assert.equal(store.all('SELECT * FROM visitors').length,2);assert.equal((await admin('/api/admin/overview')).status,401);assert.equal((await fetch(origin+'/api/me/consent',{method:'POST'})).status,403);});
  const png=await sharp({create:{width:40,height:60,channels:3,background:'#abc'}}).png().toBuffer();
  const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'shirt.png');
  let garment;
  await t.test('private upload defaults to unknown category; an explicit category is recorded as known',async()=>{const r=await a('/api/garments','POST',form);assert.equal(r.status,201);garment=await r.json();assert.equal(garment.category,'outfit');assert.equal(garment.categoryKnown,false);assert.equal(garment.assetType,'2d');assert.equal(garment.modelUrl,null);assert.equal((await b(garment.imageUrl)).status,404);assert.equal((await b(`/api/garments/${garment.id}`,'DELETE')).status,404);assert.equal((await a(`/api/garments/${garment.id}/original`)).status,200);const wardrobe=await a('/api/garments').then(r=>r.json());assert.equal(wardrobe[0].id,'fantasy-outfit-07');assert.equal(wardrobe.some(item=>item.id===garment.id),true);const changed=await a(`/api/garments/${garment.id}`,'PATCH',{category:'top'}).then(r=>r.json());assert.equal(changed.category,'top');assert.equal(changed.categoryKnown,true);const categorized=new FormData();categorized.append('file',new Blob([png],{type:'image/png'}),'skirt.png');categorized.append('category','bottom');const uploaded=await a('/api/garments','POST',categorized).then(r=>r.json());assert.equal(uploaded.category,'bottom');assert.equal(uploaded.categoryKnown,true);});
  await t.test('GLB uploads require a generated reference and are served only to their owner',async()=>{const form3d=new FormData();form3d.append('file',new Blob([smallGlb()],{type:'model/gltf-binary'}),'sample.glb');form3d.append('reference',new Blob([png],{type:'image/png'}),'reference.png');form3d.append('category','top');const response=await a('/api/garments','POST',form3d);assert.equal(response.status,201);const item=await response.json();assert.equal(item.assetType,'3d');assert.equal(item.hasModel,true);assert.ok(item.modelUrl);assert.equal((await a(item.modelUrl)).status,200);assert.equal((await b(item.modelUrl)).status,404);assert.equal((await a(item.imageUrl)).status,200);});
  let session;
  await t.test('one Start action accepts the notice and reserves a session; passive visits do not',async()=>{
    assert.equal((await a('/api/me').then(r=>r.json())).consented,false);
    assert.equal((await a('/api/tryons','POST',{garmentId:garment.id})).status,403);
    assert.equal((await a('/api/tryons','POST',{garmentId:garment.id,acceptRecording:'true'})).status,403);
    assert.equal((await a('/api/me').then(r=>r.json())).consented,false);
    const r=await a('/api/tryons','POST',{garmentId:garment.id,acceptRecording:true});
    assert.equal(r.status,201);session=await r.json();assert.equal((await a('/api/me').then(r=>r.json())).consented,true);
    assert.equal((await b(`/api/tryons/${session.id}`)).status,404);assert.equal((await a('/api/me').then(r=>r.json())).remaining,2);
    await a(`/api/tryons/${session.id}/finish`,'POST',{interrupted:true});assert.equal((await a('/api/me').then(r=>r.json())).remaining,3);
  });
  await t.test('no uploads before generation and per-user concurrent reservation',async()=>{session=await a('/api/tryons','POST',{garmentId:garment.id}).then(r=>r.json());assert.equal((await a('/api/tryons','POST',{garmentId:garment.id})).status,409);assert.equal((await a(`/api/tryons/${session.id}/recordings/result/chunks/0`,'PUT',Buffer.from('fake'),{'Content-Type':'application/octet-stream','X-Recording-Type':'video/webm'})).status,409);});
  await t.test('relay credentials are owner-scoped, time-limited and not renewable by repeated fetch',async()=>{
    const url=`/api/tryons/${session.id}/transport`;assert.equal((await b(url)).status,404);
    const transport=await a(url).then(r=>r.json()),ice=transport.iceServers[0];
    assert.equal(ice.urls.length,3);assert.ok(ice.urls.some(u=>u.startsWith('turns:')));
    assert.equal(ice.credential,createHmac('sha1','test-relay-secret').update(ice.username).digest('base64'));
    assert.ok(Number(ice.username.split(':')[0])*1000<=now+75000);
    now+=1000;assert.deepEqual(await a(url).then(r=>r.json()),transport);
    assert.equal((await b(`/api/tryons/${session.id}/diagnostic`,'POST',{code:'ICE_CONNECT_FAILED'})).status,404);
    assert.equal((await a(`/api/tryons/${session.id}/diagnostic`,'POST',{code:'ICE_CONNECT_FAILED',platform:'ios'})).status,204);
    assert.match(store.get('SELECT error FROM tryons WHERE id=?',session.id).error,/ios/);
  });
  store.generation(session.id,30);store.run("UPDATE tryons SET status='saving',first_frame_at=?,ended_at=? WHERE id=?",now-30000,now,session.id);
  assert.equal((await a(`/api/tryons/${session.id}/transport`)).status,409);
  await t.test('performance diagnostics are bounded, owner scoped and exclude extra fields',async()=>{
    const url=`/api/tryons/${session.id}/performance`,body={samples:2,sentFps:24,receivedFps:21,rttMs:200,droppedFrames:2,cpuLimitedSamples:0,bandwidthLimitedSamples:1,address:'must-not-be-stored'};
    assert.equal((await b(url,'POST',body)).status,404);
    assert.equal((await a(url,'POST',{...body,sentFps:'24'})).status,400);
    assert.equal((await a(url,'POST',body)).status,204);
    const summary=JSON.parse(store.get('SELECT summary FROM stream_metrics WHERE tryon_id=?',session.id).summary);
    assert.equal(summary.receivedFps,21);assert.equal(summary.address,undefined);
  });
  await t.test('30-second synthetic video: chunk integrity, both H.264 outputs and isolation',async()=>{
   const input=path.join(folder,'synthetic.webm');await execute(context.options.ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=160x240:rate=10','-t','30','-an','-c:v','libvpx','-threads','2','-b:v','120k',input],{windowsHide:true,timeout:60000});
   const bytes=await readFile(input);
   for(const kind of ['original','result']){
    const base=`/api/tryons/${session.id}/recordings/${kind}`;
    const headers={'Content-Type':'application/octet-stream','X-Recording-Type':'video/webm'};
    assert.equal((await a(base+'/chunks/0','PUT',bytes,headers)).status,204);assert.equal((await a(base+'/chunks/0','PUT',bytes,headers)).status,204);assert.equal((await a(base+'/chunks/0','PUT',Buffer.from('wrong'),headers)).status,409);
    assert.equal((await a(base+'/complete','POST',{chunks:2})).status,409);assert.equal((await a(base+'/complete','POST',{chunks:1})).status,200);
   }
   for(let i=0;i<600&&!media.idle();i++)await sleep(50);
   const saved=await a(`/api/tryons/${session.id}`).then(r=>r.json());assert.equal(saved.status,'ready');assert.equal(saved.recordings.length,2);
   for(const rec of saved.recordings){assert.equal(rec.status,'ready');assert.ok(rec.duration>=29.3&&rec.duration<=30.5);assert.equal((await b(rec.url)).status,404);assert.equal((await a(rec.url+'?download=1')).status,409);const range=await a(rec.url,'GET',null,{Range:'bytes=0-99'});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,100);}
   const probe=await media.probe(store.safeFile(store.get("SELECT final_path FROM recordings WHERE tryon_id=? AND kind='result'",session.id).final_path));assert.equal(probe.streams[0].codec_name,'h264');assert.equal(probe.streams.filter(x=>x.codec_type==='audio').length,0);
  });
  await t.test('admin auth, paired access, disabled user removal and used quota',async()=>{assert.equal((await admin('/api/admin/login','POST',{username:'admin',password:'wrong'})).status,401);assert.equal((await admin('/api/admin/login','POST',{username:'admin',password:'test-password'})).status,200);assert.equal((await admin('/api/admin/tryons')).status,200);assert.equal((await a('/api/me').then(r=>r.json())).remaining,2);assert.equal((await a(`/api/garments/${garment.id}`,'DELETE')).status,204);assert.equal((await a(`/api/tryons/${session.id}`)).status,200);assert.equal((await a(`/api/tryons/${session.id}`,'DELETE')).status,409);assert.equal((await a(`/api/tryons/${session.id}/hide`,'POST')).status,409);assert.equal((await a('/api/tryons').then(r=>r.json())).some(x=>x.id===session.id),true);const retained=(await admin('/api/admin/tryons').then(r=>r.json())).items.find(x=>x.id===session.id);assert.equal(retained.userHiddenAt,null);for(const rec of retained.recordings)assert.equal((await admin(rec.url)).status,200);assert.equal((await a('/api/me').then(r=>r.json())).remaining,2);});
  await t.test('pause, storage quota and disk minimum block new writes',async()=>{await admin('/api/admin/settings','PATCH',{paused:true});assert.equal((await a('/api/me').then(r=>r.json())).available,false);await admin('/api/admin/settings','PATCH',{paused:false,dailyUser:1});assert.equal((await a('/api/me').then(r=>r.json())).remaining,0);store.run("UPDATE settings SET value='1' WHERE key='storageBytes'");const f=new FormData();f.append('file',new Blob([png]),'a.png');assert.equal((await a('/api/garments','POST',f)).status,507);assert.equal((await a('/api/tryons')).status,200);store.run("UPDATE settings SET value=? WHERE key='storageBytes'",String(20*1024**3));});
  await t.test('Beijing rollover, 30-day expiry and 24-hour temporary cleanup',async()=>{assert.equal(beijingDay(Date.parse('2026-10-09T16:00:00Z')),'2026-10-10');const stale=path.join(folder,'temporary/incoming','stale.upload');await writeFile(stale,'x');await utimes(stale,new Date(now-26*3600000),new Date(now-26*3600000));await media.cleanup();await assert.rejects(readFile(stale));now+=31*86400000;await media.cleanup();assert.equal(store.all('SELECT * FROM tryons').length,0);assert.equal((await a('/api/me').then(r=>r.json())).remaining,1);});
 }finally{realtime.close();media.close();await new Promise(r=>server.close(r));store.close();await rm(folder,{recursive:true,force:true});}
});

test('signaling enforces server garment/model, charges once, rejects arbitrary prompt and closes upstream',async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'amen-ws-'));
 const upstreamServer=new WebSocketServer({port:0,host:'127.0.0.1'});await once(upstreamServer,'listening');let providerArgs,upstreamClient,upstreamUrl;
 const received=[];
 upstreamServer.on('connection',(ws,req)=>{upstreamClient=ws;upstreamUrl=req.url;ws.on('message',m=>{const message=JSON.parse(m);received.push(message);if(message.type==='set_image'){ws.send(JSON.stringify({type:'set_image_ack',success:true}));ws.send(JSON.stringify({type:'generation_started'}));}});});
 const context=createApp({dataDirectory:folder,minFreeBytes:0,apiKey:'permanent-test',origin:'http://127.0.0.1',upstreamUrl:`ws://127.0.0.1:${upstreamServer.address().port}/v1/stream`,fetcher:async(url,args)=>{providerArgs=JSON.parse(args.body);return Response.json({apiKey:'ephemeral-test'});}});
 const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);const relay=attachRealtime(server,context);context.attach(relay);
 try{
  const r=await fetch(origin+'/api/me');const cookie=r.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};await fetch(origin+'/api/me/consent',{method:'POST',headers,body:'{}'});
  await writeFile(context.store.safeFile('files/reference.webp'),Buffer.from('SERVER-GARMENT'));
  context.store.run("INSERT INTO garments(id,name,category,category_known,details,original_name,original_path,mime,image_path,published,created_at) VALUES ('test','test','top',1,'a berry-red knit cardigan with rounded neckline, long sleeves and ribbed cuffs','test','files/reference.webp','image/webp','files/reference.webp',1,?)",Date.now());
  const session=await fetch(origin+'/api/tryons',{method:'POST',headers,body:JSON.stringify({garmentId:'test',target:'top',preparationMs:1200,countdownMs:3000})}).then(r=>r.json());
  assert.equal(session.target,'top');assert.equal(session.startup.preparationMs,1200);assert.equal(session.startup.countdownMs,3000);
  const ws=new WebSocket(origin.replace('http','ws')+`/api/realtime/${session.id}/v1/stream?model=arbitrary&api_key=attacker`,{headers:{Origin:origin,Cookie:cookie}});await once(ws,'open');
  assert.equal((await fetch(origin+`/api/tryons/${session.id}/started`,{method:'POST',headers,body:'{}'})).status,409);
  const providerEvents=new Promise(resolve=>{let seen=0;ws.on('message',()=>{if(++seen===2)resolve();});});
  ws.send(JSON.stringify({type:'livekit_join',passthrough:true}));ws.send(JSON.stringify({type:'set_image',image_data:'ATTACKER',prompt:'arbitrary'}));await providerEvents;
  assert.equal(providerArgs.constraints.realtime.maxSessionDuration,45);assert.deepEqual(providerArgs.allowedModels,['lucy-vton-3.6']);assert.match(upstreamUrl,/model=lucy-vton-3.6/);assert.equal(received[0].passthrough,false);assert.equal(received[1].image_data,Buffer.from('SERVER-GARMENT').toString('base64'));assert.notEqual(received[1].prompt,'arbitrary');
  assert.equal(received[1].enhance_prompt,false);assert.match(received[1].prompt,/^Substitute the upper body garment using the reference/);assert.match(received[1].prompt,/Specific reference garment details: a berry-red knit cardigan/);assert.match(received[1].prompt,/replace the visible original collar and graphics/);assert.match(received[1].prompt,/Preserve input identity, face/);assert.match(received[1].prompt,/Do not add glasses or reshape the face or hair/);assert.match(received[1].prompt,/background and lighting/);
  const promptRecord=context.store.get('SELECT prompt_version,prompt_snapshot,reference_hash FROM tryons WHERE id=?',session.id);assert.equal(promptRecord.prompt_version,PROMPT_VERSION);assert.equal(promptRecord.prompt_snapshot,received[1].prompt);assert.equal(promptRecord.reference_hash,createHash('sha256').update(Buffer.from('SERVER-GARMENT')).digest('hex'));
  context.store.generation(session.id,3);assert.equal(context.store.get('SELECT SUM(used) AS n FROM usage').n,1);
  const startup=await fetch(origin+`/api/tryons/${session.id}`,{headers}).then(r=>r.json());assert.equal(startup.startup.imageAccepted,true);assert.ok(startup.startup.generationStartedAt);
  const started=await fetch(origin+`/api/tryons/${session.id}/started`,{method:'POST',headers,body:'{}'});assert.equal(started.status,200);
  assert.equal((await fetch(origin+`/api/tryons/${session.id}/recording-started`,{method:'POST',headers,body:'{}'})).status,204);
  assert.ok(context.store.get('SELECT recording_started_at FROM tryons WHERE id=?',session.id).recording_started_at);
  const upstreamClosed=once(upstreamClient,'close');const browserClosed=once(ws,'close');ws.send(JSON.stringify({type:'prompt',prompt:'unexpected'}));await browserClosed;await upstreamClosed;assert.equal(relay.active.size,0);assert.equal(context.store.get('SELECT interrupted FROM tryons WHERE id=?',session.id).interrupted,1);
 }finally{relay.close();context.media.close();await new Promise(r=>server.close(r));await new Promise(r=>upstreamServer.close(r));context.store.close();await rm(folder,{recursive:true,force:true});}
});
