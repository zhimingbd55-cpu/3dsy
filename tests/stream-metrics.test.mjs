import test from 'node:test';
import assert from 'node:assert/strict';
import {streamMetrics} from '../src/stream-metrics.ts';

test('capture reset retains measured camera and pre-try-on preview diagnostics',()=>{
 const m=streamMetrics();
 m.setCameraDiagnostics({actualCameraWidth:480,actualCameraHeight:640,actualCameraFps:20,cameraConstraintResult:'adjusted'});
 m.setPreviewDiagnostics({previewFps:19.8,previewLongGapMs:120});
 m.beginCapture();m.sample({outboundVideo:{framesPerSecond:20}});
 const summary=m.summary();assert.equal(summary.configVersion,'smooth-v2');assert.equal(summary.actualCameraWidth,480);assert.equal(summary.actualCameraHeight,640);assert.equal(summary.actualCameraFps,20);assert.equal(summary.cameraConstraintResult,'adjusted');assert.equal(summary.previewFps,19.8);assert.equal(summary.previewLongGapMs,120);
});

test('unobserved preview and camera statistics stay unknown',()=>{
 const m=streamMetrics();m.beginCapture();m.sample({video:{framesPerSecond:20}});
 const summary=m.summary();assert.equal(summary.actualCameraWidth,null);assert.equal(summary.actualCameraFps,null);assert.equal(summary.cameraConstraintResult,'unknown');assert.equal(summary.previewFps,null);assert.equal(summary.previewLongGapMs,null);assert.equal(summary.cameraFps,null);assert.equal(summary.presentedFps,null);
});

test('path counters count samples across duplicate and independent peer transports, including remote relays',()=>{
 const m=streamMetrics();m.beginCapture();
 const direct={local:{candidateType:'host',address:'private-local'},remote:{candidateType:'srflx',address:'private-remote'}};
 const remoteRelay={local:{candidateType:'host'},remote:{candidateType:'relay'}};
 const localRelay={local:{candidateType:'relay'},remote:{candidateType:'host'}};
 m.sample({video:{},connection:{selectedCandidatePairs:[direct,direct,{local:{candidateType:'prflx'},remote:{candidateType:'host'}}]}});
 assert.equal(m.summary().directPathSamples,1);assert.equal(m.summary().relayPathSamples,0);
 m.sample({video:{},connection:{selectedCandidatePairs:[remoteRelay,remoteRelay,localRelay]}});
 assert.equal(m.summary().directPathSamples,1);assert.equal(m.summary().relayPathSamples,1);
 m.sample({video:{},connection:{selectedCandidatePairs:[direct,direct,remoteRelay,localRelay]}});
 let summary=m.summary();assert.equal(summary.samples,3);assert.equal(summary.directPathSamples,2);assert.equal(summary.relayPathSamples,2);
 m.sample({video:{},connection:{selectedCandidatePairs:[{local:{candidateType:'host'}},{remote:{candidateType:'srflx'}},{local:{candidateType:'unknown'},remote:{candidateType:'host'}}]}});
 summary=m.summary();assert.equal(summary.samples,4);assert.equal(summary.directPathSamples,2);assert.equal(summary.relayPathSamples,2);assert.ok(!JSON.stringify(summary).includes('private-'));
});

test('missing frame observers stay unknown while zero FPS remains valid for observed stalled sources',()=>{
 const m=streamMetrics();m.beginCapture();
 m.sample({video:{},outboundVideo:{framesPerSecond:null}});
 let summary=m.summary();assert.equal(summary.sentFps,null);assert.equal(summary.receivedFps,null);assert.equal(summary.cameraFps,null);assert.equal(summary.presentedFps,null);
 m.recordPaint(1,2);m.recordPresented(1,{presentedFrames:1});
 m.sample({video:{framesPerSecond:0},outboundVideo:{framesPerSecond:0}});
 const firstFps=m.summary().cameraFps,firstPresentedFps=m.summary().presentedFps;assert.ok(firstFps>0);assert.ok(firstPresentedFps>0);
 for(let i=0;i<10;i++)m.sample({video:{framesPerSecond:0},outboundVideo:{framesPerSecond:0}});
 summary=m.summary();assert.equal(summary.sentFps,0);assert.equal(summary.receivedFps,0);assert.equal(summary.cameraFps,Math.round(firstFps/11*10)/10);assert.equal(summary.presentedFps,Math.round(firstPresentedFps/11*10)/10);
 m.beginCapture();m.sample({video:{framesPerSecond:NaN},outboundVideo:{}});
 summary=m.summary();assert.equal(summary.sentFps,null);assert.equal(summary.receivedFps,null);assert.equal(summary.cameraFps,null);assert.equal(summary.presentedFps,null);
});

