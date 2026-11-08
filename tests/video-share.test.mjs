import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {once} from 'node:events';
import {scryptSync} from 'node:crypto';
import {createApp} from '../server/app.mjs';

test('share link exposes only paired clips, follows late original upload, supports ranges and can be revoked',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-share-'));let now=Date.now();
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const context=createApp({dataDirectory:folder,minFreeBytes:0,now:()=>now,origin:'http://127.0.0.1',root,dev:true,apiKey:'mock-only',adminHash:'scrypt$test$'+scryptSync('test-password','test',64).toString('hex')});
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);
  const person=()=>{let cookie='';return async(url,method='GET',body,headers={})=>{const response=await fetch(origin+url,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return response;};};
  const owner=person(),friend=person(),admin=person();
  try{
    await writeFile(context.store.safeFile('files/ref'),'reference');
    context.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,created_at) VALUES ('garment','Coat','ref','files/ref','image/webp','files/ref',1,?)",now);
    const ownerInfo=await owner('/api/me').then(response=>response.json());
    await owner('/api/me/consent','POST',{});
    const session=await owner('/api/tryons','POST',{garmentId:'garment',acceptRecording:true}).then(response=>response.json());
    context.store.generation(session.id,30);
    context.store.run("UPDATE tryons SET status='saving',first_frame_at=?,ended_at=? WHERE id=?",now-30000,now,session.id);
    const result=context.store.get("SELECT * FROM recordings WHERE tryon_id=? AND kind='result'",session.id);
    const original=context.store.get("SELECT * FROM recordings WHERE tryon_id=? AND kind='original'",session.id);
    await mkdir(context.store.safeFile(`sessions/${session.id}`),{recursive:true});
    await writeFile(context.store.safeFile(`sessions/${session.id}/result.mp4`),Buffer.from('fake-mp4-result-bytes'));
    await writeFile(context.store.safeFile(`sessions/${session.id}/result.jpg`),Buffer.from('fake-jpeg-poster'));
    context.store.run("UPDATE recordings SET status='ready',duration=30,final_path=?,poster_path=? WHERE id=?",`sessions/${session.id}/result.mp4`,`sessions/${session.id}/result.jpg`,result.id);
    const diagnostics={samples:5,sentFps:20,receivedFps:6,rttMs:180,droppedFrames:8,cpuLimitedSamples:0,bandwidthLimitedSamples:0,sendBitrateBps:1100000,receiveBitrateBps:500000,availableOutgoingBps:4000000,freezeMs:900,decodeMs:11,sendQueueDelayMs:22,lossFraction:.02,cameraFps:20,presentedFps:6,paintP95Ms:8,presentedDrops:12,glassToGlassMs:340,relayPathSamples:5,directPathSamples:0,qualityMode:'smooth',fluidReason:null,senderParametersApplied:null,configVersion:'smooth-v1',initialProfile:'smooth',finalProfile:'smooth',actualSendWidth:540,actualSendHeight:960,actualSimulcastLayers:2,targetSendBitrateBps:1350000};
    context.store.run('INSERT INTO stream_metrics(tryon_id,captured_at,summary) VALUES (?,?,?)',session.id,now,JSON.stringify(diagnostics));
    context.store.run('UPDATE recordings SET expected_chunks=2,upload_updated_at=? WHERE id=?',now-120000,original.id);

    const create=()=>owner(`/api/tryons/${session.id}/share`,'POST',{});
    const first=await create();assert.equal(first.status,200);const link=await first.json();
    const repeated=await create().then(response=>response.json());assert.deepEqual(repeated,link);
    const token=new URL(link.url).pathname.split('/').at(-1);
    assert.equal(link.expiresAt,session.createdAt+30*86400000);
    assert.equal((await friend(`/s/${token}`)).status,200);
    const page=await friend(`/s/${token}`);assert.equal(page.headers.get('referrer-policy'),'no-referrer');assert.equal(page.headers.get('permissions-policy'),'camera=(), microphone=()');
    const pageHtml=await page.text();assert.equal((pageHtml.match(/property="og:image"/g)||[]).length,1);assert(pageHtml.includes(`property="og:url" content="${origin}/s/${token}"`));assert(pageHtml.includes(`property="og:image" content="${origin}/brand/share-thumb.png"`));assert(!pageHtml.includes(`/api/shares/${token}/result/poster`));assert.equal(page.headers.get('x-robots-tag'),'noindex, nofollow');assert.match(page.headers.get('cache-control'),/no-store/);
    const publicView=await friend(`/api/shares/${token}`).then(response=>response.json());
    assert.equal(publicView.garmentName,'Coat');assert.equal(publicView.original.status,'uploading');assert.equal(publicView.original.waitingForUpload,true);assert.equal(publicView.original.videoUrl,null);assert.ok(publicView.result.videoUrl);assert.equal(publicView.visitorId,undefined);assert.equal(JSON.stringify(publicView).includes('sessions/'),false);
    assert.equal((await owner(`/api/tryons/${session.id}`).then(response=>response.json())).performance,undefined);
    const range=await friend(publicView.result.videoUrl,'GET',undefined,{Range:'bytes=0-3'});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,4);
    assert.equal((await friend(`/api/shares/${token}/result/poster`)).status,200);
    assert.equal((await friend(`/api/shares/${token}/other/video`)).status,404);
    assert.equal((await owner(`/api/recordings/${result.id}/video?download=1`)).status,409);
    assert.equal((await owner(`/api/recordings/${result.id}/video`)).status,200);
    assert.equal((await owner(`/api/tryons/${session.id}/hide`,'POST',{})).status,409);
    assert.equal((await owner(`/api/tryons/${session.id}`,'DELETE')).status,409);
    assert.equal((await owner('/api/tryons').then(response=>response.json())).some(item=>item.id===session.id),true);

    await writeFile(context.store.safeFile(`sessions/${session.id}/original.mp4`),Buffer.from('fake-mp4-original-bytes'));
    await writeFile(context.store.safeFile(`sessions/${session.id}/original.jpg`),Buffer.from('fake-jpeg-original'));
    context.store.run("UPDATE recordings SET status='ready',duration=30,final_path=?,poster_path=? WHERE id=?",`sessions/${session.id}/original.mp4`,`sessions/${session.id}/original.jpg`,original.id);
    const updated=await friend(`/api/shares/${token}`).then(response=>response.json());assert.equal(updated.original.status,'ready');assert.ok(updated.original.videoUrl);assert.equal(new URL(updated.result.videoUrl,origin).pathname,`/api/shares/${token}/result/video`);

    assert.equal((await admin('/api/admin/login','POST',{username:'admin',password:'test-password'})).status,200);
    const adminItem=await admin('/api/admin/tryons').then(response=>response.json()).then(data=>data.items.find(item=>item.id===session.id));assert.equal(adminItem.performance.sentFps,20);assert.equal(adminItem.performance.receivedFps,6);assert.equal(adminItem.performance.glassToGlassMs,340);assert.equal(adminItem.performance.configVersion,'smooth-v1');assert.equal(adminItem.performance.actualSimulcastLayers,2);
    assert.equal((await admin(`/api/admin/tryons/${session.id}/share/revoke`,'POST',{})).status,204);
    assert.equal((await friend(`/api/shares/${token}`)).status,404);
    assert.equal((await friend(`/s/${token}`)).status,404);
    assert.equal((await friend(`/api/shares/${token}/result/video`)).status,404);

    const secondSession=await owner('/api/tryons','POST',{garmentId:'garment',acceptRecording:true}).then(response=>response.json());
    context.store.generation(secondSession.id,30);context.store.run("UPDATE tryons SET status='saving',first_frame_at=?,ended_at=? WHERE id=?",now-30000,now,secondSession.id);
    const secondResult=context.store.get("SELECT * FROM recordings WHERE tryon_id=? AND kind='result'",secondSession.id);
    await mkdir(context.store.safeFile(`sessions/${secondSession.id}`),{recursive:true});
    await writeFile(context.store.safeFile(`sessions/${secondSession.id}/result.mp4`),Buffer.from('second-mp4'));
    await writeFile(context.store.safeFile(`sessions/${secondSession.id}/result.jpg`),Buffer.from('second-jpeg'));
    context.store.run("UPDATE recordings SET status='ready',duration=30,final_path=?,poster_path=? WHERE id=?",`sessions/${secondSession.id}/result.mp4`,`sessions/${secondSession.id}/result.jpg`,secondResult.id);
    const restored=await owner(`/api/tryons/${secondSession.id}/share`,'POST',{}).then(response=>response.json());const restoredToken=new URL(restored.url).pathname.split('/').at(-1);
    assert.notEqual(restoredToken,token);
    assert.equal((await admin(`/api/admin/tryons/${session.id}`,'DELETE')).status,204);
    assert.equal((await friend(`/api/shares/${restoredToken}`)).status,200);
    assert.equal((await friend(`/s/${restoredToken}`)).status,200);
    now=secondSession.createdAt+30*86400000;assert.equal((await friend(`/api/shares/${restoredToken}`)).status,410);assert.equal((await friend(`/s/${restoredToken}`)).status,410);
    assert.equal(ownerInfo.consented,false);
  }finally{
    context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});
  }
});
