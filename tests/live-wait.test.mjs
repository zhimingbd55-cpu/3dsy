import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForStableVideo} from '../src/live-wait.ts';

test('the 2-second video-frame stability gate counts only frames observed after it starts',async()=>{
  const previous=globalThis.window;globalThis.window={setTimeout,clearTimeout};
  let nextId=0,frames=0;const timers=new Map();
  const video={readyState:2,videoWidth:360,videoHeight:640,srcObject:{},paused:false,
    requestVideoFrameCallback(callback){const id=++nextId;const timer=setTimeout(()=>{timers.delete(id);frames++;callback(performance.now(),{presentedFrames:frames,mediaTime:frames/20});},45);timers.set(id,timer);return id;},
    cancelVideoFrameCallback(id){clearTimeout(timers.get(id));timers.delete(id);}};
  try{const started=performance.now(),result=await waitForStableVideo(video,new AbortController().signal);assert.equal(result.stabilityMode,'video-frame-callback');assert.ok(result.stableFrames>=3);assert.ok(result.stableWindowMs>=2000);assert.ok(performance.now()-started>=2000);}finally{for(const timer of timers.values())clearTimeout(timer);globalThis.window=previous;}
});

test('stale frames restart the stability window instead of being carried forward',async()=>{
  const previous=globalThis.window;globalThis.window={setTimeout,clearTimeout};
  let nextId=0,frames=0;const timers=new Map();
  const video={readyState:2,videoWidth:360,videoHeight:640,srcObject:{},paused:false,
    requestVideoFrameCallback(callback){const id=++nextId;const pause=frames>=4&&frames<5?1250:45;const timer=setTimeout(()=>{timers.delete(id);frames++;callback(performance.now(),{presentedFrames:frames,mediaTime:frames/20});},pause);timers.set(id,timer);return id;},
    cancelVideoFrameCallback(id){clearTimeout(timers.get(id));timers.delete(id);}};
  try{const started=performance.now(),result=await waitForStableVideo(video,new AbortController().signal);assert.ok(result.stableWindowMs>=2000);assert.ok(performance.now()-started>=3000);}finally{for(const timer of timers.values())clearTimeout(timer);globalThis.window=previous;}
});
