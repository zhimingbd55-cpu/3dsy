export function waitBriefly(milliseconds:number,signal:AbortSignal){
  return new Promise<void>((resolve,reject)=>{
    signal.throwIfAborted();
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=window.setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},milliseconds);
    signal.addEventListener('abort',abort,{once:true});
  });
}
export function firstVideoFrame(video:HTMLVideoElement,signal:AbortSignal){
  return new Promise<void>((resolve,reject)=>{
    signal.throwIfAborted();let frame=0;const started=performance.now();
    const done=(error?:unknown)=>{clearInterval(timer);if(frame)video.cancelVideoFrameCallback?.(frame);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
    const abort=()=>done(signal.reason);
    const timer=window.setInterval(()=>{
      const elapsed=performance.now()-started;
      if(elapsed>=250&&video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0)done();
      else if(elapsed>8000)done(new Error('未收到有效试穿画面，请重试。'));
    },50);
    signal.addEventListener('abort',abort,{once:true});
    if(typeof video.requestVideoFrameCallback==='function')frame=video.requestVideoFrameCallback(()=>done());
  });
}

export type StableVideoWindow={stabilityMode:'video-frame-callback'|'decoded-frame-counter'|'weak-playback';stableWindowMs:number;stableFrames:number|null};
function decodedCount(video:HTMLVideoElement){
  try{const quality=video.getVideoPlaybackQuality?.();if(typeof quality?.totalVideoFrames==='number')return quality.totalVideoFrames;}catch{}
  const legacy=(video as HTMLVideoElement&{webkitDecodedFrameCount?:number}).webkitDecodedFrameCount;
  return typeof legacy==='number'?legacy:null;
}
export async function waitForStableVideo(video:HTMLVideoElement,signal:AbortSignal):Promise<StableVideoWindow>{
  const duration=2000,deadline=performance.now()+25000;
  const usable=()=>video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0&&video.srcObject!==null;
  if(typeof video.requestVideoFrameCallback==='function'){
    let active=true,callback=0,frames=0,lastAt=0,lastFrame=-1,windowStart=0;
    const next:VideoFrameRequestCallback=(now,metadata)=>{
      if(!active)return;
      const frame=typeof metadata.presentedFrames==='number'?metadata.presentedFrames:metadata.mediaTime;
      const observed=performance.now();
      if(frame!==lastFrame){if(lastAt&&observed-lastAt>1000){frames=0;windowStart=observed;}if(!windowStart)windowStart=observed;frames++;lastAt=observed;lastFrame=frame;}
      callback=video.requestVideoFrameCallback(next);
    };
    callback=video.requestVideoFrameCallback(next);
    try{
      while(performance.now()<deadline){
        await waitBriefly(100,signal);const now=performance.now();
        if(!usable())throw new Error('试穿画面中断，请重试。');
        if(lastAt&&now-lastAt>1000){frames=0;windowStart=0;lastAt=0;lastFrame=-1;}
        if(windowStart&&lastAt&&frames>=3&&now-windowStart>=duration&&now-lastAt<=1000)return {stabilityMode:'video-frame-callback',stableWindowMs:Math.round(now-windowStart),stableFrames:frames};
      }
      throw new Error('试穿画面未能连续稳定，请重试。');
    }finally{active=false;video.cancelVideoFrameCallback?.(callback);}
  }
  let initial=decodedCount(video);
  if(initial!==null){
    let frames=0,lastAt=0,windowStart=0,lastCount=initial;
    while(performance.now()<deadline){
      await waitBriefly(100,signal);const now=performance.now();
      if(!usable())throw new Error('试穿画面中断，请重试。');
      const count=decodedCount(video);if(count===null)break;
      if(count<lastCount){frames=0;windowStart=0;lastAt=0;}
      else if(count>lastCount){if(lastAt&&now-lastAt>1000){frames=0;windowStart=now;}if(!windowStart)windowStart=now;frames+=count-lastCount;lastAt=now;}
      lastCount=count;
      if(windowStart&&lastAt&&frames>=3&&now-windowStart>=duration&&now-lastAt<=1000)return {stabilityMode:'decoded-frame-counter',stableWindowMs:Math.round(now-windowStart),stableFrames:frames};
    }
    if(performance.now()>=deadline)throw new Error('试穿画面未能连续稳定，请重试。');
  }
  // Weak compatibility fallback for WebViews that expose neither frame callbacks nor decoded counters.
  if(!usable()||video.paused)throw new Error('试穿画面尚未开始播放，请重试。');
  await waitBriefly(duration,signal);
  if(!usable()||video.paused)throw new Error('试穿画面播放中断，请重试。');
  return {stabilityMode:'weak-playback',stableWindowMs:duration,stableFrames:null};
}
