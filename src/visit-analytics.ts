// Small first-party action batches. No URL, media, IP, device ID or free text.
import {browserUuid} from './browser-uuid.ts';
export type VisitAction='camera_request'|'camera_ready'|'camera_failed'|'garment_select'|'start_click'|'library_open'|'promotion_open'|'business_open'|'upload_open'|'upload_success'|'share_play'|'share_tryon_click';
type Action={id:string;type:VisitAction|'page_view'};
type Options={fetcher?:typeof fetch;uuid?:()=>string;hidden?:()=>boolean;listen?:boolean};
export function createVisitAnalytics(page:'home'|'share',options:Options={}){
  const fetcher=options.fetcher??globalThis.fetch.bind(globalThis),uuid=options.uuid??browserUuid;
  const hidden=options.hidden??(()=>document.hidden);
  let visitId='',pageView:Action;
  try{visitId=uuid();pageView={id:uuid(),type:'page_view'};}catch{return{start(){},track(_type:VisitAction){},setPaused(_value:boolean){},flush:async()=>{},pulse:async()=>{},dispose(){}};}
  let queue:Action[]=[pageView],started=false,paused=false,disposed=false,inFlight=false,failures=0,blocked=false,seenVisible=false,acknowledged=false,timer:ReturnType<typeof setTimeout>|undefined;
  let controller:AbortController|null=null;
  let presenceController:AbortController|null=null;
  const clear=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;};
  const schedule=()=>{
    clear();if(!started||disposed||paused||hidden()||!queue.length||inFlight||blocked)return;
    timer=setTimeout(()=>void flush(),failures>=4?60000:failures?Math.min(15000,1000*2**failures):1200);
  };
  async function flush(leaving=false){
    if(!hidden())seenVisible=true;
    clear();if(!started||disposed||!seenVisible||!queue.length||(!leaving&&(inFlight||paused||hidden())))return;
    // A navigation can arrive while the previous batch is still in flight.
    // Resend its stable IDs together with the latest click using keepalive.
    // Server deduplication makes an already accepted previous batch harmless.
    if(leaving&&inFlight)controller?.abort();
    const batch=queue.slice(0,19),events=[pageView,...batch.filter(e=>e.id!==pageView.id)];
    const active=new AbortController();controller=active;inFlight=true;
    const timeout=setTimeout(()=>active.abort(),5000);
    try{
      const response=await fetcher('/api/analytics/events',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitId,page,events}),keepalive:leaving,signal:active.signal});
      if(response.ok){acknowledged=true;const ids=new Set(batch.map(e=>e.id));queue=queue.filter(e=>!ids.has(e.id));if(controller===active){failures=0;blocked=false;}}
      else if(controller===active){if([400,401,403,404,409,410].includes(response.status))blocked=true;else failures++;}
    }catch{if(controller===active&&!paused)failures++;}
    finally{clearTimeout(timeout);if(controller===active){controller=null;inFlight=false;schedule();}}
  }
  // A tiny, separate presence packet is sent only by visible pages. It never
  // creates a page view or an action and keeps live counts useful during video.
  async function pulse(){
    if(!started||disposed||hidden()||!acknowledged||presenceController)return;
    const active=new AbortController();presenceController=active;
    const timeout=setTimeout(()=>active.abort(),2500);
    try{await fetcher('/api/analytics/presence',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitId,page}),signal:active.signal});}catch{/* Presence is optional; retry on the next low-frequency tick. */}
    finally{clearTimeout(timeout);if(presenceController===active)presenceController=null;}
  }
  function start(){if(disposed||started)return;started=true;void flush();}
  function track(type:VisitAction){
    if(disposed||queue.length>=100)return;
    try{queue.push({id:uuid(),type});}catch{return;}
    schedule();
  }
  function setPaused(value:boolean){if(value===paused)return;paused=value;if(value){clear();controller?.abort();}else schedule();}
  const onResume=()=>{if(!hidden())seenVisible=true;failures=0;blocked=false;schedule();void pulse();};
  const onHide=()=>{if(hidden()){presenceController?.abort();void flush(true);}else onResume();};
  const onPageHide=()=>{presenceController?.abort();void flush(true);};
  const listen=options.listen!==false;
  const presenceTimer=listen?setInterval(()=>void pulse(),30000):undefined;
  if(listen){document.addEventListener('visibilitychange',onHide);window.addEventListener('pagehide',onPageHide);window.addEventListener('pageshow',onResume);window.addEventListener('online',onResume);}
  function dispose(){disposed=true;clear();controller?.abort();presenceController?.abort();if(presenceTimer!==undefined)clearInterval(presenceTimer);queue=[];if(listen){document.removeEventListener('visibilitychange',onHide);window.removeEventListener('pagehide',onPageHide);window.removeEventListener('pageshow',onResume);window.removeEventListener('online',onResume);}}
  return{start,track,setPaused,flush,pulse,dispose};
}
