import { createDecartClient,models,noopLogger,type RealTimeClient } from '@decartai/sdk';
import { api,post,escape,toast,errorToast,date,download,icons,ApiError,type Garment,type Me,type Tryon } from './api';
import { recordPair,supportedMime,pauseUploads,pendingUploads,recoverUploads,allowLiveUploads } from './recorder';
import {healthyUploadSample} from './upload-policy';
import {createVisitAnalytics} from './visit-analytics';
import { portraitCamera,cameraConstraints,widestCameraView,tuneCameraCapture,captureHasEnoughDetail,hasLiveCameraVideo } from './portrait';
import { renderVideos } from './library';
import {streamMetrics} from './stream-metrics';
import {waitBriefly,firstVideoFrame,waitForStableVideo} from './live-wait';
import {sessionFailureMessage} from './session-failure';
import {watchConnection} from './connection-watch';
import {applyFluidPublishProfile,readPublishProfile} from './adaptive-fluid';
import {VIDEO_PROFILE} from './video-profile';
import {observePreview} from './preview-metrics';
import {watchOutputPlayback} from './output-playback';
import {createWardrobeRenderer} from './wardrobe-renderer';
import {initialDemo,recordingLimit,connectionLimit,deadlineRemaining,isFlowTerminal,isNormalFlowEnd,watchRotation,type FlowFields,type TryonMode} from './tryon-flow';
import './style.css';
import './wardrobe.css';
import './tryon-flow.css';
import './promo-entry.css';

const app=document.getElementById('app')!;
type FlowTryon=Tryon&FlowFields;
type BusinessContact={name:string;wechatId:string;source:'agent'|'official';label:string;qrUrl:string|null;referralPath:string|null};
const referralCode=new URLSearchParams(location.search).get('ref');
if(referralCode){const manifest=document.querySelector<HTMLLinkElement>('link[rel="manifest"]');if(manifest)manifest.href=`/manifest.webmanifest?ref=${encodeURIComponent(referralCode)}`;}
if(location.pathname.startsWith('/admin')){void import('./admin').then(m=>m.mountAdmin(app)).catch(errorToast);}
else if(location.pathname==='/privacy'){
  app.innerHTML='<main class="privacy"><a href="/">← 1➕衣</a><h1>素材与视频</h1><p>开始试衣后，摄像头画面会发送至 Decart 生成试穿效果。原视频和试穿视频将保存到本站，供你和管理员查看，30 天后删除。本站不录音。</p><p>你上传的服装默认保存，只有你和管理员可以访问。用户视频可在线播放和分享，不能在用户端移除或下载。分享会展示原视频和试穿成片，任何持有链接的人均可观看，链接按拍摄时间起 30 天失效；如需提前关闭分享或永久删除视频，请联系管理员。服装素材仍可下载或删除。</p><p>本站记录匿名浏览器的页面访问和选衣、开始试衣等操作，用于统计使用情况；动作统计保留 90 天，不记录准备阶段人像或页面完整链接。本站使用当前浏览器识别你的衣橱。更换浏览器或清除浏览器数据后，不能自动找回原有内容。</p></main>';
}else if(location.pathname==='/credits'){
  app.innerHTML='<main class="privacy"><a href="/">← 1➕衣</a><h1>服装素材来源</h1><div id="garment-credits" class="credits-list">正在读取素材来源…</div></main>';
  void api<Array<{name:string;creator:string;source:string;license:string;modifications:string}>>('/garment-credits.json').then(items=>{const list=document.getElementById('garment-credits');if(list)list.innerHTML=items.map(item=>`<article><h2>${escape(item.name)}</h2><p>作者：${escape(item.creator)}</p><p>来源：${escape(item.source)}</p><p>许可：${escape(item.license)}</p><p>处理：${escape(item.modifications)}</p></article>`).join('');}).catch(errorToast);
}else{void mount().catch(errorToast);}

