import {VIDEO_PROFILE} from './video-profile.ts';
import type {PreviewDiagnostics} from './preview-metrics.ts';
export type CameraDiagnostics={actualCameraWidth:number|null;actualCameraHeight:number|null;actualCameraFps:number|null;cameraConstraintResult:'matched'|'adjusted'|'fallback'|'unknown'};
export type PlaybackDiagnostics={outputStallMs:number|null;outputStallCount:number|null;playbackRecoveryAttempts:number|null;playbackRecoveries:number|null};
type Candidate={candidateType?:string};
type Sample={
  video?:{framesPerSecond?:number|null;framesDroppedDelta?:number;freezeDurationDelta?:number;avgDecodeTimeMs?:number|null;packetsLostDelta?:number;bitrate?:number}|null;
  outboundVideo?:{framesPerSecond?:number|null;qualityLimitationReason?:string;bitrate?:number;targetBitrateKbps?:number|null;avgPacketSendDelayMs?:number|null}|null;
  connection?:{currentRoundTripTime?:number|null;availableOutgoingBitrate?:number|null;selectedCandidatePairs?:{local?:Candidate;remote?:Candidate}[]};
  remoteInbound?:{fractionLost?:number|null}|null;
};
const valid=(value:unknown,max:number):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max;
const average=(values:number[],precision=1)=>{const scale=10**precision;return values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length*scale)/scale:null;};
const p95=(values:number[])=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return Math.round(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]*10)/10;};
export function streamMetrics(){
  let camera:CameraDiagnostics={actualCameraWidth:null,actualCameraHeight:null,actualCameraFps:null,cameraConstraintResult:'unknown'},preview:PreviewDiagnostics={previewFps:null,previewLongGapMs:null};
  let playback:PlaybackDiagnostics={outputStallMs:null,outputStallCount:null,playbackRecoveryAttempts:null,playbackRecoveries:null};
  function setCameraDiagnostics(value:CameraDiagnostics){camera={actualCameraWidth:valid(value.actualCameraWidth,4096)?value.actualCameraWidth:null,actualCameraHeight:valid(value.actualCameraHeight,4096)?value.actualCameraHeight:null,actualCameraFps:valid(value.actualCameraFps,120)?value.actualCameraFps:null,cameraConstraintResult:['matched','adjusted','fallback','unknown'].includes(value.cameraConstraintResult)?value.cameraConstraintResult:'unknown'};}
  function setPreviewDiagnostics(value:PreviewDiagnostics){preview={previewFps:valid(value.previewFps,120)?value.previewFps:null,previewLongGapMs:valid(value.previewLongGapMs,600000)?value.previewLongGapMs:null};}
  function setPlaybackDiagnostics(value:PlaybackDiagnostics){playback={outputStallMs:valid(value.outputStallMs,600000)?value.outputStallMs:null,outputStallCount:valid(value.outputStallCount,120)?value.outputStallCount:null,playbackRecoveryAttempts:valid(value.playbackRecoveryAttempts,120)?value.playbackRecoveryAttempts:null,playbackRecoveries:valid(value.playbackRecoveries,120)?value.playbackRecoveries:null};}
  const totals={sentFps:[] as number[],receivedFps:[] as number[],rttMs:[] as number[],sendBitrateBps:[] as number[],receiveBitrateBps:[] as number[],availableOutgoingBps:[] as number[],decodeMs:[] as number[],sendQueueDelayMs:[] as number[],lossFraction:[] as number[],glassToGlassMs:[] as number[],cameraFps:[] as number[],presentedFps:[] as number[],paintMs:[] as number[]};
  const windows:{sentFps:number|null;reason:string;sendQueueDelayMs:number|null;cameraFps:number|null;presentedFps:number|null;paintP95Ms:number|null;longTaskMsPerSecond:number|null}[]=[];
  let samples=0,droppedFrames=0,freezeMs=0,cpu=0,bandwidth=0,relayPathSamples=0,directPathSamples=0,presentedDrops=0;
  let active=false,lastWindow:number|null=null,paintCount=0,paintCosts:number[]=[],presentedFrameTotal=0,lastPresentedFrames:number|null=null,longTaskMs=0,fluidReason:string|null=null,senderParametersApplied:boolean|null=null;
  let paintObserved=false,presentedObserved=false,dropsObserved=false,freezeObserved=false,presentedCounterObserved=false;
  let finalProfile:'smooth'|'reduced'|'draw-only'='smooth',actualSendWidth:number|null=null,actualSendHeight:number|null=null,actualSimulcastLayers:number|null=null,targetSendBitrateBps:number|null=null;
  function beginCapture(){active=true;lastWindow=performance.now();paintCount=0;paintCosts=[];presentedFrameTotal=0;lastPresentedFrames=null;paintObserved=presentedObserved=dropsObserved=freezeObserved=presentedCounterObserved=false;playback={outputStallMs:null,outputStallCount:null,playbackRecoveryAttempts:null,playbackRecoveries:null};longTaskMs=0;windows.length=0;for(const values of Object.values(totals))values.length=0;droppedFrames=freezeMs=cpu=bandwidth=relayPathSamples=directPathSamples=presentedDrops=0;samples=0;}
  function recordPaint(_time:number,duration:number){if(!active)return;paintObserved=true;paintCount++;if(valid(duration,1000)){paintCosts.push(duration);totals.paintMs.push(duration);}}
  function recordPresented(now:number,metadata?:VideoFrameCallbackMetadata){
    if(!active)return;
    presentedObserved=true;
    if(metadata&&valid(metadata.presentedFrames,1e9)){
      presentedCounterObserved=true;
      const count=Math.round(metadata.presentedFrames);
      if(lastPresentedFrames!==null&&count>=lastPresentedFrames){presentedDrops+=Math.max(0,count-lastPresentedFrames-1);presentedFrameTotal+=count-lastPresentedFrames;}
      else presentedFrameTotal++;
      lastPresentedFrames=count;
    }else presentedFrameTotal++;
    const captureTime=(metadata as VideoFrameCallbackMetadata&{captureTime?:number}|undefined)?.captureTime;
    if(valid(captureTime,1e9)){const latency=now-captureTime;if(valid(latency,120000))totals.glassToGlassMs.push(latency);}
  }
  function recordLongTask(duration:number){if(active&&valid(duration,60000))longTaskMs+=duration;}
  function sample(value:Sample){
    if(samples>=300||(!value.video&&!value.outboundVideo))return;
    const now=performance.now(),elapsed=lastWindow!==null?Math.max(.25,(now-lastWindow)/1000):1;
    const cameraFps=active&&paintObserved?paintCount/elapsed:null,presentedFps=active&&presentedObserved?presentedFrameTotal/elapsed:null,paintP95Ms=p95(paintCosts),longTaskMsPerSecond=active?longTaskMs/elapsed:null;
    const sendFps=valid(value.outboundVideo?.framesPerSecond,120)?value.outboundVideo!.framesPerSecond!:null;
    const queueDelay=valid(value.outboundVideo?.avgPacketSendDelayMs,120000)?value.outboundVideo!.avgPacketSendDelayMs!:null;
    const reason=typeof value.outboundVideo?.qualityLimitationReason==='string'?value.outboundVideo.qualityLimitationReason:'unknown';
    samples++;
    if(cameraFps!==null)totals.cameraFps.push(cameraFps);
    if(presentedFps!==null)totals.presentedFps.push(presentedFps);
    if(sendFps!==null)totals.sentFps.push(sendFps);
    if(valid(value.video?.framesPerSecond,120))totals.receivedFps.push(value.video!.framesPerSecond!);
    if(valid(value.connection?.currentRoundTripTime,120))totals.rttMs.push(value.connection!.currentRoundTripTime!*1000);
    if(valid(value.outboundVideo?.bitrate,100_000_000))totals.sendBitrateBps.push(value.outboundVideo!.bitrate!);
    if(valid(value.video?.bitrate,100_000_000))totals.receiveBitrateBps.push(value.video!.bitrate!);
    if(valid(value.connection?.availableOutgoingBitrate,100_000_000))totals.availableOutgoingBps.push(value.connection!.availableOutgoingBitrate!);
    if(valid(value.video?.avgDecodeTimeMs,120000))totals.decodeMs.push(value.video!.avgDecodeTimeMs!);
    if(queueDelay!==null)totals.sendQueueDelayMs.push(queueDelay);
    if(valid(value.remoteInbound?.fractionLost,1))totals.lossFraction.push(value.remoteInbound!.fractionLost!);
    const drops=value.video?.framesDroppedDelta;if(valid(drops,10000)){dropsObserved=true;droppedFrames+=drops;}
    const freezes=value.video?.freezeDurationDelta;if(valid(freezes,60)){freezeObserved=true;freezeMs+=freezes*1000;}
    if(reason==='cpu')cpu++;if(reason==='bandwidth')bandwidth++;
    // LiveKit can report separate publish/subscribe transports, plus duplicate
    // candidate entries. These counters count samples, never transport pairs.
    let hasRelay=false,hasDirect=false;
    const directTypes=['host','srflx','prflx'];
    for(const pair of value.connection?.selectedCandidatePairs||[]){
      const local=pair.local?.candidateType,remote=pair.remote?.candidateType;
      if(local==='relay'||remote==='relay')hasRelay=true;
      else if(local&&remote&&directTypes.includes(local)&&directTypes.includes(remote))hasDirect=true;
    }
    if(hasRelay)relayPathSamples++;if(hasDirect)directPathSamples++;
    windows.push({sentFps:sendFps,reason,sendQueueDelayMs:queueDelay,cameraFps,presentedFps,paintP95Ms,longTaskMsPerSecond});if(windows.length>10)windows.shift();
    lastWindow=now;paintCount=0;paintCosts=[];presentedFrameTotal=0;longTaskMs=0;
  }
  function pressure(){
    if(windows.length<5)return null;
    const recent=windows.slice(-5),slowSend=recent.filter(x=>x.sentFps!==null&&x.sentFps<16).length,cpuLimits=recent.filter(x=>x.reason==='cpu').length,bandwidthLimits=recent.filter(x=>x.reason==='bandwidth').length,queued=recent.filter(x=>x.sendQueueDelayMs!==null&&x.sendQueueDelayMs>100).length;
    if(cpuLimits>=4&&slowSend>=3)return 'cpu';
    if(bandwidthLimits>=4&&(slowSend>=3||queued>=4))return 'upstream';
    const paint=recent.filter(x=>x.cameraFps!==null&&x.cameraFps<15&&x.paintP95Ms!==null&&x.paintP95Ms>25).length;
    const longTasks=recent.filter(x=>x.longTaskMsPerSecond!==null&&x.longTaskMsPerSecond>100).length;
    if(paint>=4||longTasks>=4)return 'device';
    return null;
  }
  function setInitialProfile(profile:{width:number|null;height:number|null;layers:number|null;targetBitrateBps:number|null}|null){
    finalProfile='smooth';actualSendWidth=profile?.width??null;actualSendHeight=profile?.height??null;actualSimulcastLayers=profile?.layers??null;targetSendBitrateBps=profile?.targetBitrateBps??null;
  }
  function markReduced(reason:string,applied:boolean,profile:{width:number|null;height:number|null;layers:number|null;targetBitrateBps:number|null}|null){
    fluidReason=reason;senderParametersApplied=applied;finalProfile=applied?'reduced':'draw-only';
    if(profile){actualSendWidth=profile.width;actualSendHeight=profile.height;actualSimulcastLayers=profile.layers;targetSendBitrateBps=profile.targetBitrateBps;}
  }
  function summary(){
    if(!samples)return null;
    return {samples,sentFps:average(totals.sentFps),receivedFps:average(totals.receivedFps),rttMs:average(totals.rttMs),droppedFrames:dropsObserved?Math.round(droppedFrames):null,cpuLimitedSamples:cpu,bandwidthLimitedSamples:bandwidth,
      sendBitrateBps:average(totals.sendBitrateBps),receiveBitrateBps:average(totals.receiveBitrateBps),availableOutgoingBps:average(totals.availableOutgoingBps),freezeMs:freezeObserved?Math.round(freezeMs):null,decodeMs:average(totals.decodeMs),sendQueueDelayMs:average(totals.sendQueueDelayMs),lossFraction:average(totals.lossFraction,4),
      cameraFps:average(totals.cameraFps),presentedFps:average(totals.presentedFps),paintP95Ms:p95(totals.paintMs),presentedDrops:presentedCounterObserved?presentedDrops:null,glassToGlassMs:average(totals.glassToGlassMs),relayPathSamples,directPathSamples,
      qualityMode:finalProfile==='smooth'?'smooth':'reduced',fluidReason,senderParametersApplied,configVersion:VIDEO_PROFILE.version,initialProfile:'smooth',finalProfile,actualSendWidth,actualSendHeight,actualSimulcastLayers,targetSendBitrateBps,...camera,...preview,...playback};
  }
  return {beginCapture,endCapture:()=>{active=false;},recordPaint,recordPresented,recordLongTask,sample,pressure,setInitialProfile,markReduced,setCameraDiagnostics,setPreviewDiagnostics,setPlaybackDiagnostics,summary};
}
