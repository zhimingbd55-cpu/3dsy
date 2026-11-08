import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createApp} from '../server/app.mjs';
import {streamMetrics} from '../src/stream-metrics.ts';

test('performance endpoint accepts v1/v2, validates optional camera diagnostics and excludes identifiers',async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'amen-performance-v2-'));let now=Date.now();
 const context=createApp({dataDirectory:folder,minFreeBytes:0,now:()=>now,origin:'http://127.0.0.1',apiKey:'mock-only'});
 const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);
 const person=()=>{let cookie='';return async(url,method='GET',body)=>{const response=await fetch(origin+url,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return response;};};
 const owner=person(),other=person();
 try{
  await writeFile(context.store.safeFile('files/ref'),'reference');
  context.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,created_at) VALUES ('garment','Coat','ref','files/ref','image/webp','files/ref',1,?)",now);
  await owner('/api/me');const session=await owner('/api/tryons','POST',{garmentId:'garment',acceptRecording:true}).then(response=>response.json());
  context.store.run("UPDATE tryons SET status='saving',first_frame_at=?,ended_at=? WHERE id=?",now-1000,now,session.id);
  const url=`/api/tryons/${session.id}/performance`;
  const base={samples:1,qualityMode:'smooth',initialProfile:'smooth',finalProfile:'smooth'};
  const send=body=>{now+=60001;context.store.run('UPDATE tryons SET first_frame_at=? WHERE id=?',now-1000,session.id);return owner(url,'POST',body);};
  assert.equal((await other(url,'POST',base)).status,404);
  assert.equal((await send({...base,configVersion:'smooth-v1'})).status,204);
  let summary=JSON.parse(context.store.get('SELECT summary FROM stream_metrics WHERE tryon_id=?',session.id).summary);assert.equal(summary.configVersion,'smooth-v1');assert.equal(summary.actualCameraFps,null);assert.equal(summary.previewFps,null);for(const key of ['outputStallMs','outputStallCount','playbackRecoveryAttempts','playbackRecoveries'])assert.equal(summary[key],null);
  const diagnostics={actualCameraWidth:480,actualCameraHeight:640,actualCameraFps:19.9,cameraConstraintResult:'adjusted',previewFps:19.7,previewLongGapMs:300,outputStallMs:14300.5,outputStallCount:2,playbackRecoveryAttempts:2,playbackRecoveries:1};
  assert.equal((await send({...base,...diagnostics,configVersion:'smooth-v2',deviceId:'private-camera',address:'private-ip'})).status,204);
  summary=JSON.parse(context.store.get('SELECT summary FROM stream_metrics WHERE tryon_id=?',session.id).summary);
  for(const [key,value] of Object.entries(diagnostics))assert.equal(summary[key],value);
  assert.equal(summary.deviceId,undefined);assert.equal(summary.address,undefined);
  for(const invalid of [{configVersion:'smooth-v3'},{cameraConstraintResult:'yes'},{actualCameraWidth:480.5},{actualCameraHeight:8192},{actualCameraFps:'20'},{previewFps:-1},{previewLongGapMs:600001},{outputStallMs:600001},{outputStallCount:-1},{playbackRecoveryAttempts:121},{playbackRecoveries:'1'}])assert.equal((await send({...base,...diagnostics,configVersion:'smooth-v2',...invalid})).status,400);
 }finally{
  context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});
 }
});

test('dual-peer path-count regression: former summary fails with 400, real sample-based summary persists with 204',async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'amen-performance-dual-peer-'));let now=Date.now();
 const context=createApp({dataDirectory:folder,minFreeBytes:0,now:()=>now,origin:'http://127.0.0.1',apiKey:'mock-only'});
 const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);let cookie='';
 const request=async(url,body)=>{const response=await fetch(origin+url,{method:body?'POST':'GET',headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return response;};
 try{
  await writeFile(context.store.safeFile('files/ref'),'reference');
  context.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,created_at) VALUES ('garment','Coat','ref','files/ref','image/webp','files/ref',1,?)",now);
  await request('/api/me');const session=await request('/api/tryons',{garmentId:'garment',acceptRecording:true}).then(response=>response.json());
  context.store.run("UPDATE tryons SET status='saving',first_frame_at=?,ended_at=? WHERE id=?",now-1000,now,session.id);
  const pairs=[{local:{candidateType:'host',address:'private-camera-address'},remote:{candidateType:'srflx',address:'private-provider-address'}},{local:{candidateType:'srflx'},remote:{candidateType:'host'}}];
  const metrics=streamMetrics();metrics.beginCapture();metrics.sample({outboundVideo:{framesPerSecond:20},video:{framesPerSecond:8},connection:{selectedCandidatePairs:pairs},remoteInbound:{fractionLost:.0134}});
  metrics.setPlaybackDiagnostics({outputStallMs:14300,outputStallCount:2,playbackRecoveryAttempts:2,playbackRecoveries:0});
  const summary=metrics.summary(),url=`/api/tryons/${session.id}/performance`;
  const oldSummary={...summary,directPathSamples:pairs.length};
  assert.equal((await request(url,oldSummary)).status,400);
  assert.equal(context.store.get('SELECT summary FROM stream_metrics WHERE tryon_id=?',session.id),undefined);
  assert.equal((await request(url,summary)).status,204);
  let saved=JSON.parse(context.store.get('SELECT summary FROM stream_metrics WHERE tryon_id=?',session.id).summary);
  assert.equal(saved.samples,1);assert.equal(saved.directPathSamples,1);assert.equal(saved.relayPathSamples,0);assert.equal(saved.sentFps,20);assert.equal(saved.receivedFps,8);assert.equal(saved.cameraFps,null);assert.equal(saved.presentedFps,null);assert.equal(saved.outputStallMs,14300);assert.equal(saved.outputStallCount,2);assert.equal(saved.playbackRecoveryAttempts,2);assert.equal(saved.playbackRecoveries,0);assert.ok(!JSON.stringify(saved).includes('private-'));
  assert.equal(saved.lossFraction,.0134);assert.equal(saved.freezeMs,null);assert.equal(saved.droppedFrames,null);assert.equal(saved.presentedDrops,null);
  // A relay at the remote endpoint is still a relay; duplicate peer reports
  // must never turn one sample into two path samples.
  metrics.beginCapture();const remoteRelay={local:{candidateType:'host'},remote:{candidateType:'relay',address:'private-relay-address'}};
  metrics.sample({video:{},connection:{selectedCandidatePairs:[remoteRelay,remoteRelay]}});
  assert.equal((await request(url,metrics.summary())).status,204);
  saved=JSON.parse(context.store.get('SELECT summary FROM stream_metrics WHERE tryon_id=?',session.id).summary);
  assert.equal(saved.relayPathSamples,1);assert.equal(saved.directPathSamples,0);assert.equal(saved.sentFps,null);assert.equal(saved.receivedFps,null);assert.ok(!JSON.stringify(saved).includes('private-'));
 }finally{context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});
