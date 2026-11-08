export type PairState={playing:boolean;waiting:boolean;paired:boolean;position:number;duration:number;error:string|null};
type Options={result:HTMLVideoElement;original?:HTMLVideoElement|null;changed?:(state:PairState)=>void;intervalMs?:number};

/** One gesture starts both elements. This links transport controls, not model latency. */
export function createPairedPlayer(options:Options){
  let original=options.original||null,participants=[options.result],wanted=false,waiting=false,disposed=false,epoch=0,starting=false,error:string|null=null,lastCorrection=0;
  const cleanups:(()=>void)[]=[];
  const duration=()=>{const values=participants.map(v=>v.duration).filter(v=>Number.isFinite(v)&&v>0);return values.length?Math.min(...values):0;};
  const snapshot=():PairState=>({playing:wanted&&!waiting,waiting,paired:Boolean(original),position:options.result.currentTime||0,duration:duration(),error});
  const emit=()=>{if(!disposed)options.changed?.(snapshot());};
  const pauseElements=()=>participants.forEach(video=>video.pause());
  const pause=()=>{epoch++;starting=false;wanted=false;waiting=false;pauseElements();emit();};
  const start=()=>{
    if(disposed)return Promise.resolve();
    const ticket=++epoch;starting=true;waiting=false;error=null;wanted=true;
    // Deliberately no await before either play(): both retain user activation.
    const promises=participants.map(video=>{try{return Promise.resolve(video.play());}catch(failure){return Promise.reject(failure);}});
    emit();
    return Promise.allSettled(promises).then(results=>{
      if(disposed||ticket!==epoch)return;
      starting=false;
      if(results.some(value=>value.status==='rejected')){wanted=false;waiting=false;pauseElements();error='播放未能启动，请再次点击播放。';}
      else if(waiting){
        if(participants.every(video=>video.readyState>=3&&!video.seeking))waiting=false;
        else pauseElements();
      }
      emit();
    });
  };
  const play=()=>{
    if(disposed)return Promise.resolve();
    participants=original?[original,options.result]:[options.result];
    const end=duration();if(end&&options.result.currentTime>=end-.08)participants.forEach(video=>video.currentTime=0);
    else if(original&&Math.abs(original.currentTime-options.result.currentTime)>.05)original.currentTime=options.result.currentTime;
    return start();
  };
  const onReady=()=>{if(!disposed&&wanted&&waiting&&!starting&&participants.every(video=>video.readyState>=3&&!video.seeking)){void start();}};
  const bind=(video:HTMLVideoElement)=>{
    const listen=(event:string,handler:()=>void)=>{video.addEventListener(event,handler);cleanups.push(()=>video.removeEventListener(event,handler));};
    // Pausing a pending initial play() aborts its promise on Safari/Chromium.
    // Let the activated play calls settle before pausing a buffering pair.
    listen('waiting',()=>{if(wanted&&participants.includes(video)){waiting=true;if(!starting)pauseElements();emit();}});
    listen('canplay',onReady);listen('seeked',onReady);listen('loadedmetadata',emit);
    listen('ended',()=>{if(participants.includes(video)){pause();}});
    listen('error',()=>{if(participants.includes(video)){pause();error='视频暂时无法播放，请刷新后重试。';emit();}});
  };
  bind(options.result);if(original)bind(original);
  const check=()=>{
    if(disposed)return;
    const end=duration();if(wanted&&end&&options.result.currentTime>=end-.04){pause();return;}
    if(wanted&&!waiting&&participants.length===2&&participants.every(video=>video.readyState>=3&&!video.seeking)){
      const peer=participants[0],time=Date.now();if(Math.abs(peer.currentTime-options.result.currentTime)>.2&&time-lastCorrection>1000){peer.currentTime=options.result.currentTime;lastCorrection=time;}
    }
    emit();
  };
  const interval=setInterval(check,options.intervalMs??250);
  return {play,pause,toggle:()=>wanted?Promise.resolve(pause()):play(),snapshot,check,
    seek:(seconds:number)=>{const end=duration(),position=Math.max(0,Math.min(Number.isFinite(seconds)?seconds:0,end||0));participants.forEach(video=>{video.currentTime=position;});emit();},
    replay:()=>{participants.forEach(video=>video.currentTime=0);return play();},
    attachOriginal:(video:HTMLVideoElement)=>{if(disposed||original===video)return;original=video;bind(video);emit();},
    destroy:()=>{if(disposed)return;pause();disposed=true;clearInterval(interval);cleanups.forEach(clean=>clean());},
  };
}
