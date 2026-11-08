import QRCode from 'qrcode';
import {api} from './api';
import {loadPosterImage} from './brand-poster';
import {promotionUrl,agentPromotionUrl} from './promotion-links';
import {prepareImageExport,createImageShareController,openImageSaveView,type PreparedImage} from './image-sharing';
import './image-sharing.css';
import './promo-poster.css';
export {promotionUrl} from './promotion-links';

export async function createPromotionPoster(url:string):Promise<HTMLCanvasElement>{
  const [logo, artwork]=await Promise.all([loadPosterImage('/brand/logo.svg'),loadPosterImage('/brand/icon.svg')]);
  const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1620;
  const context=canvas.getContext('2d');if(!context)throw new Error('当前浏览器无法生成海报。');
  context.fillStyle='#fff';context.fillRect(0,0,1080,1620);
  context.drawImage(logo,64,52,320,120);
  context.fillStyle='#151515';context.font='bold 108px system-ui, sans-serif';
  context.fillText('今天，换个样',64,322,952);
  context.fillStyle='#fff1e8';context.fillRect(64,406,952,747);
  context.drawImage(artwork,279,490,522,522);
  context.fillStyle='#ff641f';context.fillRect(64,1232,540,16);
  context.fillStyle='#151515';context.font='bold 68px system-ui, sans-serif';
  context.fillText('扫码试衣',64,1400,540);
  const qr=document.createElement('canvas');
  try{
    await QRCode.toCanvas(qr,url,{errorCorrectionLevel:'M',margin:4,width:328,color:{dark:'#151515',light:'#ffffff'}});
    context.imageSmoothingEnabled=false;context.drawImage(qr,688,1232);return canvas;
  }catch(error){canvas.width=0;canvas.height=0;throw error;}
  finally{qr.width=0;qr.height=0;}
}

type PosterSource={kind:'visitor'}|{kind:'agent';id:string;isCurrent:()=>boolean};
type SavedAgent={id:string;code:string;name:string;active:boolean};
let currentPoster:{key:string;dialog:HTMLDialogElement;close():void}|null=null;
export function openPromotionPoster():Promise<void>{return openPoster({kind:'visitor'});}
export function openAgentPromotionPoster(agentId:string,isCurrent:()=>boolean=()=>true):Promise<void>{
  if(!isCurrent())return Promise.resolve();
  return openPoster({kind:'agent',id:agentId,isCurrent});
}
async function openPoster(source:PosterSource):Promise<void>{
  const key=source.kind==='visitor'?'visitor':`agent:${source.id}`;
  if(currentPoster?.dialog.open&&currentPoster.key===key){currentPoster.dialog.focus();return;}
  currentPoster?.close();
  const dialog=document.createElement('dialog');dialog.className='share-dialog promo-dialog';
  dialog.innerHTML='<header><h2></h2><button type="button" class="icon-button" data-close aria-label="关闭">×</button></header><p class="promo-agent-name" data-agent-name hidden></p><div class="poster-preview"><p class="poster-save-help" data-loading>正在生成试衣海报…</p></div><p class="poster-preview-error" data-error role="status" hidden></p><div class="share-actions">'+(source.kind==='agent'?'<button type="button" class="primary" data-save-agent disabled>保存图片</button>':'<button type="button" class="primary" data-poster disabled>分享海报</button>')+'</div>';
  dialog.querySelector('h2')!.textContent=source.kind==='agent'?'代理专属海报':'分享试衣';
  document.body.append(dialog);dialog.showModal();
  const controller=new AbortController();let active=true,prepared:PreparedImage|null=null;
  let imageShare:ReturnType<typeof createImageShareController>|null=null,saveView:ReturnType<typeof openImageSaveView>|null=null;
  const action=dialog.querySelector<HTMLButtonElement>('[data-poster],[data-save-agent]')!;
  const cleanup=()=>{if(!active)return;active=false;controller.abort();imageShare?.dispose();saveView?.close();prepared?.dispose();dialog.querySelector<HTMLImageElement>('.poster-preview img')?.removeAttribute('src');dialog.remove();if(currentPoster?.dialog===dialog)currentPoster=null;};
  const close=()=>{if(dialog.open)dialog.close();cleanup();};
  currentPoster={key,dialog,close};
  const isActive=()=>{if(!active)return false;if(source.kind==='agent'&&!source.isCurrent()){close();return false;}return true;};
  dialog.querySelector<HTMLButtonElement>('[data-close]')!.onclick=close;
  dialog.addEventListener('close',cleanup,{once:true});dialog.addEventListener('cancel',cleanup,{once:true});
  const showImage=()=>{
    if(!isActive()||!prepared)return;
    if(saveView?.dialog.open){saveView.dialog.focus();return;}
    saveView=openImageSaveView(prepared,{mode:source.kind==='agent'?'save':'share',title:source.kind==='agent'?'保存代理海报':'分享试衣海报',showDownload:source.kind==='agent',alt:'1➕衣扫码试衣推广海报',onClose:()=>{saveView=null;}});
  };
  try{
    let link:string,filename='1加衣-扫码试衣海报.png';
    if(source.kind==='agent'){
      const response=await api<{items:SavedAgent[]}>('/api/admin/agents',{signal:controller.signal});
      if(!isActive())return;
      const saved=response.items.find(agent=>agent.id===source.id);
      link=agentPromotionUrl(location.origin,saved);
      const context=dialog.querySelector<HTMLElement>('[data-agent-name]')!;
      context.hidden=false;context.textContent=`${saved!.name} · 专属推广海报`;
      filename=`1加衣-代理-${saved!.code}-海报.png`;
    }else{
      const contact=await api<{referralPath:string|null}>('/api/business-contact',{signal:controller.signal});
      if(!isActive())return;
      link=promotionUrl(location.origin,contact.referralPath);
    }
    const canvas=await createPromotionPoster(link);
    if(!isActive()){canvas.width=0;canvas.height=0;return;}
    try{prepared=await prepareImageExport(canvas,filename);}finally{canvas.width=0;canvas.height=0;}
    if(!isActive()){prepared.dispose();return;}
    const picture=document.createElement('img');picture.src=prepared.previewUrl;picture.alt='1➕衣扫码试衣推广海报';picture.draggable=false;
    await picture.decode();
    if(!isActive()){picture.removeAttribute('src');return;}
    dialog.querySelector('.poster-preview')!.replaceChildren(picture);
    if(source.kind==='agent')action.onclick=showImage;
    else{
      imageShare=createImageShareController({file:prepared.file,onSaveView:showImage,onBusyChange:busy=>{action.disabled=busy;action.textContent=busy?'等待系统分享…':'分享海报';}});
      action.onclick=()=>{if(isActive())void imageShare?.share();};
    }
    action.disabled=false;
  }catch(error){
    if(!isActive())return;
    prepared?.dispose();prepared=null;
    dialog.querySelector('[data-loading]')?.remove();const message=dialog.querySelector<HTMLElement>('[data-error]')!;
    message.hidden=false;message.textContent=source.kind==='agent'&&error instanceof Error?error.message:'海报暂时无法生成，请关闭后重试。';
  }
}
