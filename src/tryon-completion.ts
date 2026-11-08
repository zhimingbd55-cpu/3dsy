import {api,ApiError,type Tryon} from './api';
import {createPairedView,type PairClips} from './paired-view';
import {pendingUploads} from './recorder';
import {recordingComplete,pairSavePercent,recordingVersion,type LocalSaveProgress} from './completion-progress';
import './tryon-completion.css';

type CompletionOptions={isCurrent?:()=>boolean};
type ShareLink={url:string;expiresAt:number};
const POLL_MS=2500,EVENT_THROTTLE_MS=500,REQUEST_TIMEOUT_MS=10000;
let currentCompletion:{id:string;close():void}|null=null;

function clipsFor(item:Tryon):PairClips{
  const clip=(kind:'original'|'result')=>{
    const record=item.recordings.find(value=>value.kind===kind);
    return {videoUrl:record?.url||null,posterUrl:record?.poster||null,status:record?.status||'uploading',waitingForUpload:record?.waitingForUpload||false,revision:recordingVersion(record)};
  };
  return {original:clip('original'),result:clip('result')};
}
export function closeTryonCompletion():void{currentCompletion?.close();}

/** Opens only the owner's recording view; a public link is created on Share. */
export function openTryonCompletion(id:string,options:CompletionOptions={}):void{
  if(!id||document.hidden||options.isCurrent?.()===false)return;
  closeTryonCompletion();
  const dialog=document.createElement('dialog');dialog.className='tryon-completion-dialog';
  dialog.setAttribute('aria-labelledby','tryon-completion-title');
  dialog.innerHTML='<header class="completion-header"><div><img class="completion-brand" src="/brand/logo.svg" alt="1➕衣"><h2 id="tryon-completion-title">看看你的新样子</h2></div><button type="button" data-completion-close aria-label="关闭试穿对比">×</button></header><section class="completion-content"><div class="completion-save-progress" data-completion-progress><progress data-save-percent max="100" value="0" aria-label="原视频与试穿成片保存进度"></progress><span data-save-percent-label aria-live="polite">0%</span></div><div data-completion-pair></div><div class="completion-error" data-completion-error hidden><p role="alert"></p><button type="button" data-completion-retry>重新读取</button></div></section><footer class="completion-footer"><button type="button" data-completion-share disabled>分享</button></footer>';
  document.body.append(dialog);dialog.showModal();
  const pairRoot=dialog.querySelector<HTMLElement>('[data-completion-pair]')!;
  const progressRoot=dialog.querySelector<HTMLElement>('[data-completion-progress]')!;
  const progressBar=dialog.querySelector<HTMLProgressElement>('[data-save-percent]')!;
  const progressLabel=dialog.querySelector<HTMLElement>('[data-save-percent-label]')!;
  const errorBox=dialog.querySelector<HTMLElement>('[data-completion-error]')!;
  const shareButton=dialog.querySelector<HTMLButtonElement>('[data-completion-share]')!;
  const empty={videoUrl:null,posterUrl:null,status:'uploading'};
  let view=createPairedView(pairRoot,{original:empty,result:empty});
  let active=true,timer=0,timerAt=0,lastRefresh=0,inFlight=false,refreshAgain=false,bothReady=false,resultReady=false,unavailable=false,sharing=false;
  let pollController:AbortController|null=null,shareController:AbortController|null=null,childShare:HTMLDialogElement|null=null;
  const isCurrent=()=>active&&dialog.isConnected&&options.isCurrent?.()!==false;
  const cleanup=()=>{
    if(!active)return;active=false;clearTimeout(timer);timer=0;
    pollController?.abort();shareController?.abort();
    window.removeEventListener('amen:uploads',onUploads);document.removeEventListener('visibilitychange',onVisibility);
    view.destroy();if(childShare?.open)childShare.close();childShare=null;
    if(currentCompletion?.close===close)currentCompletion=null;
    dialog.remove();
  };
  const close=()=>{if(dialog.open)dialog.close();cleanup();};
  currentCompletion={id,close};
  const checkCurrent=()=>{if(isCurrent())return true;close();return false;};
  const showError=(message:string)=>{errorBox.hidden=false;errorBox.querySelector('p')!.textContent=message;};
  const updateShare=()=>{shareButton.disabled=!resultReady||sharing||unavailable;shareButton.textContent=sharing?'正在准备分享…':'分享';};
  const markUnavailable=()=>{
    unavailable=true;resultReady=false;bothReady=false;clearTimeout(timer);timer=0;
    pollController?.abort();
    view.destroy();pairRoot.replaceChildren();
    progressRoot.hidden=true;
  };
  const schedule=(delay=POLL_MS)=>{
    if(!checkCurrent()||document.hidden||bothReady||unavailable)return;
    if(inFlight){refreshAgain=true;return;}
    const next=Math.max(Date.now()+delay,lastRefresh+EVENT_THROTTLE_MS);
    if(timer&&timerAt<=next)return;
    clearTimeout(timer);timerAt=next;timer=window.setTimeout(()=>{timer=0;void refresh();},Math.max(0,next-Date.now()));
  };
  const refresh=async()=>{
    if(!checkCurrent()||document.hidden||inFlight||bothReady||unavailable)return;
    inFlight=true;refreshAgain=false;lastRefresh=Date.now();
    const controller=new AbortController();pollController=controller;
    let timedOut=false;const timeout=window.setTimeout(()=>{timedOut=true;controller.abort();},REQUEST_TIMEOUT_MS);
    try{
      const [item,tasks]=await Promise.all([api<Tryon>(`/api/tryons/${encodeURIComponent(id)}`,{signal:controller.signal}),pendingUploads().catch(()=>[])]);
      if(!checkCurrent()||controller.signal.aborted||document.hidden)return;
      const clips=clipsFor(item);view.update(clips);
      resultReady=Boolean(clips.result.videoUrl);bothReady=['original','result'].every(kind=>recordingComplete(item.recordings.find(value=>value.kind===kind)));
      const task=tasks.find(value=>value.id===id) as LocalSaveProgress|undefined;
      const percent=pairSavePercent(item.recordings,task);
      progressRoot.hidden=false;progressBar.value=percent;progressLabel.textContent=`${percent}%`;
      errorBox.hidden=true;updateShare();
    }catch(error){
      if(!checkCurrent()||document.hidden||(controller.signal.aborted&&!timedOut))return;
      if(error instanceof ApiError&&[401,403,404,410].includes(error.status)){
        markUnavailable();
      }
      showError(timedOut?'读取视频超时，请重试。':error instanceof Error?error.message:'暂时无法读取视频，请重试。');updateShare();
    }finally{
      clearTimeout(timeout);if(pollController===controller)pollController=null;inFlight=false;
      if(active)schedule(refreshAgain?EVENT_THROTTLE_MS:POLL_MS);
    }
  };
  const onUploads=()=>{if(!bothReady)schedule(EVENT_THROTTLE_MS);};
  const onVisibility=()=>{
    if(document.hidden){clearTimeout(timer);timer=0;view.pause();pollController?.abort();}
    else if(checkCurrent())schedule(0);
  };
  dialog.querySelector<HTMLButtonElement>('[data-completion-close]')!.onclick=close;
  dialog.addEventListener('close',cleanup,{once:true});dialog.addEventListener('cancel',cleanup,{once:true});
  dialog.querySelector<HTMLButtonElement>('[data-completion-retry]')!.onclick=()=>{
    if(!checkCurrent())return;
    if(unavailable){view=createPairedView(pairRoot,{original:empty,result:empty});unavailable=false;}
    errorBox.hidden=true;bothReady=false;schedule(0);
  };
  shareButton.onclick=()=>{
    if(!checkCurrent()||!resultReady||sharing||unavailable||document.hidden)return;
    sharing=true;updateShare();view.pause();
    const controller=new AbortController();shareController=controller;
    const timeout=window.setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
    void (async()=>{
      try{
        // Import first so closing during lazy loading cannot publish a link.
        const {openShare}=await import('./library');
        if(!checkCurrent()||controller.signal.aborted||document.hidden)return;
        const link=await api<ShareLink>(`/api/tryons/${encodeURIComponent(id)}/share`,{method:'POST',signal:controller.signal});
        if(!checkCurrent()||controller.signal.aborted||document.hidden)return;
        const opening=openShare(link,id);
        childShare=Array.from(document.querySelectorAll<HTMLDialogElement>('.share-dialog[open]')).at(-1)??null;
        await opening;
      }catch(error){
        if(checkCurrent()&&!document.hidden){
          if(error instanceof ApiError&&[401,403,404,410].includes(error.status))markUnavailable();
          showError(controller.signal.aborted?'分享请求超时，请重试。':error instanceof Error?error.message:'分享暂时不可用，请重试。');
        }
      }finally{
        clearTimeout(timeout);if(shareController===controller)shareController=null;
        sharing=false;if(active)updateShare();
      }
    })();
  };
  window.addEventListener('amen:uploads',onUploads);document.addEventListener('visibilitychange',onVisibility);
  void refresh();
}
