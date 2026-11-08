import {createPairedPlayer,type PairState} from './paired-player';
import './paired-view.css';

export type PairClip={videoUrl:string|null;posterUrl:string|null;status:string;waitingForUpload?:boolean;revision?:string};
export type PairClips={original:PairClip;result:PairClip};
const clock=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
function waitingMessage(clip:PairClip){return clip.waitingForUpload?'等待原手机继续上传':clip.status==='processing'||clip.status==='queued'?'视频正在处理中':clip.status==='failed'?'视频未能完整保存':'视频正在上传';}
export function createPairedView(root:HTMLElement,clips:PairClips){
  root.classList.add('paired-view');
  root.innerHTML='<div class="paired-clips" aria-label="原视频与试穿成片"><article><h2>原视频</h2><div class="paired-media" data-clip="original"></div></article><article><h2>试穿成片</h2><div class="paired-media" data-clip="result"></div></article></div><div class="paired-controls"><button type="button" class="paired-play" disabled>正在准备视频</button><div class="paired-timeline"><input type="range" min="0" max="0" value="0" step="0.1" aria-label="播放进度" disabled><output>0:00 / 0:00</output></div><p class="paired-feedback" role="status"></p></div>';
  const play=root.querySelector<HTMLButtonElement>('.paired-play')!,seek=root.querySelector<HTMLInputElement>('input')!,output=root.querySelector<HTMLOutputElement>('output')!,feedback=root.querySelector<HTMLElement>('.paired-feedback')!;
  const videos:Partial<Record<'original'|'result',HTMLVideoElement>>={};
  type Kind='original'|'result';
  const revisions=new Map<Kind,string>(),updates=new Map<Kind,PairClip>();
  const source=(url:string,revision?:string)=>revision?`${url}${url.includes('?')?'&':'?'}v=${encodeURIComponent(revision)}`:url;
  const key=(clip:PairClip)=>`${clip.videoUrl}|${clip.revision||''}`;
  let controller:ReturnType<typeof createPairedPlayer>|null=null,disposed=false;
  const flushUpdates=()=>{
    if(disposed||controller?.snapshot().playing||controller?.snapshot().waiting)return;
    for(const [kind,clip] of updates){
      const video=videos[kind];if(!video||!clip.videoUrl)continue;
      const time=video.currentTime,revision=key(clip);updates.delete(kind);revisions.set(kind,revision);
      video.addEventListener('loadedmetadata',()=>{if(disposed||revisions.get(kind)!==revision)return;if(Number.isFinite(time)&&time>0)video.currentTime=Math.min(time,Number.isFinite(video.duration)?video.duration:time);},{once:true});
      video.src=source(clip.videoUrl,clip.revision);video.poster=clip.posterUrl?source(clip.posterUrl,clip.revision):'';video.load();
    }
  };
  const changed=(state:PairState)=>{if(!state.playing&&!state.waiting)flushUpdates();play.disabled=false;play.textContent=state.waiting?'暂停等待':state.playing?'暂停':state.duration&&state.position>=state.duration-.08?'重新播放':state.paired?'播放对比':'播放成片';play.setAttribute('aria-pressed',String(state.playing||state.waiting));seek.disabled=!state.duration;seek.max=String(state.duration);if(document.activeElement!==seek)seek.value=String(state.position);output.value=`${clock(state.position)} / ${clock(state.duration)}`;feedback.textContent=state.error||(updates.size?'新版本已保存，暂停后更新视频':state.waiting?'视频缓冲中，请稍候':!videos.original?'原视频完成后可同时播放对比':'');};
  const install=(kind:'original'|'result',clip:PairClip)=>{
    const slot=root.querySelector<HTMLElement>(`[data-clip="${kind}"]`)!;
    if(videos[kind]){if(clip.videoUrl&&revisions.get(kind)!==key(clip))updates.set(kind,clip);else updates.delete(kind);return;}
    if(!clip.videoUrl){let placeholder=slot.querySelector<HTMLElement>('.paired-placeholder');if(!placeholder){placeholder=document.createElement('p');placeholder.className='paired-placeholder';slot.replaceChildren(placeholder);}placeholder.textContent=waitingMessage(clip);return;}
    const video=document.createElement('video');video.src=source(clip.videoUrl,clip.revision);video.poster=clip.posterUrl?source(clip.posterUrl,clip.revision):'';revisions.set(kind,key(clip));video.preload='metadata';video.playsInline=true;video.muted=true;video.setAttribute('controlsList','nodownload noplaybackrate');video.disablePictureInPicture=true;video.setAttribute('aria-label',kind==='original'?'原视频':'试穿成片');slot.replaceChildren(video);videos[kind]=video;
    if(kind==='original')controller?.attachOriginal(video);
  };
  const update=(next:PairClips)=>{if(disposed)return;install('original',next.original);install('result',next.result);if(!controller&&videos.result)controller=createPairedPlayer({result:videos.result,original:videos.original,changed});flushUpdates();if(controller)changed(controller.snapshot());};
  update(clips);play.onclick=()=>void controller?.toggle();seek.oninput=()=>controller?.seek(Number(seek.value));
  const onVisibility=()=>{if(document.hidden)controller?.pause();};document.addEventListener('visibilitychange',onVisibility);
  return {update,pause:()=>controller?.pause(),destroy:()=>{disposed=true;document.removeEventListener('visibilitychange',onVisibility);controller?.destroy();Object.values(videos).forEach(video=>{video.pause();video.removeAttribute('src');video.load();});},get controller(){return controller;}};
}
