import test from 'node:test';
import assert from 'node:assert/strict';
import {previewMetrics,observePreview} from '../src/preview-metrics.ts';

test('preview counter measures 20 fps without claiming normal frame gaps are freezes',()=>{
 const m=previewMetrics();for(let i=0;i<=20;i++)m.observe(i*50,i);
 assert.deepEqual(m.snapshot(),{previewFps:20,previewLongGapMs:0});
});

test('preview long gaps count only the interval beyond 250ms and exclude visibility/paused gaps',()=>{
 const m=previewMetrics();m.observe(0,0);m.observe(50,1);m.observe(350,1);m.observe(550,2);
 assert.deepEqual(m.snapshot(),{previewFps:3.6,previewLongGapMs:250});
 m.observe(600,2,false);m.observe(10600,3);m.observe(10650,4);
 assert.deepEqual(m.snapshot(),{previewFps:5,previewLongGapMs:250});
 m.reset();assert.deepEqual(m.snapshot(),{previewFps:null,previewLongGapMs:null});
});

test('missing counters stay unknown and counter resets do not create huge frame rates',()=>{
 const m=previewMetrics();m.observe(0,null);m.observe(1000,null);assert.deepEqual(m.snapshot(),{previewFps:null,previewLongGapMs:null});
 m.observe(1100,900);m.observe(1200,2);m.observe(1250,3);assert.deepEqual(m.snapshot(),{previewFps:20,previewLongGapMs:0});
});

test('observer uses decoded counter fallback, excludes hidden periods and leaves unsupported values unknown',()=>{
 const originals={window:globalThis.window,document:globalThis.document,performance:globalThis.performance};let now=0,count=0;
 const document=new EventTarget();document.hidden=false;
 globalThis.document=document;globalThis.window={setInterval:()=>0};globalThis.performance={now:()=>now};
 try{
  const video=new EventTarget();Object.assign(video,{hidden:false,paused:false,ended:false,readyState:2,getVideoPlaybackQuality:()=>({totalVideoFrames:count})});
  const observer=observePreview(video);observer.reset();now=1000;count=20;assert.equal(observer.snapshot().previewFps,20);
  document.hidden=true;document.dispatchEvent(new Event('visibilitychange'));now=10000;count=200;document.hidden=false;document.dispatchEvent(new Event('visibilitychange'));now=10050;count=201;assert.equal(observer.snapshot().previewFps,20);
  observer.stop();observer.stop();
  delete video.getVideoPlaybackQuality;const unsupported=observePreview(video);unsupported.reset();now=11000;assert.deepEqual(unsupported.snapshot(),{previewFps:null,previewLongGapMs:null});unsupported.stop();
 }finally{for(const [key,value] of Object.entries(originals))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});

test('frame callback observer cancels callbacks and ignores callbacks arriving after stop',()=>{
 const originals={window:globalThis.window,document:globalThis.document,performance:globalThis.performance};let now=0,callback,cancelled=0;
 const document=new EventTarget();document.hidden=false;globalThis.document=document;globalThis.window={setInterval:()=>0};globalThis.performance={now:()=>now};
 try{
  const video=new EventTarget();Object.assign(video,{hidden:false,paused:false,ended:false,readyState:2,requestVideoFrameCallback:fn=>{callback=fn;return 9;},cancelVideoFrameCallback:id=>{cancelled=id;}});
  const observer=observePreview(video);callback(0,{presentedFrames:1});now=50;callback(50,{presentedFrames:2});assert.equal(observer.snapshot().previewFps,20);
  observer.stop();assert.equal(cancelled,9);const summary=observer.snapshot();now=1000;callback(1000,{presentedFrames:99});assert.deepEqual(observer.snapshot(),summary);
 }finally{for(const [key,value] of Object.entries(originals))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});

test('broken optional browser properties cannot fail camera startup or teardown',()=>{
 const originals={window:globalThis.window,document:globalThis.document,performance:globalThis.performance};let now=0,total=0,dropped=0;
 const document=new EventTarget();document.hidden=false;globalThis.document=document;globalThis.window={setInterval:()=>0};globalThis.performance={now:()=>now};
 try{
  const video=new EventTarget();Object.assign(video,{hidden:false,paused:false,ended:false,readyState:2});
  Object.defineProperties(video,{requestVideoFrameCallback:{get(){throw new Error('native bridge unavailable');}},getVideoPlaybackQuality:{get(){throw new Error('quality unavailable');}},webkitDecodedFrameCount:{configurable:true,get:()=>total},webkitDroppedFrameCount:{get:()=>dropped}});
  const observer=observePreview(video);observer.reset();now=1000;total=20;dropped=5;assert.equal(observer.snapshot().previewFps,15);
  Object.defineProperty(video,'webkitDecodedFrameCount',{get(){throw new Error('legacy unavailable');}});observer.reset();now=2000;assert.deepEqual(observer.snapshot(),{previewFps:null,previewLongGapMs:null});assert.doesNotThrow(()=>observer.stop());
 }finally{for(const [key,value] of Object.entries(originals))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});

test('standard playback counter excludes drops and records a stall only until progress resumes',()=>{
 const originals={window:globalThis.window,document:globalThis.document,performance:globalThis.performance};let now=0,total=0,dropped=0;
 const document=new EventTarget();document.hidden=false;globalThis.document=document;globalThis.window={setInterval:()=>0};globalThis.performance={now:()=>now};
 try{
  const video=new EventTarget();Object.assign(video,{hidden:false,paused:false,ended:false,readyState:2,getVideoPlaybackQuality:()=>({totalVideoFrames:total,droppedVideoFrames:dropped})});
  const observer=observePreview(video);observer.reset();now=500;total=dropped=10;assert.deepEqual(observer.snapshot(),{previewFps:0,previewLongGapMs:250});
  now=550;total=11;observer.snapshot();for(let i=1;i<=20;i++){now=550+i*50;total=11+i;observer.snapshot();}
  assert.deepEqual(observer.snapshot(),{previewFps:13.5,previewLongGapMs:300});observer.stop();
 }finally{for(const [key,value] of Object.entries(originals))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});

test('callback registration failure falls back with a fresh counter baseline and safe cancellation',()=>{
 const originals={window:globalThis.window,document:globalThis.document,performance:globalThis.performance};let now=0,total=90,callback,calls=0;
 const document=new EventTarget();document.hidden=false;globalThis.document=document;globalThis.window={setInterval:()=>0};globalThis.performance={now:()=>now};
 try{
  const video=new EventTarget();Object.assign(video,{hidden:false,paused:false,ended:false,readyState:2,getVideoPlaybackQuality:()=>({totalVideoFrames:total,droppedVideoFrames:0}),requestVideoFrameCallback:fn=>{if(++calls>2)throw new Error('callback unavailable');callback=fn;return 7;},cancelVideoFrameCallback:()=>{throw new Error('native cancel unavailable');}});
  const observer=observePreview(video);callback(0,{presentedFrames:1});now=50;callback(50,{presentedFrames:2});now=100;total=92;observer.snapshot();now=150;total=93;
  assert.equal(observer.snapshot().previewFps,20);assert.doesNotThrow(()=>observer.stop());
 }finally{for(const [key,value] of Object.entries(originals))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});
