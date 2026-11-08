export type PreviewDiagnostics={previewFps:number|null;previewLongGapMs:number|null};

// Count only observable, actively displayed preview time. Hidden/paused intervals
// break the baseline; they must never become camera freezes on the next frame.
export function previewMetrics(){
  let previousTime:number|null=null,previousFrames:number|null=null,lastFrameAt:number|null=null;
  let elapsed=0,frames=0,longGap=0;
  function observe(now:number,count:number|null,visible=true){
    if(!visible||!Number.isFinite(now)||count===null||!Number.isFinite(count)||count<0){previousTime=previousFrames=lastFrameAt=null;return;}
    if(previousTime===null||previousFrames===null||lastFrameAt===null||now<previousTime||count<previousFrames){previousTime=lastFrameAt=now;previousFrames=count;return;}
    const delta=now-previousTime;
    elapsed+=delta;
    longGap+=Math.max(0,now-Math.max(previousTime,lastFrameAt+250));
    if(count>previousFrames){frames+=count-previousFrames;lastFrameAt=now;}
    previousTime=now;previousFrames=count;
  }
  function reset(){previousTime=previousFrames=lastFrameAt=null;elapsed=frames=longGap=0;}
  function snapshot():PreviewDiagnostics{return {previewFps:elapsed>0?Math.round(frames/elapsed*10000)/10:null,previewLongGapMs:elapsed>0?Math.round(longGap):null};}
  return {observe,reset,snapshot};
}

export function observePreview(video:HTMLVideoElement,options:{isVisible?:()=>boolean}={}){
  const metrics=previewMetrics();let stopped=false,callback=0,callbackFrames:number|null=null;
  let requestFrame:((callback:VideoFrameRequestCallback)=>number)|null=null;
  try{if(typeof video.requestVideoFrameCallback==='function')requestFrame=video.requestVideoFrameCallback.bind(video);}catch{/* Optional native bridge may reject access. */}
  const visible=()=>!document.hidden&&!video.hidden&&!video.paused&&!video.ended&&video.readyState>=2&&(options.isVisible?.()??true);
  const validCount=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  const frameCount=()=>{
    if(requestFrame)return callbackFrames;
    try{
      const quality=video.getVideoPlaybackQuality?.(),total=quality?.totalVideoFrames,dropped=quality?.droppedVideoFrames;
      // The standard's total includes dropped frames, so subtract them before
      // treating this fallback as visible progress.
      if(validCount(total))return Math.max(0,total-(validCount(dropped)?dropped:0));
    }catch{/* Try the legacy decoder counter if this optional API throws. */}
    try{
      const legacy=video as HTMLVideoElement&{webkitDecodedFrameCount?:number;webkitDroppedFrameCount?:number};
      const total=legacy.webkitDecodedFrameCount,dropped=legacy.webkitDroppedFrameCount;
      if(validCount(total))return Math.max(0,total-(validCount(dropped)?dropped:0));
    }catch{/* Missing or broken diagnostics must not interrupt the camera. */}
    return null;
  };
  function measure(){
    if(stopped)return;
    try{metrics.observe(performance.now(),frameCount(),visible());}
    catch{metrics.observe(performance.now(),null,false);}
  }
  function nextFrame(){
    if(!requestFrame)return;
    try{
      callback=requestFrame((_now,metadata)=>{
        if(stopped)return;
        try{callbackFrames=validCount(metadata.presentedFrames)?metadata.presentedFrames:(callbackFrames??0)+1;}catch{callbackFrames=(callbackFrames??0)+1;}
        measure();nextFrame();
      });
    }catch{
      // Keep the totals but start a new counter baseline for decoder fallback.
      requestFrame=null;callbackFrames=null;metrics.observe(performance.now(),null,false);
    }
  }
  nextFrame();
  const interval=window.setInterval(measure,100);
  document.addEventListener('visibilitychange',measure);
  const events=['pause','play','emptied','ended'] as const;
  for(const event of events)video.addEventListener(event,measure);
  return {
    snapshot(){measure();return metrics.snapshot();},
    reset(){metrics.reset();measure();},
    stop(){if(stopped)return;measure();stopped=true;clearInterval(interval);if(callback)try{video.cancelVideoFrameCallback?.(callback);}catch{/* Best effort; late callbacks already ignore stopped observers. */}document.removeEventListener('visibilitychange',measure);for(const event of events)video.removeEventListener(event,measure);},
  };
}
