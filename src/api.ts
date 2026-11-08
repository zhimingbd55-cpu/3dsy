export type Garment = {id:string;name:string;category:string;categoryKnown?:boolean;owned:boolean;published:boolean;position:number;assetType:'2d'|'3d';hasModel:boolean;imageUrl:string|null;thumbnailUrl?:string|null;modelUrl:string|null;createdAt:number;visitorId?:string;details?:string};
export type Recording = {id:string;kind:'original'|'result';status:string;duration:number|null;url:string|null;poster:string|null;receivedChunks:number;expectedChunks:number|null;bytes:number;lastUploadAt:number|null;waitingForUpload:boolean;error:string|null;retryable:boolean;recovered?:boolean;recoveryAvailable?:boolean};
export type PerformanceSummary={capturedAt:number;samples:number;sentFps:number|null;receivedFps:number|null;rttMs:number|null;droppedFrames:number|null;cpuLimitedSamples:number;bandwidthLimitedSamples:number;sendBitrateBps:number|null;receiveBitrateBps:number|null;availableOutgoingBps:number|null;freezeMs:number|null;decodeMs:number|null;sendQueueDelayMs:number|null;lossFraction:number|null;cameraFps:number|null;presentedFps:number|null;paintP95Ms:number|null;presentedDrops:number|null;glassToGlassMs:number|null;relayPathSamples:number;directPathSamples:number;qualityMode:'standard'|'fluid'|'smooth'|'reduced';fluidReason:'cpu'|'upstream'|'device'|null;senderParametersApplied:boolean|null;configVersion?:string|null;initialProfile?:string|null;finalProfile?:string|null;actualSendWidth?:number|null;actualSendHeight?:number|null;actualSimulcastLayers?:number|null;targetSendBitrateBps?:number|null;actualCameraWidth?:number|null;actualCameraHeight?:number|null;actualCameraFps?:number|null;cameraConstraintResult?:'matched'|'adjusted'|'fallback'|'unknown'|null;previewFps?:number|null;previewLongGapMs?:number|null;outputStallMs?:number|null;outputStallCount?:number|null;playbackRecoveryAttempts?:number|null;playbackRecoveries?:number|null};
export type Tryon = {id:string;visitorId:string;garmentName:string;target:'top'|'bottom'|'outfit'|'accessory'|null;createdAt:number;admittedAt:number|null;queue:{ahead:number;waiting:number;active:number;concurrent:number}|null;expiresAt:number;status:string;interrupted:boolean;userHiddenAt?:number|null;shareActive?:boolean;performance?:PerformanceSummary|null;generationSeconds:number;error:string|null;startup?:{preparationMs:number;countdownMs:number;countdownVersion?:number;readyAt:number|null;connectionStartedAt:number|null;imageAccepted:boolean;imageAcceptedAt:number|null;generationStartedAt:number|null;firstFrameAt:number|null;recordingStartedAt:number|null;stableVideoAt?:number|null;stableWindowMs?:number|null;stableFrames?:number|null;stabilityMode?:string|null;promptVersion?:number|null;promptSnapshot?:string|null;referenceHash?:string|null};recordings:Recording[]};
export type Me = {consented:boolean;remaining:number;dailyLimit:number;duration:number;available:boolean;storageFull:boolean};
export class ApiError extends Error { constructor(message:string,public status:number){super(message);} }
export async function api<T>(url:string,options:RequestInit={}):Promise<T> {
  const response=await fetch(url,{credentials:'same-origin',...options,signal:options.signal||AbortSignal.timeout(60000)});
  if(!response.ok){let message='操作失败，请重试。';try{message=(await response.json()).message||message;}catch{}throw new ApiError(message,response.status);}
  return response.status===204?undefined as T:response.json();
}
export const post=<T>(url:string,body:unknown={})=>api<T>(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
export const patch=<T>(url:string,body:unknown)=>api<T>(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
export const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const date=(time:number)=>new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(time);
let toastTimer=0;
export function toast(message:string){
  // Dialogs may be removed after closing. Recreate their transient message
  // node instead of retaining a missing global element on the next action.
  const el=document.getElementById('toast')??Object.assign(document.createElement('div'),{id:'toast'});
  el.setAttribute('role','status');el.setAttribute('aria-live','polite');
  const parent=Array.from(document.querySelectorAll('dialog[open]')).at(-1)||document.body;
  if(el.parentElement!==parent)parent.append(el);el.textContent=message;el.classList.add('visible');
  clearTimeout(toastTimer);toastTimer=window.setTimeout(()=>el.classList.remove('visible'),4500);
}
export const errorToast=(error:unknown)=>toast(error instanceof Error?error.message:'操作失败，请重试。');
export function download(url:string){const link=document.createElement('a');link.href=url;link.download='';document.body.append(link);link.click();link.remove();}
export const icons={
  shirt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m8 3 4 2 4-2 5 5-4 3-1-1v11H8V10l-1 1-4-3z"/></svg>',
  camera:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m8 5 1-2h6l1 2h4v15H4V5z"/><circle cx="12" cy="12" r="4"/></svg>',
  flip:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 10a8 8 0 0 1 14-4l2 2M20 3v5h-5M20 14A8 8 0 0 1 6 18l-2-2M4 21v-5h5"/></svg>',
  close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m6 6 12 12M6 18 18 6"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 4v16M4 12h16"/></svg>',
  arrow:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/></svg>',
};
