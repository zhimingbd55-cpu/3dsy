import test from 'node:test';
import assert from 'node:assert/strict';
import {portraitCamera,hasLiveCameraVideo} from '../src/portrait.ts';

async function cameraHarness(t,{callbacks=true}={}){
  let now=0,nextId=0,draws=0,stops=0,captureRate,removed=false,paused=true,playCalls=0,nextPlay;
  const raf=new Map(),rvfc=new Map();
  const video={muted:false,autoplay:false,playsInline:false,srcObject:null,style:{},videoWidth:960,videoHeight:1280,readyState:4,currentTime:0,
    setAttribute(){},play:async()=>{playCalls++;const wait=nextPlay;nextPlay=undefined;await wait;paused=false;},pause(){paused=true;},remove(){removed=true;}};
  if(callbacks){video.requestVideoFrameCallback=fn=>{const id=++nextId;rvfc.set(id,fn);return id;};video.cancelVideoFrameCallback=id=>rvfc.delete(id);}
  const sourceTrack={readyState:'live',enabled:true};
  const captureTrack={readyState:'live',enabled:true,stop(){if(this.readyState==='live')stops++;this.readyState='ended';}};
  const source={getVideoTracks:()=>[sourceTrack]};
  const stream={getVideoTracks:()=>[captureTrack],getTracks:()=>[captureTrack]};
  const canvas={width:0,height:0,getContext:()=>({drawImage(_source,_sx,_sy,_sw,_sh,dx,dy,dw,dh){assert.equal(dx,0);assert.equal(dy,0);assert.equal(dw,360);assert.equal(dh,640);draws++;}}),captureStream:fps=>{captureRate=fps;return stream;}};
  const replacements={document:{body:{append(){}},createElement:tag=>tag==='video'?video:canvas},requestAnimationFrame:fn=>{const id=++nextId;raf.set(id,fn);return id;},cancelAnimationFrame:id=>raf.delete(id)};
  const restore=[];let camera;
  t.after(()=>{camera?.dispose();for(const reset of restore)reset();});
  for(const [key,value] of Object.entries(replacements)){
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
    restore.push(()=>descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key]);
  }
  t.mock.method(performance,'now',()=>now);
  const controller=new AbortController();camera=await portraitCamera(source,{signal:controller.signal});
  const advance=(ms,deliverVideo=false)=>{
    const end=now+ms;
    while(now<end){now+=1000/60;
      if(deliverVideo)for(const [id,fn] of [...rvfc]){rvfc.delete(id);fn(now,{mediaTime:now/1000});}
      for(const [id,fn] of [...raf]){raf.delete(id);fn(now);}
    }
  };
  const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
  const resume=async(deliverVideo=false)=>{const ready=camera.resume();await flush();advance(300,deliverVideo);await ready;};
  const delayNextPlay=()=>{let resolve;nextPlay=new Promise(yes=>{resolve=yes;});return resolve;};
  return {camera,controller,advance,resume,flush,delayNextPlay,stream,source,sourceTrack,captureTrack,video,stats:()=>({draws,stops,captureRate,removed,paused,playCalls,raf:raf.size,rvfc:rvfc.size}),staleCallbacks:()=>[...rvfc.values(),...raf.values()]};
}

test('camera starts with a usable initial frame but no idle drawing or hidden video playback',async t=>{
  const h=await cameraHarness(t);assert.equal(h.stats().draws,1);assert.equal(h.stats().paused,true);
  h.advance(5000,true);assert.equal(h.stats().draws,1);assert.equal(h.stats().raf,0);assert.equal(h.stats().rvfc,0);
  assert.equal(h.camera.stream,h.stream);assert.equal(h.stats().captureRate,20);
});

test('camera keeps painting when video callbacks exist but never fire and currentTime is unchanged',async t=>{
  const h=await cameraHarness(t);await h.resume();h.advance(2000);
  assert.ok(h.stats().draws>=35,'a live camera must not remain at the initial painted frame');
  assert.equal(h.stats().captureRate,20,'canvas capture has an explicit mobile-compatible smooth frame rate');
  h.controller.abort();const before=h.stats().draws;h.advance(1000);
  assert.equal(h.stats().draws,before);assert.equal(h.stats().raf,0);assert.equal(h.stats().rvfc,0);assert.equal(h.stats().removed,true);
});

test('camera fallback works without frame callbacks even when live currentTime is coarse',async t=>{
  const h=await cameraHarness(t,{callbacks:false});await h.resume();const before=h.stats().draws;h.advance(1000);
  assert.ok(h.stats().draws-before>=17);assert.ok(h.stats().draws-before<=23);
});

test('callback stalls recover and resuming callbacks do not double the render rate',async t=>{
  const h=await cameraHarness(t);await h.resume(true);h.advance(1000,true);
  let before=h.stats().draws;h.advance(1000);assert.ok(h.stats().draws-before>=15);
  before=h.stats().draws;h.advance(1000,true);
  assert.ok(h.stats().draws-before>=17);assert.ok(h.stats().draws-before<=23);
});

