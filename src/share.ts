import './share.css';
import {createPairedView,type PairClip} from './paired-view';
import {createVisitAnalytics} from './visit-analytics';

type SharedVideo={garmentName:string;createdAt:number;expiresAt:number;tryOnUrl?:string;original:PairClip;result:PairClip};
const app=document.getElementById('share-app')!;
const visits=createVisitAnalytics('share');
app.addEventListener('click',event=>{
  if(!view||!(event.target instanceof Element))return;
  const play=event.target.closest<HTMLButtonElement>('.paired-play');
  if(play&&!play.disabled&&play.getAttribute('aria-pressed')!=='true')visits.track('share_play');
  if(event.target.closest('.try-button'))visits.track('share_tryon_click');
},true);
const token=decodeURIComponent(location.pathname.match(/^\/s\/([^/]+)$/)?.[1]||'');
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
let view:ReturnType<typeof createPairedView>|null=null,timer=0,closed=false,unavailable=false,failures=0,expiresAt=Infinity;
// Only same-origin, server-provided referral paths are allowed in navigation.
const homePath=(value?:string)=>value&&/^\/a\/[A-Za-z0-9_-]+$/.test(value)?value:'/';
function render(data:SharedVideo){
  const home=escape(homePath(data.tryOnUrl));
  app.innerHTML=`<main class="share-shell"><header class="share-brand"><a href="${home}" aria-label="1➕衣首页"><img src="/brand/logo.svg" width="144" height="54" alt="1➕衣"></a></header><section data-pair></section><footer class="share-footer"><a class="try-button" href="${home}">我也来试衣 <span aria-hidden="true">↗</span></a></footer></main>`;
  view=createPairedView(app.querySelector<HTMLElement>('[data-pair]')!,data);document.title='试穿对比 · 1➕衣';
}
function expired(message='这个分享链接不存在或已失效。'){
  unavailable=true;view?.destroy();view=null;clearTimeout(timer);
  app.innerHTML=`<main class="share-shell expired"><header class="share-brand"><a href="/" aria-label="1➕衣首页"><img src="/brand/logo.svg" width="144" height="54" alt="1➕衣"></a></header><section><h1>视频暂时无法查看</h1><p>${escape(message)}</p><a class="try-button" href="/">我也来试衣 <span aria-hidden="true">↗</span></a></section></main>`;
}
async function refresh(){
  clearTimeout(timer);
  if(closed||unavailable)return;
  if(!token||Date.now()>=expiresAt){expired();return;}
  try{
    const response=await fetch(`/api/shares/${encodeURIComponent(token)}`,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(20000)});
    if(closed)return;
    if(!response.ok){
      if(response.status>=500||response.status===429)throw new Error('network');
      let message='这个分享链接不存在或已失效。';try{message=(await response.json()).message||message;}catch{}expired(message);return;
    }
    const data=await response.json() as SharedVideo;if(closed)return;
    expiresAt=data.expiresAt;if(Date.now()>=expiresAt){expired();return;}visits.start();
    if(view)view.update(data);else render(data);failures=0;
  }catch{
    failures++;
    if(!view)app.innerHTML='<main class="share-shell"><header class="share-brand"><img src="/brand/logo.svg" width="144" height="54" alt="1➕衣"></header><p role="status">网络暂时无法连接，正在重试…</p></main>';
  }finally{
    // Network failures retain the existing videos and retry with bounded backoff.
    if(!closed&&!unavailable)timer=window.setTimeout(()=>void refresh(),Math.min(Math.min(30000,8000*Math.max(1,failures)),Math.max(250,expiresAt-Date.now())));
  }
}
window.addEventListener('pagehide',()=>{closed=true;clearTimeout(timer);view?.pause();});
window.addEventListener('pageshow',event=>{if(event.persisted){closed=false;void refresh();}});
void refresh();
