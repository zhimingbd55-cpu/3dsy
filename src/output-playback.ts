export type PlaybackDiagnostics={outputStallMs:number|null;outputStallCount:number|null;playbackRecoveryAttempts:number;playbackRecoveries:number};
export type PlaybackState='flowing'|'waiting'|'paused';

// Restart only presentation, never the RTC connection or a MediaStreamTrack.
// Missing incoming frames cannot be repaired by reopening a paid session.
export function watchOutputPlayback(video:HTMLVideoElement,options:{
  active:()=>boolean;visible?:()=>boolean;now?:()=>number;
  changed:(state:PlaybackState,needsGesture:boolean)=>void;
  intervalMs?:number;initialProgress?:boolean;
}){
  const now=options.now??(()=>performance.now()),visible=options.visible??(()=>!document.hidden);
  let stopped=false,callback=0,callbackCount:number|null=null,previous:number|null=null;
  let lastFrameAt=now(),observed=options.initialProgress??false,stallStart:number|null=null,stallMs=0,stallCount=0;
  let attempts=0,recoveries=0,recoveryPending=false,busy=false,lastAttempt=-Infinity;
  let receivingAt=-Infinity,requestFrames=typeof video.requestVideoFrameCallback==='function';
  let state:PlaybackState='flowing',needsGesture=false;
  const running=()=>!stopped&&options.active()&&visible();
  function emit(next:PlaybackState,gesture=false){if(state===next&&needsGesture===gesture)return;state=next;needsGesture=gesture;options.changed(next,gesture);}
  function closeStall(time:number){if(stallStart!==null){stallMs+=Math.max(0,time-stallStart);stallStart=null;}}
  function progress(time:number){
    observed=true;lastFrameAt=time;closeStall(time);
    if(recoveryPending){recoveries++;recoveryPending=false;}
    emit('flowing');
  }
  function decoded(){
    try{const q=video.getVideoPlaybackQuality?.();if(Number.isFinite(q?.totalVideoFrames))return Math.max(0,q.totalVideoFrames-(q.droppedVideoFrames||0));}catch{}
    const value=(video as HTMLVideoElement&{webkitDecodedFrameCount?:number}).webkitDecodedFrameCount;
    return typeof value==='number'&&Number.isFinite(value)?value:null;
  }
  function next(){
    if(!requestFrames||stopped)return;
    try{callback=video.requestVideoFrameCallback((_time,metadata)=>{
      if(stopped)return;
      const count=Number.isFinite(metadata.presentedFrames)?metadata.presentedFrames:metadata.mediaTime;
      if(running()&&Number.isFinite(count)&&count!==callbackCount)progress(now());
      callbackCount=count;next();
    });}catch{requestFrames=false;previous=null;}
  }
  async function recover(manual=false){
    if(!running()||busy||!video.srcObject||video.ended)return;
    const time=now();
    if(!manual&&(attempts>=2||time-lastAttempt<1500))return;
    lastAttempt=time;attempts++;busy=true;recoveryPending=true;
    try{
      // A renderer may stop presenting while RTC still decodes. Pause/play
      // keeps the same srcObject and the same two recording tracks intact.
      if(!video.paused)video.pause();
      await video.play();
      // Promise resolution is not a frame; only progress() marks recovery.
    }catch{if(running()){recoveryPending=false;emit('paused',true);}}
    finally{busy=false;}
  }
  function check(){
    if(stopped)return;
    const time=now();
    if(!running()){
      closeStall(time);lastFrameAt=time;previous=null;recoveryPending=false;emit('flowing');return;
    }
    if(!requestFrames){
      const count=decoded();
      if(count!==null){if(previous!==null&&count>previous)progress(time);else if(previous===null){lastFrameAt=time;observed=true;}previous=count;}
    }
    if(video.paused&&!video.ended){emit('paused',needsGesture||attempts>=2);if(!needsGesture)void recover();}
    const gap=time-lastFrameAt;
    if(observed&&gap>=2000){
      if(stallStart===null){stallStart=lastFrameAt+250;stallCount++;}
      if(!video.paused)emit('waiting');
      // Only restart presentation if fresh RTC stats prove decoding continues.
      if(!video.paused&&time-receivingAt<1700&&!busy)void recover();
    }
  }
  next();
  const timer=setInterval(check,options.intervalMs??250);
  return {
    receiveFps(fps:number|null|undefined){receivingAt=typeof fps==='number'&&Number.isFinite(fps)&&fps>0?now():-Infinity;},
    resumeFromGesture(){return recover(true);},
    check,
    snapshot():PlaybackDiagnostics{check();return {outputStallMs:observed?Math.round(stallMs+(stallStart===null?0:Math.max(0,now()-stallStart))):null,outputStallCount:observed?stallCount:null,playbackRecoveryAttempts:attempts,playbackRecoveries:recoveries};},
    stop(){if(stopped)return;closeStall(now());stopped=true;clearInterval(timer);if(callback)try{video.cancelVideoFrameCallback?.(callback);}catch{}},
  };
}
