// Request the camera's native view and its minimum hardware zoom. Keep the
// existing portrait output, without an additional user-controlled digital zoom.
import {frameClock} from './frame-clock.ts';
import {VIDEO_PROFILE} from './video-profile.ts';
export function hasLiveCameraVideo(stream:MediaStream|null|undefined):boolean{
  const tracks=stream?.getVideoTracks()??[];
  return tracks.length>0&&tracks.every(track=>track.readyState==='live'&&track.enabled);
}
export function cameraConstraints(facing:'user'|'environment',portrait=true):MediaTrackConstraints&{resizeMode:ConstrainDOMString}{
  const {portraitWidth:width,portraitHeight:height,fps}=VIDEO_PROFILE.camera;
  return {facingMode:{ideal:facing},resizeMode:{ideal:'none'},width:{ideal:portrait?width:height},height:{ideal:portrait?height:width},frameRate:{ideal:fps,max:fps}};
}
export type CameraCaptureSettings={width?:number;height?:number;frameRate?:number;correction:'not-needed'|'applied'|'failed'|'unavailable'};
const cameraCorrections=new WeakMap<MediaStreamTrack,Promise<CameraCaptureSettings>>();
function actualCapture(track:MediaStreamTrack):Omit<CameraCaptureSettings,'correction'>{
  try{
    const settings=track.getSettings?.()??{},result:Omit<CameraCaptureSettings,'correction'>={};
    for(const key of ['width','height','frameRate'] as const){const value=settings[key];if(typeof value==='number'&&Number.isFinite(value)&&value>0)result[key]=value;}
    return result;
  }catch{return {};}
}
// The centered 9:16 source crop needs at least 270x480 real camera pixels.
// A max-only request can choose 352x288, leaving just 162x288 before upscaling.
const minimumCameraCrop={width:270,height:480};
export function captureHasEnoughDetail(width:number,height:number):boolean{
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return false;
  const crop=cameraFrame(width,height);
  return crop.width>=minimumCameraCrop.width&&crop.height>=minimumCameraCrop.height;
}
function captureCapabilities(track:MediaStreamTrack):MediaTrackCapabilities{
  try{return track.getCapabilities?.()??{};}catch{return {};}
}
function cameraDimension(capability:{min?:number;max?:number}|undefined,ideal:number,minimum:number):ConstrainULongRange|null{
  const lower=typeof capability?.min==='number'&&Number.isFinite(capability.min)&&capability.min>0?Math.ceil(capability.min):0;
  const upper=typeof capability?.max==='number'&&Number.isFinite(capability.max)&&capability.max>0?Math.floor(capability.max):Infinity;
  const min=Math.max(minimum,lower),max=Math.min(Math.max(ideal,lower),upper);
  if(max<min)return null;
  // Some native cameras have no small capture mode. Respect that camera's
  // advertised minimum instead of reopening it or changing the sending canvas.
  return {ideal:Math.min(Math.max(ideal,min),max),min,max};
}
// Correct oversized or undersized capture once on the same track. A fulfilled
// applyConstraints promise is not evidence that the resulting crop is usable.
export function tuneCameraCapture(track:MediaStreamTrack,portrait=true):Promise<CameraCaptureSettings>{
  const previous=cameraCorrections.get(track);if(previous)return previous;
  const attempt=(async()=>{
    const initial=actualCapture(track),caps=captureCapabilities(track),{portraitWidth:shortEdge,portraitHeight:longEdge,fps}=VIDEO_PROFILE.camera;
    const nativePortrait=initial.width&&initial.height?initial.height>=initial.width:portrait;
    const width=cameraDimension(caps.width,nativePortrait?shortEdge:longEdge,minimumCameraCrop.width);
    const height=cameraDimension(caps.height,nativePortrait?longEdge:shortEdge,minimumCameraCrop.height);
    const maximumWidth=width?.max??(nativePortrait?shortEdge:longEdge),maximumHeight=height?.max??(nativePortrait?longEdge:shortEdge);
    const needsCorrection=(settings:Omit<CameraCaptureSettings,'correction'>)=>!!(settings.width&&settings.height&&(!captureHasEnoughDetail(settings.width,settings.height)||Math.min(settings.width,settings.height)>Math.min(maximumWidth,maximumHeight)*1.1||Math.max(settings.width,settings.height)>Math.max(maximumWidth,maximumHeight)*1.1))||(settings.frameRate!==undefined&&settings.frameRate>fps+.5);
    const complete=(settings:Omit<CameraCaptureSettings,'correction'>)=>settings.width!==undefined&&settings.height!==undefined&&settings.frameRate!==undefined;
    if(!needsCorrection(initial))return {...initial,correction:complete(initial)?'not-needed':'unavailable'} as CameraCaptureSettings;
    if(!width||!height)return {...initial,correction:'failed'} as CameraCaptureSettings;
    try{
      const apply=track.applyConstraints;
      if(typeof apply!=='function')return {...initial,correction:'failed'} as CameraCaptureSettings;
      await apply.call(track,{...track.getConstraints?.(),width,height,frameRate:{ideal:fps,max:fps}});
      const actual=actualCapture(track);
      // A fulfilled applyConstraints promise is not proof that the browser
      // corrected its capture. Keep missing settings unknown, and reject both
      // excessive capture and an undersized crop even when apply was fulfilled.
      return {...actual,correction:needsCorrection(actual)?'failed':complete(actual)?'applied':'unavailable'} as CameraCaptureSettings;
    }catch{return {...actualCapture(track),correction:'failed'} as CameraCaptureSettings;}
  })();
  cameraCorrections.set(track,attempt);return attempt;
}
export async function widestCameraView(track:MediaStreamTrack){
  try{
    const caps=track.getCapabilities?.() as MediaTrackCapabilities&{zoom?:{min:number;max:number}};
    if(caps?.zoom&&Number.isFinite(caps.zoom.min)&&caps.zoom.min>0)
      await track.applyConstraints({...track.getConstraints(),advanced:[{zoom:caps.zoom.min} as MediaTrackConstraintSet]});
  }catch{/* Unsupported hardware zoom must not prevent the camera from opening. */}
}
export function cameraFrame(w:number,h:number){
  if(!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0)throw new RangeError('Invalid camera dimensions');
  // Restore the original centered portrait frame. One aspect-ratio crop keeps
  // the largest 9:16 region; neither the preview nor a slider zooms it again.
  const width=Math.min(w,h*9/16),height=Math.min(h,w*16/9);
  return {x:(w-width)/2,y:(h-height)/2,width,height};
}
export async function portraitCamera(source:MediaStream,{signal,onPaint}:{signal?:AbortSignal;onPaint?:(time:number,duration:number)=>void}={}){
  signal?.throwIfAborted();
  const video=document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;video.srcObject=source;
  video.setAttribute('aria-hidden','true');video.style.cssText='position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';document.body.append(video);
  const canvas=document.createElement('canvas');canvas.width=VIDEO_PROFILE.canvas.width;canvas.height=VIDEO_PROFILE.canvas.height;
  const context=canvas.getContext('2d',{alpha:false});
  if(!context||typeof canvas.captureStream!=='function'){video.remove();throw new Error('当前浏览器不支持视频采集，请更新 Safari 或 Chrome。');}
  let frame=0,videoFrame=0,stopped=false,running=false,generation=0,stream:MediaStream|undefined;
  let due=frameClock(VIDEO_PROFILE.canvas.fps),fps:number=VIDEO_PROFILE.canvas.fps;
  let pending:{promise:Promise<void>;resolve:()=>void;reject:(reason:unknown)=>void;cleanup:()=>void}|undefined;
  const cancelFrames=()=>{cancelAnimationFrame(frame);frame=0;if(videoFrame)video.cancelVideoFrameCallback?.(videoFrame);videoFrame=0;};
  const suspend=(reason:unknown=new DOMException('Camera pipeline suspended','AbortError'))=>{
    generation++;running=false;cancelFrames();video.pause();
    const waiting=pending;pending=undefined;waiting?.cleanup();waiting?.reject(reason);
  };
  const dispose=()=>{if(stopped)return;stopped=true;suspend();signal?.removeEventListener('abort',dispose);stream?.getTracks().forEach(track=>track.stop());video.srcObject=null;video.remove();};
  signal?.addEventListener('abort',dispose,{once:true});
  try{
    await video.play();
    signal?.throwIfAborted();
    const deadline=performance.now()+5000;
    while(!video.videoWidth||video.readyState<2){signal?.throwIfAborted();if(performance.now()>deadline)throw new Error('相机画面未就绪，请重新开启相机。');await new Promise(r=>setTimeout(r,50));}
    const hasVideoFrames=typeof video.requestVideoFrameCallback==='function';
    let lastVideoFrameAt=performance.now();
    const paint=()=>{if(pending&&(!hasLiveCameraVideo(source)||!hasLiveCameraVideo(stream)))throw new Error('相机采集已中断，请重新开始。');const started=performance.now(),rect=cameraFrame(video.videoWidth,video.videoHeight);context.drawImage(video,rect.x,rect.y,rect.width,rect.height,0,0,canvas.width,canvas.height);onPaint?.(performance.now(),performance.now()-started);const waiting=pending;pending=undefined;waiting?.cleanup();waiting?.resolve();};
    const draw=(now:number)=>{if(video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0&&due(now))paint();};
    // Some mobile browsers expose rVFC but stop delivering callbacks for an
    // invisible source video. Keep a paced fallback alive, including when a
    // live stream's currentTime is coarse or unchanged. Both share one clock.
    const schedule=(epoch:number)=>{
      const current=()=>!stopped&&running&&generation===epoch;
      const onVideoFrame:VideoFrameRequestCallback=now=>{if(!current())return;lastVideoFrameAt=now;try{draw(now);}catch(error){suspend(error);return;}if(current())videoFrame=video.requestVideoFrameCallback(onVideoFrame);};
      const onAnimationFrame=(now:number)=>{if(!current())return;try{if(!hasVideoFrames||now-lastVideoFrameAt>250)draw(now);}catch(error){suspend(error);return;}if(current())frame=requestAnimationFrame(onAnimationFrame);};
      if(hasVideoFrames)videoFrame=video.requestVideoFrameCallback(onVideoFrame);
      frame=requestAnimationFrame(onAnimationFrame);
    };
    // An explicit capture rate avoids relying on change-only canvas capture
    // behaviour across mobile browsers. Raw camera preview bypasses this path.
    paint();stream=canvas.captureStream(VIDEO_PROFILE.canvas.fps);video.pause();
    const resume=(resumeSignal?:AbortSignal):Promise<void>=>{
      if(resumeSignal?.aborted)return Promise.reject(resumeSignal.reason);
      if(stopped)return Promise.reject(new DOMException('Camera pipeline disposed','AbortError'));
      if(!hasLiveCameraVideo(source)||!hasLiveCameraVideo(stream)){
        const error=new Error('相机采集已中断，请重新开始。');suspend(error);return Promise.reject(error);
      }
      if(running)return pending?.promise??Promise.resolve();
      running=true;const epoch=++generation;due=frameClock(fps);
      let resolve!:()=>void,reject!:(reason:unknown)=>void;
      const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
      const abort=()=>{if(generation===epoch)suspend(resumeSignal?.reason);};
      const timeout=setTimeout(()=>{if(generation===epoch&&pending)suspend(new Error('相机画面未恢复，请重新开启相机。'));},5000);
      pending={promise,resolve,reject,cleanup:()=>{clearTimeout(timeout);resumeSignal?.removeEventListener('abort',abort);}};
      resumeSignal?.addEventListener('abort',abort,{once:true});
      void(async()=>{
        try{
          await video.play();
          if(stopped||!running||generation!==epoch){if(!running)video.pause();return;}
          lastVideoFrameAt=performance.now();schedule(epoch);
        }catch(error){if(generation===epoch)suspend(error);}
      })();
      return promise;
    };
    const setFps=(value:number)=>{if(!Number.isFinite(value)||value<8||value>VIDEO_PROFILE.canvas.fps)throw new RangeError('Invalid canvas frame rate');fps=value;due=frameClock(fps);};
    return {stream,dispose,setFps,resume,suspend:()=>suspend()};
  }catch(error){dispose();throw error;}
}
