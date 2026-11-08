import {createBrandPoster} from './brand-poster';
import {createPairedView,type PairClips} from './paired-view';
import {posterMissingMessage} from './poster-status';
import {prepareImageExport,createImageShareController,openImageSaveView,type PreparedImage} from './image-sharing';
import './image-sharing.css';
import {api,escape,date,errorToast,toast,type Tryon,type Recording} from './api';
import {recoverUploads,pendingUploads,type PendingUpload} from './recorder';
import {savedSummary} from './save-status';

type ShareLink={url:string;expiresAt:number};
export function videoSaveStatus(item:Tryon,pending?:PendingUpload){
  if(item.status==='queued')return '排队中';
  if(item.status==='reserved'||item.status==='connecting')return '连接中';
  if(item.status==='failed'&&!item.generationSeconds)return item.error||'未开始试衣';
  if(item.recordings.find(r=>r.kind==='result')?.status==='ready')return savedSummary(item)!;
  if(pending){
    if(pending.state==='retry')return pending.error==='上传已过期'?'上传已过期':'等待续传';
    if(pending.state==='paused')return '已暂存 · 试衣结束后继续保存';
    if(pending.state==='recording')return '录制中';
    return `正在保存 ${pending.progress}%`;
  }
  const summary=savedSummary(item);if(summary)return summary;
  if(item.recordings.every(r=>r.status==='ready'))return item.interrupted?'已保存中断片段':'已保存';
  if(item.recordings.some(r=>r.status==='ready'))return '部分视频已保存';
  if(['saving','processing'].includes(item.status))return '等待上传';
  return '未完整保存';
}
async function posterCanvas(link:ShareLink,item:Tryon,original?:Recording,result?:Recording,pending?:PendingUpload){
  return createBrandPoster(link.url,{url:original?.poster||null,missing:posterMissingMessage('original',item.status,original,pending)},{url:result?.poster||null,missing:posterMissingMessage('result',item.status,result,pending)});
}
function copyText(value:string){
  if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(value);
  const input=document.createElement('textarea');input.value=value;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();const copied=document.execCommand('copy');input.remove();return copied?Promise.resolve():Promise.reject(new Error('复制失败，请长按链接复制。'));
}
let activeShare:{tryonId:string;dialog:HTMLDialogElement;close():void}|null=null;
export async function openShare(link:ShareLink,tryonId:string){
  if(activeShare?.dialog.open&&activeShare.tryonId===tryonId){activeShare.dialog.focus();return;}
  activeShare?.close();
  const dialog=document.createElement('dialog');dialog.className='share-dialog';
  dialog.innerHTML=`<header><h2>分享视频</h2><button class="icon-button" data-close aria-label="关闭">×</button></header><p class="share-disclosure">此分享将展示原视频和试穿成片，持有链接的人可观看。</p><div class="poster-preview"><p class="poster-save-help" data-poster-loading>正在读取最新视频封面并生成海报…</p></div><p class="poster-preview-error" data-poster-error hidden></p><small class="share-expiry">有效期至 ${date(link.expiresAt)}</small><div class="share-actions"><button class="secondary" data-save disabled>保存海报</button><button class="primary" data-poster disabled>分享海报</button><button class="secondary" data-copy>复制链接</button></div>`;
  document.body.append(dialog);dialog.showModal();
  let active=true,image:PreparedImage|null=null,saveView:ReturnType<typeof openImageSaveView>|null=null,shareController:ReturnType<typeof createImageShareController>|null=null;
  const cleanup=()=>{if(!active)return;active=false;shareController?.dispose();saveView?.close();dialog.querySelector<HTMLImageElement>('.poster-preview img')?.removeAttribute('src');image?.dispose();if(activeShare?.dialog===dialog)activeShare=null;dialog.remove();};
  const close=()=>{if(dialog.open)dialog.close();cleanup();};
  activeShare={tryonId,dialog,close};
  dialog.querySelector<HTMLButtonElement>('[data-close]')!.onclick=close;dialog.addEventListener('close',cleanup,{once:true});
  dialog.addEventListener('cancel',()=>cleanup(),{once:true});
  const copy=dialog.querySelector<HTMLButtonElement>('[data-copy]')!;
  copy.onclick=()=>void copyText(link.url).then(()=>toast('分享链接已复制')).catch(errorToast);
  const preview=dialog.querySelector<HTMLElement>('.poster-preview')!,saveButton=dialog.querySelector<HTMLButtonElement>('[data-save]')!,shareButton=dialog.querySelector<HTMLButtonElement>('[data-poster]')!;
  const loading=dialog.querySelector<HTMLElement>('[data-poster-loading]')!,errorBox=dialog.querySelector<HTMLElement>('[data-poster-error]')!;
  const showSaveView=(mode:'save'|'share'='save')=>{
    if(!active||!image||image.disposed)return;
    if(saveView?.dialog.open){saveView.dialog.focus();return;}
    saveView=openImageSaveView(image,{mode,onClose:()=>{saveView=null;}});
  };
  saveButton.onclick=()=>showSaveView();
  try{
    const [item,pendingItems]=await Promise.all([api<Tryon>(`/api/tryons/${tryonId}`),pendingUploads()]);
    if(!active)return;
    const original=item.recordings.find(r=>r.kind==='original'),result=item.recordings.find(r=>r.kind==='result'),pending=pendingItems.find(p=>p.id===tryonId);
    const canvas=await posterCanvas(link,item,original,result,pending);
    try{if(!active)return;image=await prepareImageExport(canvas,`1➕衣-${item.id.slice(0,8)}.png`);}
    finally{canvas.width=0;canvas.height=0;}
    if(!active){image?.dispose();return;}
    const poster=document.createElement('img');poster.src=image.previewUrl;poster.alt='1➕衣分享海报';poster.decoding='async';
    await poster.decode();
    if(!active){poster.removeAttribute('src');image.dispose();return;}
    preview.replaceChildren(poster);loading.remove();
    shareController=createImageShareController({file:image.file,onSaveView:()=>showSaveView('share'),onBusyChange:busy=>{shareButton.disabled=busy;shareButton.textContent=busy?'等待系统分享…':'分享海报';}});
    shareButton.onclick=()=>{void shareController?.share();};
    saveButton.disabled=false;shareButton.disabled=false;
  }catch(error){
    if(!active)return;
    image?.dispose();image=null;
    loading.remove();errorBox.hidden=false;errorBox.textContent='海报生成失败，请关闭后重试。';
    saveButton.disabled=true;shareButton.disabled=true;
    if(error instanceof Error)console.warn('Share poster generation failed',error.message);
  }
}
function clipData(item:Tryon):PairClips{
  const clip=(kind:'original'|'result')=>{const recording=item.recordings.find(r=>r.kind===kind);return {videoUrl:recording?.url||null,posterUrl:recording?.poster||null,status:recording?.status||item.status,waitingForUpload:recording?.waitingForUpload||false};};
  return {original:clip('original'),result:clip('result')};
}
let activeWatch:HTMLDialogElement|null=null;
export async function openWatch(tryonId:string){
  if(activeWatch?.open){activeWatch.focus();return;}
  const dialog=document.createElement('dialog');dialog.className='paired-watch-dialog';dialog.innerHTML='<header><h2>我的试穿对比</h2><button type="button" data-close aria-label="关闭观看">×</button></header><div data-pair><p role="status">正在读取视频…</p></div>';
  document.body.append(dialog);dialog.showModal();activeWatch=dialog;
  let active=true,timer=0,view:ReturnType<typeof createPairedView>|null=null;
  const cleanup=()=>{if(!active)return;active=false;clearTimeout(timer);view?.destroy();if(activeWatch===dialog)activeWatch=null;dialog.remove();};
  dialog.querySelector<HTMLButtonElement>('[data-close]')!.onclick=()=>{dialog.close();cleanup();};dialog.addEventListener('close',cleanup,{once:true});dialog.addEventListener('cancel',cleanup,{once:true});
  const refresh=async()=>{
    try{const item=await api<Tryon>(`/api/tryons/${tryonId}`);if(!active)return;const clips=clipData(item);if(view)view.update(clips);else view=createPairedView(dialog.querySelector<HTMLElement>('[data-pair]')!,clips);if(!clips.original.videoUrl&&clips.original.status!=='failed')timer=window.setTimeout(()=>void refresh(),8000);}
    catch(error){if(!active)return;view?.pause();if(!view)dialog.querySelector('[data-pair]')!.textContent=error instanceof Error?error.message:'视频暂时无法读取。';else errorToast(error);}
  };
  await refresh();
}
export function renderVideos(list:HTMLElement,items:Tryon[],pending:PendingUpload[],onChanged:()=>void){
  list.querySelector('.empty-list')?.remove();
  for(const old of list.querySelectorAll<HTMLElement>('[data-video-id]'))if(!items.some(i=>i.id===old.dataset.videoId))old.remove();
  if(!items.length){list.innerHTML='<p class="empty-list">还没有试衣视频</p>';return;}
  for(const item of items){
    let card=list.querySelector<HTMLElement>(`[data-video-id="${item.id}"]`);
    if(!card){card=document.createElement('article');card.className='library-card';card.dataset.videoId=item.id;card.innerHTML=`<div class="video-pending">正在保存</div><strong>${escape(item.garmentName)}</strong><small>${date(item.createdAt)}${item.interrupted?' · 已中断':''}</small><small data-save-state role="status"></small><div class="card-actions"></div>`;list.append(card);}
    const task=pending.find(p=>p.id===item.id),result=item.recordings.find(r=>r.kind==='result');
    card.querySelector('[data-save-state]')!.textContent=videoSaveStatus(item,task);
    const placeholder=card.querySelector('.video-pending');
    if(result?.url&&placeholder){const preview=document.createElement('button');preview.className='library-preview-button';preview.setAttribute('aria-label','播放原视频与试穿成片');preview.onclick=()=>void openWatch(item.id).catch(errorToast);if(result.poster){const cover=document.createElement('img');cover.src=result.poster;cover.alt='试穿成片封面';cover.loading='lazy';preview.append(cover);}const mark=document.createElement('span');mark.className='preview-play';mark.setAttribute('aria-hidden','true');mark.textContent='▶';preview.append(mark);placeholder.replaceWith(preview);}
    else if(placeholder)placeholder.textContent=videoSaveStatus(item,task);
    const cover=card.querySelector<HTMLImageElement>('.library-preview-button img');if(cover&&result?.poster&&cover.getAttribute('src')!==result.poster)cover.src=result.poster;
    const actions=card.querySelector<HTMLElement>('.card-actions')!;
    if(result?.url&&!actions.querySelector('[data-watch]')){const button=document.createElement('button');button.dataset.watch='';button.textContent='观看';button.onclick=()=>void openWatch(item.id).catch(errorToast);actions.prepend(button);}
    if(result?.url&&!actions.querySelector('[data-share]')){const button=document.createElement('button');button.dataset.share='';button.textContent='分享视频';button.onclick=()=>{button.disabled=true;void api<ShareLink>(`/api/tryons/${item.id}/share`,{method:'POST'}).then(link=>openShare(link,item.id)).then(onChanged).catch(errorToast).finally(()=>button.disabled=false);};actions.append(button);}
    if(task?.state==='retry'&&!actions.querySelector('[data-retry]')){const retry=document.createElement('button');retry.dataset.retry='';retry.textContent='继续保存';retry.onclick=()=>void recoverUploads().catch(errorToast);actions.append(retry);}
    if(task?.state!=='retry')actions.querySelector('[data-retry]')?.remove();
  }
}