test('long sample gaps use the actual elapsed time instead of capping a stall at three seconds',t=>{
 let now=0;t.mock.method(performance,'now',()=>now);
 const m=streamMetrics();m.beginCapture();
 for(let i=0;i<20;i++){m.recordPaint(i,2);m.recordPresented(i,{presentedFrames:i+1});}
 now=10000;m.sample({video:{framesPerSecond:2},outboundVideo:{framesPerSecond:2}});
 const summary=m.summary();assert.equal(summary.cameraFps,2);assert.equal(summary.presentedFps,2);
});

test('draw and presentation summaries include all samples while pressure uses only the recent window',t=>{
 let now=0,frame=0;t.mock.method(performance,'now',()=>now);
 const m=streamMetrics();m.beginCapture();
 for(let second=0;second<15;second++){
  for(let n=0;n<(second<5?10:20);n++){m.recordPaint(now,second<5?40:2);m.recordPresented(now,{presentedFrames:++frame});}
  now+=1000;m.sample({outboundVideo:{framesPerSecond:20,qualityLimitationReason:'none'}});
 }
 const summary=m.summary();assert.equal(summary.samples,15);assert.equal(summary.cameraFps,16.7);assert.equal(summary.presentedFps,16.7);assert.equal(summary.paintP95Ms,40);assert.equal(m.pressure(),null);
});

test('missing drop and freeze capabilities stay unknown and genuine zero measurements are retained',()=>{
 const m=streamMetrics();m.beginCapture();m.recordPresented(1);m.sample({video:{}});
 let summary=m.summary();assert.equal(summary.droppedFrames,null);assert.equal(summary.freezeMs,null);assert.equal(summary.presentedDrops,null);
 m.recordPresented(2,{presentedFrames:1});m.sample({video:{framesDroppedDelta:0,freezeDurationDelta:0}});
 summary=m.summary();assert.equal(summary.droppedFrames,0);assert.equal(summary.freezeMs,0);assert.equal(summary.presentedDrops,0);
 m.recordPresented(3,{presentedFrames:4});m.sample({video:{framesDroppedDelta:2,freezeDurationDelta:.5}});
 summary=m.summary();assert.equal(summary.droppedFrames,2);assert.equal(summary.freezeMs,500);assert.equal(summary.presentedDrops,2);
 m.beginCapture();m.sample({video:{}});summary=m.summary();assert.equal(summary.droppedFrames,null);assert.equal(summary.freezeMs,null);assert.equal(summary.presentedDrops,null);
});

test('small packet-loss fractions retain four decimal places instead of becoming zero',()=>{
 const m=streamMetrics();m.beginCapture();
 for(const fractionLost of [.01,.02,.0102])m.sample({video:{},remoteInbound:{fractionLost}});
 assert.equal(m.summary().lossFraction,.0134);
});

test('output playback observations remain unknown until supplied, stay bounded, and reset per capture',()=>{
 const m=streamMetrics();m.beginCapture();m.sample({video:{framesPerSecond:8}});
 const keys=['outputStallMs','outputStallCount','playbackRecoveryAttempts','playbackRecoveries'];
 for(const key of keys)assert.equal(m.summary()[key],null);
 const observed={outputStallMs:14321.5,outputStallCount:2,playbackRecoveryAttempts:2,playbackRecoveries:1};
 m.setPlaybackDiagnostics(observed);for(const [key,value] of Object.entries(observed))assert.equal(m.summary()[key],value);
 m.setPlaybackDiagnostics({outputStallMs:600001,outputStallCount:-1,playbackRecoveryAttempts:121,playbackRecoveries:NaN});
 for(const key of keys)assert.equal(m.summary()[key],null);
 m.setPlaybackDiagnostics({outputStallMs:0,outputStallCount:0,playbackRecoveryAttempts:0,playbackRecoveries:0});
 for(const key of keys)assert.equal(m.summary()[key],0);
 m.beginCapture();m.sample({video:{}});for(const key of keys)assert.equal(m.summary()[key],null);
});