test('suspend stops both schedulers and resumes only after a new painted frame on the same track',async t=>{
  const h=await cameraHarness(t);await h.resume(true);const before=h.stats().draws,callbacks=h.staleCallbacks();h.camera.suspend();
  assert.equal(h.stats().paused,true);assert.equal(h.stats().raf,0);assert.equal(h.stats().rvfc,0);assert.equal(h.stats().stops,0);
  for(const callback of callbacks)callback(5000,{});h.advance(1000,true);assert.equal(h.stats().draws,before);
  let ready=false;const resumed=h.camera.resume().then(()=>{ready=true;});await h.flush();assert.equal(ready,false);
  h.advance(20,true);await resumed;assert.ok(h.stats().draws>before);assert.equal(h.camera.stream,h.stream);assert.equal(h.stats().stops,0);
});

test('aborting a pending resume rejects it and a late play completion cannot restart drawing',async t=>{
  const h=await cameraHarness(t),release=h.delayNextPlay(),controller=new AbortController();
  const resuming=h.camera.resume(controller.signal),rejected=assert.rejects(resuming,{name:'AbortError'});controller.abort();release();await h.flush();await rejected;
  h.advance(1000,true);assert.equal(h.stats().draws,1);assert.equal(h.stats().paused,true);assert.equal(h.stats().raf,0);assert.equal(h.stats().rvfc,0);
});

test('a cancelled resume cannot pause a newer active resume when its play resolves late',async t=>{
  const h=await cameraHarness(t),release=h.delayNextPlay();
  const older=h.camera.resume(),rejected=assert.rejects(older,{name:'AbortError'});h.camera.suspend();await rejected;
  await h.resume(true);release();await h.flush();const before=h.stats().draws;h.advance(1000,true);
  assert.ok(h.stats().draws>before);assert.equal(h.stats().paused,false);assert.equal(h.stats().stops,0);
});

test('repeated resume shares readiness and fps reduction never replaces canvas track',async t=>{
  const h=await cameraHarness(t),first=h.camera.resume(),second=h.camera.resume();assert.equal(first,second);
  await h.flush();h.advance(300,true);await first;assert.equal(h.stats().playCalls,2);
  h.camera.setFps(15);const before=h.stats().draws;h.advance(1000,true);
  assert.ok(h.stats().draws-before>=14);assert.ok(h.stats().draws-before<=17);assert.equal(h.camera.stream,h.stream);assert.equal(h.stats().stops,0);
  h.camera.dispose();await assert.rejects(h.camera.resume(),{name:'AbortError'});assert.equal(h.stats().stops,1);
});

test('resume with no playable camera frame expires without opening an unbounded frame pump',async t=>{
  const h=await cameraHarness(t);t.mock.timers.enable({apis:['setTimeout']});h.video.readyState=1;
  const resuming=h.camera.resume(),rejected=assert.rejects(resuming,/相机画面未恢复/);await h.flush();h.advance(1000,true);
  assert.equal(h.stats().draws,1);t.mock.timers.tick(5000);await rejected;
  assert.equal(h.stats().paused,true);assert.equal(h.stats().raf,0);assert.equal(h.stats().rvfc,0);assert.equal(h.stats().stops,0);
  h.video.readyState=4;await h.resume(true);assert.ok(h.stats().draws>1);
});

test('camera health requires a nonempty set of live enabled video tracks',()=>{
  assert.equal(hasLiveCameraVideo(null),false);
  assert.equal(hasLiveCameraVideo({getVideoTracks:()=>[]}),false);
  for(const track of [{readyState:'ended',enabled:true},{readyState:'live',enabled:false}])assert.equal(hasLiveCameraVideo({getVideoTracks:()=>[track]}),false);
  assert.equal(hasLiveCameraVideo({getVideoTracks:()=>[{readyState:'live',enabled:true}]}),true);
});

test('an ended output cannot be resumed by merely repainting a healthy raw camera',async t=>{
  const h=await cameraHarness(t);h.captureTrack.stop();const before=h.stats().draws;
  assert.equal(hasLiveCameraVideo(h.source),true);
  await assert.rejects(h.camera.resume(),/相机采集已中断/);
  h.advance(1000,true);assert.equal(h.stats().draws,before);assert.equal(h.stats().raf,0);assert.equal(h.stats().rvfc,0);
});

test('a disabled raw camera suspends an already-running pipeline instead of reporting readiness',async t=>{
  const h=await cameraHarness(t);await h.resume(true);h.sourceTrack.enabled=false;const before=h.stats().draws;
  await assert.rejects(h.camera.resume(),/相机采集已中断/);
  h.advance(1000,true);assert.equal(h.stats().draws,before);assert.equal(h.stats().paused,true);
});

test('an input ending while play is pending cannot satisfy the fresh-frame gate',async t=>{
  const h=await cameraHarness(t),release=h.delayNextPlay();
  const ready=h.camera.resume(),rejected=assert.rejects(ready,/相机采集已中断/);
  h.captureTrack.stop();release();await h.flush();h.advance(400,true);await rejected;
  assert.equal(h.stats().draws,1);assert.equal(h.stats().raf,0);assert.equal(h.stats().rvfc,0);assert.equal(h.stats().paused,true);
});
