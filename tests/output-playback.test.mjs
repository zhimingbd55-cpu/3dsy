import test from 'node:test';
import assert from 'node:assert/strict';
import {watchOutputPlayback} from '../src/output-playback.ts';

function setup(t,{callbacks=true,quality=false,initialProgress=false}={}){
 let time=0,active=true,visible=true,frame=0,pending,failed=false;
 const track={id:'unchanged-result-track'},stream={getTracks:()=>[track]},changes=[];
 const video={srcObject:stream,paused:false,ended:false,plays:0,pauses:0,
  play(){this.plays++;if(failed)return Promise.reject(new Error('NotAllowedError'));this.paused=false;return Promise.resolve();},
  pause(){this.pauses++;this.paused=true;},
 };
 if(callbacks){video.requestVideoFrameCallback=fn=>{pending=fn;return 1;};video.cancelVideoFrameCallback=()=>{pending=null;};}
 if(quality)video.getVideoPlaybackQuality=()=>({totalVideoFrames:frame,droppedVideoFrames:0});
 const guard=watchOutputPlayback(video,{active:()=>active,visible:()=>visible,now:()=>time,intervalMs:1e8,initialProgress,changed:(state,gesture)=>changes.push({state,gesture})});
 t.after(()=>guard.stop());
 return {guard,video,stream,track,changes,setActive:v=>active=v,setVisible:v=>visible=v,fail:v=>failed=v,
  tick(ms){time+=ms;guard.check();},frame(ms=50){time+=ms;frame++;const cb=pending;pending=null;cb?.(time,{presentedFrames:frame,mediaTime:frame/20});guard.check();},
  pending:()=>pending};
}

test('normal and low frame rate progress never restarts playback',t=>{
 const h=setup(t);for(let i=0;i<50;i++)h.frame(50);for(let i=0;i<30;i++)h.frame(167);
 assert.equal(h.video.plays,0);assert.equal(h.guard.snapshot().outputStallCount,0);
});
test('missing incoming frames reports a stall and waits without reopening or replaying',t=>{
 const h=setup(t);h.frame();h.tick(2100);
 assert.deepEqual(h.changes.at(-1),{state:'waiting',gesture:false});h.tick(7000);
 assert.equal(h.video.plays,0);assert.equal(h.guard.snapshot().outputStallCount,1);
 h.frame();assert.equal(h.guard.snapshot().outputStallCount,1);assert.equal(h.guard.snapshot().playbackRecoveries,0);
 assert.ok(h.guard.snapshot().outputStallMs>=8850);assert.equal(h.changes.at(-1).state,'flowing');
});
test('paused presentation resumes the existing stream and requires a new frame to count recovery',async t=>{
 const h=setup(t);h.frame();h.video.pause();h.tick(250);await Promise.resolve();
 assert.equal(h.video.plays,1);assert.equal(h.video.srcObject,h.stream);assert.equal(h.video.srcObject.getTracks()[0],h.track);
 assert.equal(h.guard.snapshot().playbackRecoveries,0);h.frame();assert.equal(h.guard.snapshot().playbackRecoveries,1);
});
test('fresh incoming stats can trigger at most two bounded presentation attempts',async t=>{
 const h=setup(t);h.frame();h.guard.receiveFps(20);h.tick(2200);assert.equal(h.video.plays,0,'stale stats cannot trigger replay');
 h.guard.receiveFps(20);h.tick(250);await Promise.resolve();assert.equal(h.video.plays,1);
 h.tick(250);await Promise.resolve();assert.equal(h.video.plays,1,'cooldown prevents rapid attempts');
 h.guard.receiveFps(20);h.tick(1500);await Promise.resolve();assert.equal(h.video.plays,2);
 h.guard.receiveFps(20);h.tick(1500);await Promise.resolve();assert.equal(h.video.plays,2);
 assert.equal(h.video.srcObject,h.stream);assert.equal(h.guard.snapshot().playbackRecoveries,0);
 h.frame();assert.equal(h.guard.snapshot().playbackRecoveries,1);
});
test('autoplay rejection exposes manual recovery without claiming successful frames',async t=>{
 const h=setup(t);h.frame();h.fail(true);h.video.pause();h.tick(250);await Promise.resolve();await Promise.resolve();
 assert.deepEqual(h.changes.at(-1),{state:'paused',gesture:true});h.tick(2500);assert.equal(h.video.plays,1);
 h.fail(false);await h.guard.resumeFromGesture();assert.equal(h.video.plays,2);assert.equal(h.guard.snapshot().playbackRecoveries,0);
 h.frame();assert.equal(h.guard.snapshot().playbackRecoveries,1);assert.equal(h.changes.at(-1).gesture,false);
});
test('a newer zero or unknown receive sample revokes permission for a renderer restart',t=>{
 const h=setup(t);h.frame();h.tick(2100);
 for(const value of [0,null,undefined,NaN]){h.guard.receiveFps(20);h.guard.receiveFps(value);h.tick(250);}
 assert.equal(h.video.plays,0);assert.equal(h.changes.at(-1).state,'waiting');
});
test('exhausted automatic attempts still expose a working manual resume button',async t=>{
 const h=setup(t);h.frame();h.video.pause();h.tick(250);await Promise.resolve();h.frame();
 h.video.pause();h.tick(1600);await Promise.resolve();h.frame();
 h.video.pause();h.tick(1600);await Promise.resolve();
 assert.equal(h.video.plays,2);assert.deepEqual(h.changes.at(-1),{state:'paused',gesture:true});
 await h.guard.resumeFromGesture();h.frame();assert.equal(h.video.plays,3);assert.equal(h.guard.snapshot().playbackRecoveries,3);
});
test('unknown frame capability stays unknown instead of reporting false zero or freezes',t=>{
 const h=setup(t,{callbacks:false});h.tick(10000);
 assert.equal(h.guard.snapshot().outputStallMs,null);assert.equal(h.guard.snapshot().outputStallCount,null);assert.equal(h.video.plays,0);
});
test('decoded frame counter fallback detects progress and a subsequent real gap',t=>{
 const h=setup(t,{callbacks:false,quality:true});h.tick(250);h.frame();h.tick(2200);
 assert.equal(h.guard.snapshot().outputStallCount,1);h.frame();assert.equal(h.changes.at(-1).state,'flowing');
});
test('hidden, ended, cancelled and late frame callbacks never restart playback',async t=>{
 const h=setup(t);h.frame();h.setVisible(false);h.video.pause();h.tick(10000);await h.guard.resumeFromGesture();assert.equal(h.video.plays,0);
 h.setVisible(true);h.video.ended=true;h.tick(250);assert.equal(h.video.plays,0);
 h.video.ended=false;h.setActive(false);h.tick(250);assert.equal(h.video.plays,0);
 const late=h.pending();h.guard.stop();h.setActive(true);late?.(12000,{presentedFrames:2});await h.guard.resumeFromGesture();
 assert.equal(h.video.plays,0);assert.equal(h.guard.snapshot().outputStallCount,0);
});