test('stream diagnostics aggregate bounded numeric timing and classify relay paths without storing addresses',()=>{
 const m=streamMetrics();assert.equal(m.summary(),null);m.beginCapture();
 m.recordPaint(100,3);m.recordPresented(110,{presentedFrames:1,captureTime:50});
 m.sample({video:{framesPerSecond:20,framesDroppedDelta:1,freezeDurationDelta:.2,avgDecodeTimeMs:8,bitrate:300000,packetsLostDelta:2},outboundVideo:{framesPerSecond:24,qualityLimitationReason:'cpu',bitrate:500000,avgPacketSendDelayMs:15},connection:{currentRoundTripTime:.1,availableOutgoingBitrate:1000000,selectedCandidatePairs:[{local:{candidateType:'relay',address:'private-address'},remote:{candidateType:'srflx',address:'other-private-address'}}]},remoteInbound:{fractionLost:.01}});
 m.sample({video:{framesPerSecond:24,framesDroppedDelta:2},outboundVideo:{framesPerSecond:24,qualityLimitationReason:'bandwidth'},connection:{currentRoundTripTime:.3}});
 const summary=m.summary();assert.equal(summary.samples,2);assert.equal(summary.sentFps,24);assert.equal(summary.receivedFps,22);assert.equal(summary.rttMs,200);assert.equal(summary.droppedFrames,3);assert.equal(summary.cpuLimitedSamples,1);assert.equal(summary.bandwidthLimitedSamples,1);assert.equal(summary.freezeMs,200);assert.equal(summary.relayPathSamples,1);assert.equal(summary.glassToGlassMs,60);assert.ok(!JSON.stringify(summary).includes('private-address'));
});

test('missing SDK FPS stays unknown and is derived only from decoded or encoded frame counters',()=>{
 const m=streamMetrics();m.beginCapture();
 for(let i=0;i<500;i++)m.sample({video:{framesPerSecond:NaN},outboundVideo:{framesPerSecond:null,qualityLimitationReason:'unknown'},connection:{currentRoundTripTime:null}});
 const summary=m.summary();assert.equal(summary.samples,300);assert.equal(summary.receivedFps,null);assert.equal(summary.sentFps,null);assert.equal(summary.rttMs,null);
});

test('long rotations retain samples after 120 while preserving the 300-sample bound',()=>{
 const m=streamMetrics();m.beginCapture();
 for(let i=0;i<350;i++)m.sample({outboundVideo:{framesPerSecond:i<120?20:10,qualityLimitationReason:'cpu'}});
 const summary=m.summary();assert.equal(summary.samples,300);assert.equal(summary.cpuLimitedSamples,300);assert.equal(summary.sentFps,14);
});

test('low received FPS alone never changes the default smooth profile',()=>{
 const m=streamMetrics();m.beginCapture();
 for(let i=0;i<5;i++)m.sample({video:{framesPerSecond:6},outboundVideo:{framesPerSecond:24,qualityLimitationReason:'none'}});
 assert.equal(m.pressure(),null);
});

test('persistent encoder pressure selects one reduced profile only after five slow-send samples',()=>{
 const m=streamMetrics();m.beginCapture();
 for(let i=0;i<5;i++)m.sample({video:{framesPerSecond:24},outboundVideo:{framesPerSecond:15,qualityLimitationReason:'cpu'}});
 assert.equal(m.pressure(),'cpu');m.markReduced('cpu',false,{width:540,height:960,layers:2,targetBitrateBps:1350000});
 const summary=m.summary();assert.equal(summary.qualityMode,'reduced');assert.equal(summary.finalProfile,'draw-only');assert.equal(summary.senderParametersApplied,false);assert.equal(summary.actualSendWidth,540);assert.equal(summary.actualSimulcastLayers,2);
});

test('ordinary 18 fps jitter, missing samples, and high receive latency do not cause an extra downgrade',()=>{
 const m=streamMetrics();m.beginCapture();
 for(let i=0;i<5;i++)m.sample({video:{framesPerSecond:6},outboundVideo:{framesPerSecond:i===0?18:20,qualityLimitationReason:'none'},connection:{currentRoundTripTime:1.2}});
 assert.equal(m.pressure(),null);
});

test('sustained device paint pressure is recognized while incomplete paint samples remain unknown',()=>{
 const m=streamMetrics();m.beginCapture();
 for(let i=0;i<5;i++){m.recordPaint(i,31);m.sample({outboundVideo:{framesPerSecond:null,qualityLimitationReason:'unknown'}});}
 assert.equal(m.pressure(),'device');
});