async function mount(){
  app.innerHTML=`<div class="shell"><header class="topbar"><div class="brand-actions"><a class="brand" href="${referralCode?`/a/${encodeURIComponent(referralCode)}`:'/'}"><img src="/brand/logo.svg" alt="1➕衣"></a><button id="business-contact" class="text-button">商务合作</button></div><button id="mine" class="text-button">我的视频<span id="save-badge" class="save-badge" hidden></span></button></header>
  <main class="studio"><aside id="wardrobe-3d-panel" class="wardrobe-panel" aria-label="衣橱一"><button id="upload-3d-button" class="wardrobe-upload" type="button"><span aria-hidden="true">＋</span><span class="wardrobe-upload-label">添加服装</span></button><div id="wardrobe-3d" class="wardrobe-grid"></div></aside><section class="center-panel"><section id="stage" class="stage" data-view="preview" aria-label="试衣画面"><video id="preview" autoplay muted playsinline hidden></video><video id="output" autoplay muted playsinline hidden></video><div id="empty" class="stage-empty">${icons.shirt}<button id="open-camera" class="pill light">开启相机</button></div><div id="station-guide" class="station-guide" hidden aria-hidden="true"><svg class="station-mask" viewBox="0 0 56.25 100" preserveAspectRatio="xMidYMid meet"><defs><mask id="station-cutout" maskUnits="userSpaceOnUse" x="0" y="0" width="56.25" height="100"><rect width="56.25" height="100" fill="white"></rect><path d="M28.125 5 C22.2 5 18 10 18 17 C18 22 20 26 23.5 28.3 L23.5 30 C18 30.2 13.2 32 4.5 36 L2.8 53 C1.8 55.4 2.5 57.7 4.8 59 L7.4 60.5 L9 43.2 L9.5 68 C17 75 19.2 80 22.5 83 L20.8 95 L35.45 95 L33.75 83 C37.05 80 39.25 75 46.75 68 L47.25 43.2 L48.85 60.5 L51.45 59 C53.75 57.7 54.45 55.4 53.45 53 L51.75 36 C43.05 32 38.25 30.2 32.75 30 L32.75 28.3 C36.25 26 38.25 22 38.25 17 C38.25 10 34.05 5 28.125 5 Z" fill="black"></path></mask></defs><rect width="56.25" height="100" fill="rgba(0,0,0,.48)" mask="url(#station-cutout)"></rect><path d="M28.125 5 C22.2 5 18 10 18 17 C18 22 20 26 23.5 28.3 L23.5 30 C18 30.2 13.2 32 4.5 36 L2.8 53 C1.8 55.4 2.5 57.7 4.8 59 L7.4 60.5 L9 43.2 L9.5 68 C17 75 19.2 80 22.5 83 L20.8 95 L35.45 95 L33.75 83 C37.05 80 39.25 75 46.75 68 L47.25 43.2 L48.85 60.5 L51.45 59 C53.75 57.7 54.45 55.4 53.45 53 L51.75 36 C43.05 32 38.25 30.2 32.75 30 L32.75 28.3 C36.25 26 38.25 22 38.25 17 C38.25 10 34.05 5 28.125 5 Z" fill="none" stroke="rgba(255,255,255,.92)" stroke-width=".7" vector-effect="non-scaling-stroke"></path></svg><span id="preparation-countdown" class="guide-countdown" aria-live="polite"></span><span class="guide-instruction">请对准自己的位置</span></div><div id="station-guidance" class="station-guidance" hidden>先保持正面，衣服显示稳定后再缓慢转身。</div><button id="resume-output" class="pill playback-resume" type="button" hidden>恢复播放</button><button id="flip" class="icon-button stage-flip" aria-label="切换摄像头" hidden>${icons.flip}</button><span id="countdown" class="countdown" hidden>00:30</span><span id="flow-status" class="flow-status" role="status" hidden></span><div id="connecting" class="stage-message" hidden><span class="spinner"></span><span id="connection-status" role="status" aria-live="polite">正在安排试衣</span></div></section>
  <div class="selection-line"><span id="garment-name" class="sr-only"></span><span id="remaining"></span></div><div class="actions"><button id="primary" class="primary" disabled>开始试衣</button></div><button id="share-tryon" class="promo-entry" type="button">分享试衣</button><p id="save-status" class="subtle status" role="status"></p></section><aside id="wardrobe-2d-panel" class="wardrobe-panel" aria-label="衣橱二"><button id="upload-2d-button" class="wardrobe-upload" type="button"><span aria-hidden="true">＋</span><span class="wardrobe-upload-label">添加服装</span></button><div id="wardrobe-2d" class="wardrobe-grid"></div></aside></main></div>
  <dialog id="business-dialog" class="sheet business-dialog"><header><h2>商务合作</h2><button id="close-business" class="icon-button" aria-label="关闭">${icons.close}</button></header><div id="business-card"></div><div id="business-qr-large" hidden></div></dialog>
  <dialog id="upload-category-dialog" class="sheet upload-category-dialog"><header><h2>这件服装是什么类别？</h2><button id="cancel-upload" class="icon-button" aria-label="取消上传">${icons.close}</button></header><p class="subtle">选择你确认的替换范围，服务端会按类别生成指令；不确定时可选通用处理。</p><div class="upload-category-actions"><button class="secondary" data-upload-category="top">上装</button><button class="secondary" data-upload-category="bottom">下装</button><button class="secondary" data-upload-category="outfit">整套</button><button class="secondary" data-upload-category="accessory">配饰</button><button class="secondary upload-category-unknown" data-upload-category="unknown">不确定，使用通用提示</button></div></dialog>
  <input id="upload-2d" type="file" accept="image/jpeg,image/png,image/webp" hidden>
  <dialog id="library" class="sheet"><header><h2 id="library-title">我的视频</h2><button id="close-library" class="icon-button" aria-label="关闭">${icons.close}</button></header><div class="tabs"><button data-tab="videos" class="active">视频</button><button data-tab="garments">服装</button></div><div id="library-content"><div id="library-list" class="library-grid"></div></div></dialog>`;
  const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  const preview=$<HTMLVideoElement>('preview'),output=$<HTMLVideoElement>('output'),primary=$<HTMLButtonElement>('primary');
  async function initialIdentity():Promise<Me>{
    for(let attempt=0;;attempt++){
      try{return await api<Me>('/api/me',{signal:AbortSignal.timeout(10000)});}
      catch(error){
        if(attempt>=2||(error instanceof ApiError&&error.status<500&&error.status!==408))throw error;
        $('save-status').textContent='网络暂时不稳定，正在重新连接…';
        await new Promise(resolve=>setTimeout(resolve,(attempt+1)*1000));
      }
    }
  }
  let me:Me;
  try{me=await initialIdentity();$('save-status').textContent='';}
  catch(error){
    $('save-status').textContent='页面暂时未连接成功，请点击重新加载。';
    $('open-camera').textContent='重新加载';$('open-camera').onclick=()=>location.reload();
    errorToast(error);return;
  }
  const visits=createVisitAnalytics('home');visits.start();
  let garments=await api<Garment[]>('/api/garments');
  let selected:Garment|undefined=initialDemo(garments),mode:TryonMode='auto';
  let camera:MediaStream|null=null,facing:'user'|'environment'='user',client:RealTimeClient|null=null;
  let rawCamera:MediaStream|null=null,portrait:Awaited<ReturnType<typeof portraitCamera>>|null=null;
  let cameraDiagnostics:Parameters<ReturnType<typeof streamMetrics>['setCameraDiagnostics']>[0]={actualCameraWidth:null,actualCameraHeight:null,actualCameraFps:null,cameraConstraintResult:'unknown'};
  let previewObserver:ReturnType<typeof observePreview>|null=null;
  let cameraOpening=false,cameraAbort:AbortController|null=null,autoCameraTried=false,reopenOnVisible=false;
  let state:'idle'|'preparing'|'countdown'|'queued'|'connecting'|'recording'='idle',current:FlowTryon|null=null,capture:Awaited<ReturnType<typeof recordPair>>|null=null;
  let rotationWatch:ReturnType<typeof watchRotation<FlowTryon>>|null=null,lockPending=false,lockRequested=false,flowReceivedAt=0;
  let preparationMode:'initial'|'queued'='initial',preparationStarted=0;
  let guideComplete=false;
  let sessionAbort:AbortController|null=null,progressTimer=0;
  let epoch=0,recordStarting=false,timer=0,hardTimer=0,recordStart=0,adaptiveTimer=0,fluidApplied=false,stopOutputMetrics:()=>void=()=>{},longTaskObserver:PerformanceObserver|null=null;
  let releaseSession:Promise<unknown>=Promise.resolve(),taskTimer=0;
  let pendingCaptureStop:Promise<void>|null=null;
  let pendingCaptureStart:ReturnType<typeof recordPair>|null=null;
  let libraryTab='videos',libraryVersion=0;
  let posterOpening=false;
  let completionLaunch=0,completionModule:typeof import('./tryon-completion')|null=null;
  function dismissCompletion(){++completionLaunch;completionModule?.closeTryonCompletion();}
  let metrics=streamMetrics();
  let outputPlayback:ReturnType<typeof watchOutputPlayback>|null=null;
  let outputFlow:'flowing'|'waiting'|'paused'='flowing',outputNeedsGesture=false;
  const wardrobeRenderer=createWardrobeRenderer({left:$('wardrobe-3d'),right:$('wardrobe-2d')},id=>{
    const item=garments.find(item=>item.id===id);if(!item)return;
    if(state==='idle'){visits.track('garment_select');selected=item;mode='fixed';wardrobeRenderer.setSelected(item.id);refresh();}
    else if(state==='recording'&&current?.mode==='auto'&&!current.rotation?.locked&&!lockRequested){visits.track('garment_select');void lockGarment(item);}
  });
  function acceptFlow(value:FlowTryon){
    if(current&&value.id!==current.id)return;
    if(current?.rotation&&value.rotation&&value.rotation.seq<current.rotation.seq)return;
    // A poll already in flight when lock was clicked cannot undo that lock.
    if(current?.rotation?.locked&&value.rotation&&!value.rotation.locked)return;
    current=value;flowReceivedAt=performance.now();
    if(value.rotation?.garmentId){const active=garments.find(item=>item.id===value.rotation!.garmentId);if(active){selected=active;wardrobeRenderer.setSelected(active.id);}}
    refresh();
  }
  async function lockGarment(item:Garment){
    const id=current?.id,version=epoch,controller=sessionAbort;if(!id||!controller||lockRequested)return;
    lockRequested=true;lockPending=true;rotationWatch?.invalidate();refresh();
    try{
      const value=await api<FlowTryon>(`/api/tryons/${id}/lock`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({garmentId:item.id}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])});
      if(version!==epoch)return;acceptFlow(value);lockPending=false;refresh();
    }catch(error){
      if(version!==epoch)return;
      // A lost response may have accepted the lock. Never issue a second choice.
      try{const value=await api<FlowTryon>(`/api/tryons/${id}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(4000)])});if(version!==epoch)return;if(value.rotation?.locked){acceptFlow(value);lockPending=false;refresh();return;}}catch{/* End without reopening a paid session when lock state is unknown. */}
      if(version===epoch)failSession(error);
    }
  }
  function setStatus(value:string){$('save-status').textContent=value;}
  function openBusiness(){
    void api<BusinessContact>('/api/business-contact').then(contact=>{
      const dialog=$<HTMLDialogElement>('business-dialog'),card=$('business-card'),large=$('business-qr-large');
      large.hidden=true;card.hidden=false;
      const qr=contact.qrUrl?`<img class="business-qr-preview" src="${escape(contact.qrUrl)}" alt="${escape(contact.name)}微信二维码">`:'<div class="business-qr-missing">商务二维码暂未上传</div>';
      card.innerHTML=`<p class="business-label">${escape(contact.label)}</p><h3>${escape(contact.name)}</h3>${qr}<p class="business-id-label">微信号</p><strong class="business-wechat">${escape(contact.wechatId||'暂未配置')}</strong><div class="business-actions"><button id="add-wechat" class="primary" ${contact.qrUrl?'':'disabled'}>添加微信</button><button id="copy-wechat" class="secondary" ${contact.wechatId?'':'disabled'}>复制微信号</button></div><p id="copy-fallback" class="subtle" hidden></p>`;
      $('add-wechat').onclick=()=>{
        if(!contact.qrUrl)return;const inWechat=/MicroMessenger/i.test(navigator.userAgent);
        card.hidden=true;large.hidden=false;large.innerHTML=`<button id="back-business" class="text-button">← 返回</button><img class="business-qr-large-image" src="${escape(contact.qrUrl)}" alt="${escape(contact.name)}个人微信二维码"><p>${inWechat?'请长按二维码图片，选择“识别图中二维码”添加。':'请先保存二维码图片，再打开微信“扫一扫 → 相册”选择图片。'}</p><a class="secondary business-save-qr" href="${escape(contact.qrUrl)}" download="amen-business-wechat.png">保存二维码</a>`;
        $('back-business').onclick=()=>{large.hidden=true;card.hidden=false;};
      };
      $('copy-wechat').onclick=()=>void(async()=>{
        try{await navigator.clipboard.writeText(contact.wechatId);toast('微信号已复制');}
        catch{const fallback=$('copy-fallback');fallback.hidden=false;fallback.innerHTML=`自动复制失败，请长按选择：<input class="copy-fallback-input" readonly value="${escape(contact.wechatId)}">`;const input=fallback.querySelector('input')!;input.focus();input.select();}
      })();
      dialog.showModal();
    }).catch(errorToast);
  }
  function progress(text:string,slow?:string){clearTimeout(progressTimer);$('connection-status').textContent=text;if(slow)progressTimer=window.setTimeout(()=>{if(state==='connecting')$('connection-status').textContent=slow;},8000);}
  function refresh(){
    visits.setPaused(state==='connecting'||state==='recording');
    $<HTMLButtonElement>('share-tryon').disabled=state!=='idle'||posterOpening;
    primary.disabled=cameraOpening||Boolean(camera&&(!selected||!me.available||me.storageFull||me.remaining<=0));
    if(state!=='idle')primary.disabled=false;
    primary.textContent=state==='queued'?'取消排队':state==='recording'?'结束':['preparing','countdown'].includes(state)?'取消准备':state==='connecting'?'取消':cameraOpening?'正在开启…':camera?'开始试衣':'开启相机';
    $<HTMLButtonElement>('open-camera').disabled=cameraOpening;
    $('open-camera').textContent=cameraOpening?'正在开启…':'开启相机';
    $('flip').hidden=!camera||state==='recording';$('connecting').hidden=state!=='connecting'&&state!=='queued';$('countdown').hidden=state!=='recording';
    $('station-guide').hidden=!camera||guideComplete||!['preparing','countdown','queued','connecting'].includes(state);
    $('station-guidance').hidden=state!=='recording';$('station-guidance').textContent=outputFlow==='flowing'?(current?.rotation&&current.rotation.status!=='holding'?'正在更换试穿画面，请保持正面。':'先保持正面，衣服显示稳定后再缓慢转身。'):outputFlow==='waiting'?'试穿画面暂时停顿，正在等待新画面。':outputNeedsGesture?'画面播放已暂停，请点击恢复播放。':'画面播放已暂停，正在恢复。';
    $('resume-output').hidden=state!=='recording'||!outputNeedsGesture;
    $('stage').dataset.view=state==='recording'?'result':'preview';$('stage').dataset.phase=state;
    $('garment-name').textContent=selected?.name||'选择一件衣服';$('remaining').textContent=`今日 ${me.remaining} / ${me.dailyLimit}`;
    const canChoose=state==='idle'||(state==='recording'&&current?.mode==='auto'&&!current.rotation?.locked&&!lockRequested);
    $('wardrobe-3d').classList.toggle('locked',!canChoose);$('wardrobe-2d').classList.toggle('locked',!canChoose);
    const flowStatus=$('flow-status');flowStatus.hidden=!camera;
    flowStatus.textContent=state==='idle'?(mode==='auto'?'自动试穿 5 件 · 点选可固定':'已选单件 · 试穿 30 秒'):lockPending?'正在固定所选服装':current?.rotation?.locked?'固定试穿':mode==='auto'?`自动轮换 ${Math.min(5,current?.rotation?.seq??1)}/5 · 点选可固定`:'固定试穿';
    if(me.storageFull&&state==='idle')setStatus('存储空间不足，暂时无法开始。');
    else if(!me.available&&state==='idle')setStatus('试衣暂时关闭，请稍后再来。');
  }
  function renderWardrobe(){
    wardrobeRenderer.sync(garments,selected?.id);
    refresh();
  }
  function closeCamera(){cameraAbort?.abort();cameraAbort=null;previewObserver?.stop();previewObserver=null;cameraDiagnostics={actualCameraWidth:null,actualCameraHeight:null,actualCameraFps:null,cameraConstraintResult:'unknown'};portrait?.dispose();portrait=null;rawCamera?.getTracks().forEach(x=>x.stop());rawCamera=null;camera=null;preview.srcObject=null;preview.hidden=true;$('empty').hidden=false;}
  async function openCamera(){
    if(cameraOpening||state!=='idle')return;
    if(!navigator.mediaDevices?.getUserMedia){visits.track('camera_failed');throw new Error('请用 Safari 或 Chrome 打开，并允许使用摄像头。');}
    closeCamera();const controller=new AbortController();cameraAbort=controller;cameraOpening=true;refresh();
    let source:MediaStream|null=null,adapter:Awaited<ReturnType<typeof portraitCamera>>|null=null;
    try{
      source=await navigator.mediaDevices.getUserMedia({audio:false,video:cameraConstraints(facing,window.innerHeight>=window.innerWidth)});
      controller.signal.throwIfAborted();
      await widestCameraView(source.getVideoTracks()[0]);controller.signal.throwIfAborted();
      const actual=await tuneCameraCapture(source.getVideoTracks()[0],window.innerHeight>=window.innerWidth);controller.signal.throwIfAborted();
      cameraDiagnostics={actualCameraWidth:actual.width??null,actualCameraHeight:actual.height??null,actualCameraFps:actual.frameRate??null,cameraConstraintResult:actual.correction==='not-needed'?'matched':actual.correction==='applied'?'adjusted':actual.correction==='failed'?'fallback':'unknown'};
      adapter=await portraitCamera(source,{signal:controller.signal,onPaint:(time,duration)=>metrics.recordPaint(time,duration)});controller.signal.throwIfAborted();
      rawCamera=source;portrait=adapter;camera=adapter.stream;
      // Native camera preview must not depend on the canvas frame pump. CSS
      // applies the same centered portrait crop used by the recorded stream.
      preview.srcObject=source;preview.hidden=false;preview.classList.toggle('mirror',facing==='user');await preview.play();
      previewObserver=observePreview(preview);
      controller.signal.throwIfAborted();$('empty').hidden=true;setStatus('');visits.track('camera_ready');
      for(const track of source.getVideoTracks())track.onended=()=>{if(state!=='idle')void finish(true);closeCamera();refresh();};
    }catch(error){
      adapter?.dispose();source?.getTracks().forEach(track=>track.stop());
      if(cameraAbort===controller)closeCamera();
      if(controller.signal.aborted&&(error as Error).name==='AbortError')return;
      visits.track('camera_failed');
      const name=(error as Error).name;
      throw new Error(name==='NotAllowedError'?'请允许摄像头权限，再点击开启相机。':name==='NotReadableError'?'摄像头被占用，请关闭其他相机后重试。':name==='NotFoundError'?'没有找到摄像头，请检查设备。':(error as Error).message||'无法打开摄像头，请重试。');
    }finally{cameraOpening=false;refresh();}
  }
  function autoCamera(){
    if(document.hidden||autoCameraTried)return;
    autoCameraTried=true;
    void openCamera().catch(()=>{if(!document.hidden)setStatus('点击开启相机，并允许访问。');});
  }
  function failSession(error:unknown,interrupted=true){
    if(state==='idle')return;
    const id=current?.id,endedVersion=epoch+1;
    // Release the paid session immediately. Reading its reason must not delay
    // disconnecting, and a late result must not interrupt the next try-on.
    void finish(interrupted);
    void sessionFailureMessage(error,id?()=>api<Pick<Tryon,'error'>>(`/api/tryons/${id}`,{signal:AbortSignal.timeout(2000)}):undefined).then(message=>{
      if(epoch===endedVersion&&state==='idle'&&!document.hidden)errorToast(new Error(message));
    });
  }
  function observeOutput(video:HTMLVideoElement){
    if(typeof video.requestVideoFrameCallback!=='function')return ()=>{};
    let id=0,active=true;
    const next:VideoFrameRequestCallback=(time,metadata)=>{if(!active)return;metrics.recordPresented(time,metadata);id=video.requestVideoFrameCallback(next);};
    id=video.requestVideoFrameCallback(next);
    return ()=>{active=false;video.cancelVideoFrameCallback(id);};
  }
  async function considerFluidMode(version:number){
    if(version!==epoch||state!=='recording'||fluidApplied)return;
    const reason=metrics.pressure();if(!reason)return;
    fluidApplied=true;
    try{portrait?.setFps(VIDEO_PROFILE.reduced.fps);}catch{/* Preserve the current sender and keep the session alive. */}
    const senderApplied=await applyFluidPublishProfile();
    if(version!==epoch)return;
    metrics.markReduced(reason,senderApplied,readPublishProfile());
    setStatus(senderApplied?'已为持续设备或网络压力降低发送规格':'已降低绘制帧率，设备不支持调整发送规格');
  }
  function requireCameraDetail(){
    // Check real video pixels before reservation and again before signaling;
    // fulfilled constraints alone do not prove enough facial detail remains.
    if(!hasLiveCameraVideo(rawCamera)||!hasLiveCameraVideo(camera))throw Object.assign(new Error('相机采集已中断，请重新开始。'),{name:'CameraDetailError'});
    if(!preview.videoWidth||!preview.videoHeight||preview.readyState<2)throw Object.assign(new Error('相机画面尚未就绪，请稍后再开始。'),{name:'CameraDetailError'});
    if(!captureHasEnoughDetail(preview.videoWidth,preview.videoHeight))throw Object.assign(new Error('相机分辨率过低，容易丢失脸部细节。请刷新页面重新开启相机，或用系统 Safari / Chrome 打开后再试。'),{name:'CameraDetailError'});
  }
  function start(){
    if(state!=='idle'||!selected)return;
    if(!me.available||me.storageFull||me.remaining<=0){refresh();return;}
    dismissCompletion();
    if(!hasLiveCameraVideo(rawCamera)||!hasLiveCameraVideo(camera)){
      void openCamera().then(()=>{
        if(!camera||state!=='idle')return;
        // One repair per user click. A device returning another dead track
        // must not cause repeated permission requests or an automatic loop.
        if(!hasLiveCameraVideo(rawCamera)||!hasLiveCameraVideo(camera)){
          closeCamera();refresh();throw new Error('相机未能恢复，请重新开启相机后再试。');
        }
        start();
      }).catch(errorToast);return;
    }
    requireCameraDetail();supportedMime();
    lockPending=false;lockRequested=false;
    state='preparing';preparationMode='initial';preparationStarted=performance.now();
    recordStarting=false;recordStart=0;fluidApplied=false;outputFlow='flowing';outputNeedsGesture=false;metrics=streamMetrics();sessionAbort=new AbortController();++epoch;
    metrics.setCameraDiagnostics(cameraDiagnostics);previewObserver?.reset();
    guideComplete=false;$('preparation-countdown').textContent='';setStatus('');refresh();
    const version=epoch;void confirmReady().catch(error=>handleStartError(error,version));
  }
  async function confirmReady(){
    if(state!=='preparing'||!sessionAbort)return;
    const version=epoch,controller=sessionAbort,queued=preparationMode==='queued';
    await pendingCaptureStop?.catch(()=>{});controller.signal.throwIfAborted();if(version!==epoch)return;
    portrait?.suspend();
    const preparationMs=Math.max(0,Math.round(performance.now()-preparationStarted));
    const countdownBegan=performance.now();state='countdown';refresh();
    for(const seconds of [5,4,3,2,1]){
      if(version!==epoch)return;
      $('preparation-countdown').textContent=String(seconds);refresh();
      await waitBriefly(1000,controller.signal);
    }
    if(version!==epoch)return;
    requireCameraDetail();
    const countdownMs=Math.round(performance.now()-countdownBegan);
    $('preparation-countdown').textContent='';
    if(queued){
      const id=current?.id;if(!id)throw new Error('本次排队已结束，请重新开始。');
      const ready=await api<FlowTryon>(`/api/tryons/${id}/ready`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preparationMs,countdownMs,countdownVersion:3}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])});
      if(version!==epoch)return;
      acceptFlow(ready);
      if(!current)return;
      if(current.status!=='reserved')throw new Error(current.error||'本次试衣名额已失效，请重新开始。');
      await connectReserved(version,controller);
    }else await reserveTryon(version,controller,preparationMs,countdownMs);
  }
  async function reserveTryon(version:number,controller:AbortController,preparationMs:number,countdownMs:number){
    const garment=selected;if(!garment)throw new Error('请选择一件衣服。');
    state='connecting';progress('正在安排试衣');refresh();
    try{
      await releaseSession.catch(()=>{});if(version!==epoch)return;
      const reserved=await api<FlowTryon>('/api/tryons',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({flowVersion:1,mode,...(mode==='fixed'?{garmentId:garment.id}:{}),preparationMs,countdownMs,countdownVersion:3,acceptRecording:true,queue:true}),signal:AbortSignal.timeout(8000)});
      if(version!==epoch){await post(`/api/tryons/${reserved.id}/finish`,{interrupted:true});return;}acceptFlow(reserved);
      if(!current)return;
      const queueDeadline=performance.now()+5*60000;let failures=0,wasQueued=reserved.status==='queued';
      while(current.status==='queued'){
        state='queued';progress(`正在排队，前面还有 ${current.queue?.ahead??0} 人`);refresh();
        if(performance.now()>queueDeadline)throw new Error('排队时间较长，请稍后重试。');
        await waitBriefly(2000,controller.signal);
        try{const next=await api<FlowTryon>(`/api/tryons/${reserved.id}/queue`,{method:'POST',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])});if(version!==epoch)return;acceptFlow(next);failures=0;}
        catch(error){controller.signal.throwIfAborted();if(++failures>=2)throw new Error('排队连接中断，请重新开始。');progress('正在恢复排队连接');}
        if(version!==epoch)return;
      }
      if(current.status!=='reserved')throw new Error(current.error||'本次排队已结束，请重新开始。');
      if(wasQueued){
        preparationMode='queued';preparationStarted=performance.now();state='preparing';progress('已轮到你，请重新对准轮廓');refresh();
        void confirmReady().catch(error=>handleStartError(error,version));
        return;
      }
      await connectReserved(version,controller);
    }catch(error){if(version===epoch)throw error;}
  }
  async function connectReserved(version:number,controller:AbortController){
    const id=current?.id;if(!id||current?.status!=='reserved')throw new Error('本次试衣名额已失效，请重新开始。');
    state='connecting';guideComplete=false;pauseUploads(true);progress('请保持正面和站位，正在生成试穿画面','云端生成较慢，正在等待画面');refresh();
    const requestSignal=()=>AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);
    void watchConnection(()=>api<Tryon>(`/api/tryons/${id}`,{signal:requestSignal()}),()=>version===epoch&&state==='connecting',message=>failSession(new Error(message)),controller.signal);
    const [reference,transport]=await Promise.all([
      fetch(selected?.imageUrl||'',{signal:requestSignal()}).then(r=>{if(!r.ok)throw new Error('服装图片加载失败，请重试。');return r.blob();}),
      api<{iceServers:RTCIceServer[]}>(`/api/tryons/${id}/transport`,{signal:requestSignal()})
    ]);
    if(version!==epoch)return;
    // A previous recording must finish before this shared camera track resumes.
    // No provider session is opened until a fresh local frame has been painted.
    await pendingCaptureStop?.catch(()=>{});if(version!==epoch)return;
    const adapter=portrait;if(!adapter)throw new Error('相机已中断，请重新开启。');
    adapter.setFps(VIDEO_PROFILE.canvas.fps);
    await adapter.resume(controller.signal);if(version!==epoch)return;
    requireCameraDetail();
    (globalThis as typeof globalThis&{__amenIceServers?:RTCIceServer[]}).__amenIceServers=transport.iceServers;
    const sdk=createDecartClient({proxy:`${location.origin}/api/decart`,realtimeBaseUrl:`${location.origin.replace(/^http/,'ws')}/api/realtime/${id}`,logger:noopLogger,telemetry:false});
    progress('正在连接视频通道','视频连接较慢，请稍候');
    // Server timing is authoritative from the accepted signaling WebSocket.
    // Keep a later client fallback here so media setup before that socket is
    // accepted cannot consume any of the server's 45-second session budget.
    const budget=connectionLimit(current);
    hardTimer=window.setTimeout(()=>{if(version===epoch)failSession(new Error(recordStart?'本次试衣已达时间上限。':'连接或生成超时，请重试。'));},(budget+15)*1000);
    const connected=await sdk.realtime.connect(camera!,{model:models.realtime('lucy-vton-3.6'),retries:0,mirror:false,initialState:{image:reference,prompt:{text:'Substitute only the clothing with the outfit in the reference image. Keep the person\'s face, expression, hair, body shape, pose, hands and background unchanged.',enhance:false}},onRemoteStream:stream=>{
      if(version!==epoch)return;output.srcObject=stream;output.hidden=false;output.controls=false;output.muted=true;output.classList.toggle('mirror',facing==='user');
      void output.play().then(async()=>{
        await firstVideoFrame(output,controller.signal);
      if(version!==epoch||recordStarting)return;recordStarting=true;
        while(version===epoch){
          const latest=await api<FlowTryon>(`/api/tryons/${id}`,{signal:requestSignal()});
          if(version!==epoch)return;acceptFlow(latest);
          if(latest.error)throw new Error(latest.error);
          if(isFlowTerminal(latest))throw new Error('本次试衣已结束，请重新开始。');
          if(latest.startup?.imageAccepted&&latest.startup.generationStartedAt&&(!latest.rotation||latest.rotation.status==='observing'&&latest.rotation.acknowledgedAt!=null))break;
          await waitBriefly(200,controller.signal);
        }
        if(version!==epoch)return;
        progress('正在确认画面稳定，请保持正面','正在检查视频画面');
        const initialSeq=current?.rotation?.seq;
        const stableBudget=current?.rotation?deadlineRemaining(current,current.rotation.deadlineAt)??5000:25000;
        if(stableBudget<=0)throw new Error('试穿画面未能及时稳定，请重新开始。');
        const stable=await waitForStableVideo(output,AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,Math.ceil(stableBudget)))]));
        if(version!==epoch)return;
        await api(`/api/tryons/${id}/started`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...stable,...(initialSeq?{seq:initialSeq}:{})}),signal:requestSignal()});
        if(version!==epoch)return;
        const starting=recordPair(id,camera!,stream,error=>{if(version===epoch)failSession(error);});pendingCaptureStart=starting;
        const recording=await starting;if(pendingCaptureStart===starting)pendingCaptureStart=null;
        if(version!==epoch){await recording.stop(true);return;}
        capture=recording;
        const begun=await api<FlowTryon|undefined>(`/api/tryons/${id}/recording-started`,{method:'POST',signal:requestSignal()});
        if(version!==epoch){await recording.stop(true);return;}
        if(begun?.id)acceptFlow(begun);
        if(previewObserver)metrics.setPreviewDiagnostics(previewObserver.snapshot());
        guideComplete=true;state='recording';clearTimeout(progressTimer);recordStart=performance.now();metrics.beginCapture();metrics.setInitialProfile(readPublishProfile());stopOutputMetrics=observeOutput(output);
        outputPlayback=watchOutputPlayback(output,{active:()=>version===epoch&&state==='recording',initialProgress:stable.stabilityMode!=='weak-playback',changed:(next,needsGesture)=>{if(version!==epoch||state!=='recording')return;outputFlow=next;outputNeedsGesture=needsGesture;refresh();}});
        if(typeof PerformanceObserver!=='undefined')try{longTaskObserver=new PerformanceObserver(entries=>{for(const entry of entries.getEntries())metrics.recordLongTask(entry.duration);});longTaskObserver.observe({entryTypes:['longtask']});}catch{longTaskObserver=null;}
        adaptiveTimer=window.setTimeout(()=>void considerFluidMode(version),5000);output.hidden=false;preview.hidden=true;preview.pause();refresh();
        if(current?.flowVersion===1){
          rotationWatch=watchRotation<FlowTryon>({signal:controller.signal,initialSeq:initialSeq??1,wait:waitBriefly,mayObserve:()=>!lockPending,
            read:async signal=>{const value=await api<FlowTryon>(`/api/tryons/${id}`,{signal:AbortSignal.any([signal,AbortSignal.timeout(4000)])});if(current?.rotation&&value.rotation&&(current.rotation.seq>value.rotation.seq||current.rotation.locked&&!value.rotation.locked))return current;return value;},
            observe:signal=>waitForStableVideo(output,signal),
            commit:(seq,window,signal)=>api<FlowTryon>(`/api/tryons/${id}/stable`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seq,...window}),signal:AbortSignal.any([signal,AbortSignal.timeout(4000)])}),
            updated:value=>{if(version===epoch)acceptFlow(value);},ended:value=>{if(version!==epoch)return;if(isNormalFlowEnd(value))void finish(false);else failSession(new Error(value.error||'本次试衣已结束，已保存录制片段。'));},failed:error=>{if(version===epoch)failSession(error);}
          });
        }
        let shownText='';
        timer=window.setInterval(()=>{
          if(!current||version!==epoch)return;
          const elapsed=performance.now()-recordStart,rotation=current.rotation;
          const left=rotation?deadlineRemaining(current,rotation.holdEndsAt,performance.now()-flowReceivedAt):Math.max(0,recordingLimit(current)*1000-elapsed);
          const text=rotation&&rotation.status!=='holding'?'换衣中':left==null?'':`00:${Math.ceil(left/1000).toString().padStart(2,'0')}`;
          if(text!==shownText){shownText=text;$('countdown').textContent=text;}
          if(elapsed>=recordingLimit(current)*1000||!rotation&&left!==null&&left<=0)void finish(false);
        },100);refresh();
      }).catch(error=>{if(version===epoch)failSession(error);});
    },onConnectionChange:status=>{if(version!==epoch)return;if(status==='connected'&&state==='connecting'){progress('正在等待试穿画面','云端生成较慢，正在等待画面');clearTimeout(hardTimer);hardTimer=window.setTimeout(()=>{if(version===epoch)failSession(new Error(recordStart?'本次试衣已达时间上限。':'连接或生成超时，请重试。'));},budget*1000);}if(status==='disconnected'&&state!=='idle')void handleProviderEnd(version,id,'视频连接已断开，请重试。');}});
    if(version!==epoch){connected.disconnect();return;}client=connected;
    let healthyUploadSamples=0;
    connected.on('stats',sample=>{if(version===epoch&&state==='recording'){
      metrics.sample(sample);outputPlayback?.receiveFps(sample.video?.framesPerSecond);
      const warmed=performance.now()-recordStart>=5000;
      healthyUploadSamples=warmed&&healthyUploadSample(sample)&&!metrics.pressure()&&outputFlow==='flowing'?healthyUploadSamples+1:0;
      allowLiveUploads(id,healthyUploadSamples>=3);
      if(warmed)void considerFluidMode(version);
    }});
    connected.on('sessionEnded',event=>{if(version!==epoch)return;if(event.reason==='site_key_limit'){void finish(false);toast('本次试衣已结束，可重新开始。');}else if(event.reason==='insufficient_credits')failSession(new Error(event.reason));else void handleProviderEnd(version,id,event.reason==='session_limit'?'云端并发已满，请稍后重试。':'试衣已中断，请重试。');});
    connected.on('error',error=>{if(version===epoch)failSession(error);});
  }
  async function handleProviderEnd(version:number,id:string,message:string){
    try{const latest=await api<FlowTryon>(`/api/tryons/${id}`,{signal:AbortSignal.timeout(2000)});if(version!==epoch)return;if(isNormalFlowEnd(latest)){void finish(false);return;}}catch{/* Preserve recorded chunks if the terminal reason is unavailable. */}
    if(version!==epoch)return;
    if(!current?.flowVersion&&recordStart&&performance.now()-recordStart>=29300)void finish(false);else failSession(new Error(message));
  }
  function handleStartError(error:unknown,version:number){
    if(version!==epoch)return;
    const message=error instanceof Error?error.message:String(error),connectionFailure=/pc connection|peer.?connection|ice.*fail|webrtc|rtc_error/i.test(message);
    if(current&&(error as Error).name!=='CameraDetailError')void post(`/api/tryons/${current.id}/diagnostic`,{code:connectionFailure?'ICE_CONNECT_FAILED':'SIGNAL_FAILED',platform:/iPhone|iPad/i.test(navigator.userAgent)?'ios':/Android/i.test(navigator.userAgent)?'android':'desktop'}).catch(()=>{});
    failSession(connectionFailure?new Error('视频连接未建立，请切换 Wi-Fi 或移动网络后重试。未开始生成的尝试不扣次数。'):(error as Error).name==='TimeoutError'?new Error('网络响应超时，请重试。'):error);
  }
  async function finish(interrupted:boolean){
    if(state==='idle')return;
    ++epoch;rotationWatch?.stop();rotationWatch=null;sessionAbort?.abort();sessionAbort=null;clearInterval(timer);clearTimeout(hardTimer);clearTimeout(progressTimer);clearTimeout(adaptiveTimer);stopOutputMetrics();stopOutputMetrics=()=>{};longTaskObserver?.disconnect();longTaskObserver=null;
    const finishedVersion=epoch,finishedAdapter=portrait;
    if(outputPlayback){metrics.setPlaybackDiagnostics(outputPlayback.snapshot());outputPlayback.stop();outputPlayback=null;}
    outputFlow='flowing';outputNeedsGesture=false;lockPending=false;lockRequested=false;mode='auto';selected=initialDemo(garments);wardrobeRenderer.setSelected(selected?.id);
    const id=current?.id,recording=capture,startingCapture=pendingCaptureStart,summary=metrics.summary();
    const completedRecording=Boolean(recording&&recordStart>0);capture=null;pendingCaptureStart=null;current=null;
    metrics.endCapture();
    if(id&&summary)void api(`/api/tryons/${id}/performance`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(summary),keepalive:true,signal:AbortSignal.timeout(8000)}).catch(()=>{});
    // Stop recorders before disconnecting their tracks; saving belongs to the
    // durable queue and must never change this screen after another try-on starts.
    const tails=[pendingCaptureStop,recording?.stop(interrupted),startingCapture?.then(value=>value.stop(true))].filter((value):value is Promise<void>=>Boolean(value));
    const stopped=tails.length?Promise.allSettled(tails).then(()=>{}):null;if(stopped)pendingCaptureStop=stopped;
    client?.disconnect();client=null;
    if(id)releaseSession=api(`/api/tryons/${id}/finish`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({interrupted}),keepalive:true,signal:AbortSignal.timeout(8000)}).catch(()=>{});
    output.pause();output.srcObject=null;output.hidden=true;output.controls=false;
    preview.hidden=false;if(camera&&!document.hidden)void preview.play().catch(()=>{});$('empty').hidden=Boolean(camera);state='idle';preparationMode='initial';$('preparation-countdown').textContent='';setStatus('');refresh();
    pauseUploads(false);
    // Do not let the tail of a previous save suspend the next live try-on.
    const settle=()=>{if(pendingCaptureStop===stopped)pendingCaptureStop=null;if(epoch===finishedVersion&&portrait===finishedAdapter&&state==='idle')finishedAdapter?.suspend();scheduleTasks();};
    if(stopped)void stopped.catch(()=>{}).finally(settle);else settle();
    if(id&&completedRecording&&!document.hidden){
      const launch=++completionLaunch;
      const isCurrent=()=>epoch===finishedVersion&&state==='idle';
      const canOpen=()=>launch===completionLaunch&&isCurrent()&&!document.hidden;
      // Wait for recorder chunks to reach the durable queue, not for uploads.
      // A new try-on or a background transition cancels this delayed opening.
      void (stopped??Promise.resolve()).then(async()=>{
        if(!canOpen())return;
        const module=await import('./tryon-completion');if(!canOpen())return;
        completionModule=module;module.openTryonCompletion(id,{isCurrent});
      }).catch(errorToast);
    }
    void releaseSession.then(()=>api<Me>('/api/me')).then(value=>{me=value;refresh();scheduleTasks();}).catch(()=>{});
  }
  function scheduleTasks(){clearTimeout(taskTimer);taskTimer=window.setTimeout(()=>void updateTasks().catch(()=>{}),400);}
  async function updateTasks(){
    if(document.hidden||state!=='idle')return;
    const pending=await pendingUploads();
    const items=await api<Tryon[]>('/api/tryons');
    const ids=new Set(pending.filter(p=>p.state!=='recording').map(p=>p.id));
    for(const item of items)if(['saving','processing'].includes(item.status))ids.add(item.id);
    const badge=$('save-badge'),retry=pending.some(p=>p.state==='retry');badge.hidden=!ids.size;badge.textContent=` · ${retry?'待续传':'保存中'} ${ids.size}`;
    if($<HTMLDialogElement>('library').open&&libraryTab==='videos')renderVideos($('library-list'),items,pending,scheduleTasks);
  }
  $('resume-output').onclick=()=>void outputPlayback?.resumeFromGesture();
  $('open-camera').onclick=()=>{visits.track('camera_request');void openCamera().catch(errorToast);};
  $('business-contact').onclick=()=>{visits.track('business_open');openBusiness();};
  $('share-tryon').onclick=()=>{
    if(state!=='idle'||posterOpening)return;
    visits.track('promotion_open');
    posterOpening=true;refresh();
    void import('./promo-poster').then(module=>{if(state==='idle')return module.openPromotionPoster();}).catch(errorToast).finally(()=>{posterOpening=false;refresh();});
  };
  $('close-business').onclick=()=>$<HTMLDialogElement>('business-dialog').close();
  $('flip').onclick=()=>{visits.track('camera_request');const next=facing==='user'?'environment':'user';void(async()=>{if(state!=='idle')await finish(true);await pendingCaptureStop?.catch(()=>{});await releaseSession.catch(()=>{});facing=next;await openCamera();})().catch(errorToast);};
  primary.onclick=()=>{if(state!=='idle')void finish(true);else try{visits.track('start_click');start();}catch(error){errorToast(error);}};
  let pendingUpload:File|null=null;
  const imageUploadInput=$<HTMLInputElement>('upload-2d'),uploadCategoryDialog=$<HTMLDialogElement>('upload-category-dialog');
  const openImageUpload=()=>{if(state==='idle'){visits.track('upload_open');imageUploadInput.click();}};
  $('upload-2d-button').onclick=openImageUpload;
  $('upload-3d-button').onclick=openImageUpload;
  $('cancel-upload').onclick=()=>uploadCategoryDialog.close();
  uploadCategoryDialog.onclose=()=>{pendingUpload=null;imageUploadInput.value='';};
  imageUploadInput.onchange=event=>{const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;if(file.size>20*1024*1024){toast('图片不能超过 20 MB。');imageUploadInput.value='';return;}pendingUpload=file;uploadCategoryDialog.showModal();};
  uploadCategoryDialog.querySelectorAll<HTMLButtonElement>('[data-upload-category]').forEach(button=>button.onclick=async()=>{
    const file=pendingUpload;if(!file)return;const category=button.dataset.uploadCategory||'unknown';pendingUpload=null;uploadCategoryDialog.close();
    try{setStatus('正在保存衣服…');const data=new FormData();data.append('file',file);if(category!=='unknown')data.append('category',category);const added=await api<Garment>('/api/garments',{method:'POST',body:data});visits.track('upload_success');garments=await api<Garment[]>('/api/garments');selected=added;mode='fixed';renderWardrobe();setStatus('');toast('已保存到我的服装');}catch(error){errorToast(error);setStatus('');}finally{imageUploadInput.value='';}
  });
  async function loadLibrary(){
    const version=++libraryVersion;
    const list=$('library-list');list.innerHTML='';
    if(libraryTab==='garments'){
      const items=(await api<Garment[]>('/api/garments')).filter(x=>x.owned);
      if(version!==libraryVersion)return;
      list.innerHTML=items.length?'':'<p class="empty-list">还没有上传服装</p>';
      for(const item of items){const card=document.createElement('article');card.className='library-card';card.innerHTML=`<img src="${escape(item.imageUrl)}" alt="${escape(item.name)}"><strong>${escape(item.name)}</strong><div class="card-actions"><button data-download>下载素材</button><button data-delete>删除</button></div>`;card.querySelector<HTMLButtonElement>('[data-download]')!.onclick=()=>download(`/api/garments/${item.id}/original`);card.querySelector<HTMLButtonElement>('[data-delete]')!.onclick=()=>{if(confirm('删除这件衣服？'))void api(`/api/garments/${item.id}`,{method:'DELETE'}).then(async()=>{garments=await api<Garment[]>('/api/garments');if(selected?.id===item.id){selected=initialDemo(garments);mode='auto';}renderWardrobe();await loadLibrary();}).catch(errorToast);};list.append(card);}
    }else{
      const [items,pending]=await Promise.all([api<Tryon[]>('/api/tryons'),pendingUploads()]);
      if(version===libraryVersion)renderVideos(list,items,pending,scheduleTasks);
    }
  }
  $('mine').onclick=()=>{if(state!=='idle'){toast('请先结束排队或本次试衣。');return;}visits.track('library_open');libraryTab='videos';$('library-title').textContent='我的视频';document.querySelectorAll<HTMLElement>('[data-tab]').forEach(button=>button.classList.toggle('active',button.dataset.tab==='videos'));$<HTMLDialogElement>('library').showModal();void loadLibrary().catch(errorToast);};
  $('close-library').onclick=()=>$<HTMLDialogElement>('library').close();
  $('library').addEventListener('close',()=>{$('library').querySelectorAll<HTMLVideoElement>('video').forEach(video=>video.pause());});
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button=>button.onclick=()=>{libraryTab=button.dataset.tab!;$('library-title').textContent=libraryTab==='videos'?'我的视频':'我的服装';document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===button));void loadLibrary().catch(errorToast);});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){++completionLaunch;reopenOnVisible=Boolean(camera||cameraOpening);if(state!=='idle')void finish(true);closeCamera();refresh();}
    else if(!document.hidden){
      if(reopenOnVisible){reopenOnVisible=false;void openCamera().catch(()=>{});}else autoCamera();
      void recoverUploads().catch(()=>{});scheduleTasks();
    }
  });
  const cancelOnOrientationChange=()=>{if(state!=='idle')void finish(true);};
  window.addEventListener('orientationchange',cancelOnOrientationChange);
  screen.orientation?.addEventListener('change',cancelOnOrientationChange);
  window.addEventListener('pagehide',()=>{void finish(true);dismissCompletion();closeCamera();});
  window.addEventListener('online',()=>{void recoverUploads().catch(()=>{});scheduleTasks();});
  window.addEventListener('amen:uploads',scheduleTasks);
  const updateQuota=()=>{if(!document.hidden&&state==='idle')void api<Me>('/api/me').then(value=>{me=value;refresh();}).catch(()=>{});};
  window.addEventListener('focus',updateQuota);window.setInterval(updateQuota,30000);
  window.setInterval(()=>{if(!document.hidden&&state==='idle')scheduleTasks();},5000);
  window.addEventListener('pageshow',event=>{if(event.persisted&&!camera)void openCamera().catch(()=>{});});
  renderWardrobe();void recoverUploads().catch(()=>{});scheduleTasks();autoCamera();
  if(new URLSearchParams(location.search).get('contact')==='1')openBusiness();
}
