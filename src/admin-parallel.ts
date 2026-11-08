import {api,escape,date} from './api';
import './admin-parallel.css';

type Overview={projectId:string;providerMode:'disabled'|'mock'|'decart';providerSource?:'shared-tryon'|'independent';liveReady:boolean;paused:boolean;publicOrigin:string|null;activeSessions:number|null;maxConcurrent:number|null;totalBudgetSeconds:number|null;usedSeconds:number|null;remainingSeconds:number|null;dailyBudgetSeconds:number|null;dailyUsedSeconds:number|null;dailyRemainingSeconds:number|null;reservedSeconds:number|null;sessionCount:number|null};
type Session={id:string;status:string;providerMode:string;createdAt:number|null;readyAt:number|null;endedAt:number|null;endReason:string|null;usageSeconds:number|null;look:{direction:string|null;hair:string|null;beauty:string|null;garment:string|null}};
type Clip={state:string;receivedChunks:number|null;totalChunks:number|null;videoUrl:string|null;posterUrl:string|null;durationMs:number|null;complete:boolean};
type Work={id:string;createdAt:number|null;expiresAt:number|null;status:string;shareActive:boolean;original:Clip;result:Clip};
const numbers=(value:number|null)=>value===null?'—':Math.round(value*10)/10;
const labels:Record<string,string>={reserved:'等待连接',connecting:'正在连接',observing:'确认画面',active:'体验中',ended:'已结束'};
const reasons:Record<string,string>={duration_complete:'本局完成',user_end:'用户结束',user_cancelled:'用户取消',admin_end:'管理员结束',budget_limit:'预算到达上限',connection_timeout:'连接超时',startup_timeout:'启动超时',update_timeout:'造型切换超时',server_restart:'服务重启',visibility_hidden:'切至后台'};
const times=(value:number|null)=>value===null?'—':date(value);

export function mountParallelAdmin(root:HTMLElement, options:{isCurrent():boolean}) {
  let destroyed=false,busy=false,loading=false,timer=0,request:AbortController|null=null;
  let videoDialog:HTMLDialogElement|null=null;
  const current=()=>!destroyed&&root.isConnected&&options.isCurrent();
  function failure(message:string){
    if(!current())return;
    root.innerHTML=`<section class="parallel-admin"><div class="parallel-admin-heading"><div><h2>平行的我</h2><p>独立项目管理</p></div></div><div class="parallel-admin-error" role="status"><strong>暂时无法读取独立项目</strong><p>${escape(message)}</p><button type="button" data-retry>重新连接</button></div></section>`;
    root.querySelector<HTMLButtonElement>('[data-retry]')!.onclick=()=>void refresh();
  }
  function render(overview:Overview,sessions:Session[],works:Work[]){
    const mode=overview.providerMode==='decart'?(overview.liveReady?'真实云端已配置':'真实云端尚未启用'):overview.providerMode==='mock'?'本地模拟模式':'等待独立云端配置';
    root.innerHTML=`<section class="parallel-admin"><div class="parallel-admin-heading"><div><h2>平行的我</h2><p>独立项目 · 与 1➕衣 共用管理入口</p></div><div class="parallel-admin-actions">${overview.publicOrigin?`<a href="${escape(overview.publicOrigin)}" target="_blank" rel="noopener noreferrer">打开项目</a>`:''}<button type="button" data-refresh>刷新</button><button type="button" data-pause class="parallel-admin-primary">${overview.paused?'恢复新体验':'暂停新体验'}</button></div></div><p class="parallel-admin-state"><span class="parallel-admin-dot"></span>服务已连接 · ${overview.paused?'新体验已暂停':'允许新体验接入'} · ${mode}</p><div class="parallel-admin-metrics"><article><span>正在体验</span><strong>${numbers(overview.activeSessions)} <small>/ ${numbers(overview.maxConcurrent)}</small></strong><p>暂停接入不会中断进行中的体验</p></article><article><span>独立预算已用</span><strong>${numbers(overview.usedSeconds)} <small>秒</small></strong><p>总上限 ${numbers(overview.totalBudgetSeconds)} 秒</p></article><article><span>可用生成额度</span><strong>${numbers(overview.remainingSeconds)} <small>秒</small></strong><p>已预留 ${numbers(overview.reservedSeconds)} 秒</p></article><article><span>今日生成</span><strong>${numbers(overview.dailyUsedSeconds)} <small>秒</small></strong><p>每日上限 ${numbers(overview.dailyBudgetSeconds)} 秒</p></article></div><p class="parallel-admin-note">独立服务、身份与数据；这里的用量仅属于“平行的我”。原片与效果片分别保存，只有完整上传后才显示可播放。恢复接入不会配置密钥或绕过本项目预算要求。</p><div class="parallel-admin-list-heading"><h3>最近体验</h3><span>共 ${numbers(overview.sessionCount)} 场 · 每 5 秒刷新</span></div><div class="parallel-admin-table-wrap"><table class="parallel-admin-table"><thead><tr><th>时间 / 会话</th><th>状态</th><th>方向 / 服装</th><th>生成时长</th><th>操作</th></tr></thead><tbody>${sessions.length?sessions.map(item=>`<tr><td>${times(item.createdAt)}<small>${escape(item.id.slice(0,8))}</small></td><td><span class="parallel-admin-badge">${escape(labels[item.status]||item.status)}</span><small>${escape(item.providerMode==='mock'?'模拟（不产生云端费用）':item.endReason?(reasons[item.endReason]||item.endReason):'')}</small></td><td>${item.look.direction==='feminine'?'女性风格':item.look.direction==='masculine'?'男性风格':'—'}<small>${escape(item.look.garment||'—')}</small></td><td>${numbers(item.usageSeconds)} 秒</td><td>${item.status==='ended'?'—':`<button type="button" data-end="${escape(item.id)}">结束本场</button>`}</td></tr>`).join(''):'<tr><td colspan="5" class="parallel-admin-empty">尚无体验记录</td></tr>'}</tbody></table></div><p class="parallel-admin-feedback" data-feedback role="status" aria-live="polite"></p></section>`;
    root.querySelector<HTMLButtonElement>('[data-refresh]')!.onclick=()=>void refresh();
    root.querySelector<HTMLButtonElement>('[data-pause]')!.onclick=()=>void mutate('/settings','PATCH',{paused:!overview.paused},overview.paused?'已恢复新体验接入':'已暂停新体验接入');
    root.querySelectorAll<HTMLButtonElement>('[data-end]').forEach(button=>button.onclick=()=>{
      if(confirm('结束这场“平行的我”体验？已录制片段仍由体验者浏览器保存。'))void mutate(`/sessions/${button.dataset.end}/end`,'POST',{},'已结束指定体验');
    });
    const saveState=(clip:Clip)=>clip.complete?'完整保存':clip.state==='processing'?'处理中':clip.state==='error'?'保存失败':clip.totalChunks?`已上传 ${numbers(clip.receivedChunks)} / ${numbers(clip.totalChunks)} 段`:'等待上传';
    root.querySelector('[data-feedback]')!.insertAdjacentHTML('beforebegin',`<section class="parallel-admin-works"><div class="parallel-admin-list-heading"><h3>作品视频</h3><span>原片与效果片分别保存 · 最近 20 条</span></div><div class="parallel-admin-table-wrap"><table class="parallel-admin-table"><thead><tr><th>时间</th><th>原视频</th><th>效果视频</th><th>操作</th></tr></thead><tbody>${works.length?works.map(work=>`<tr><td>${times(work.createdAt)}<small>${escape(work.id.slice(0,8))}</small></td><td>${saveState(work.original)}${work.original.videoUrl?`<small><a href="${escape(work.original.videoUrl)}?download=1">下载原片</a></small>`:''}</td><td>${saveState(work.result)}${work.result.videoUrl?`<small><a href="${escape(work.result.videoUrl)}?download=1">下载效果片</a></small>`:''}</td><td><div class="parallel-work-actions"><button type="button" data-view-work="${escape(work.id)}">查看对比</button>${work.shareActive?`<button type="button" data-revoke-work="${escape(work.id)}">关闭分享</button>`:''}<button type="button" data-delete-work="${escape(work.id)}">永久删除</button></div></td></tr>`).join(''):'<tr><td colspan="4" class="parallel-admin-empty">尚无作品录像</td></tr>'}</tbody></table></div></section>`);
    root.querySelectorAll<HTMLButtonElement>('[data-view-work]').forEach(button=>button.onclick=()=>openWork(works.find(work=>work.id===button.dataset.viewWork)!));
    root.querySelectorAll<HTMLButtonElement>('[data-revoke-work]').forEach(button=>button.onclick=()=>void mutate(`/works/${button.dataset.revokeWork}/share/revoke`,'POST',{},'已关闭此作品的公开分享'));
    root.querySelectorAll<HTMLButtonElement>('[data-delete-work]').forEach(button=>button.onclick=()=>{if(confirm('永久删除这条“平行的我”作品的原片和效果片？分享链接也会立即失效。'))void mutate(`/works/${button.dataset.deleteWork}`,'DELETE',{},'作品已永久删除');});
    if(overview.providerSource==='shared-tryon'){
      root.querySelector('.parallel-admin-state')!.append(document.createTextNode(' · 共用 1➕衣 云端密钥与额度'));
      root.querySelector('.parallel-admin-note')!.textContent='两个项目的身份、业务数据和录像独立保存；云端密钥与 1➕衣 共用，并统一计入每把密钥的 450 秒累计截止。此页仅统计“平行的我”，另受本项目 900 秒验证预算限制。';
    }
  }
  function closeWork(){if(!videoDialog)return;videoDialog.querySelectorAll('video').forEach(video=>video.pause());videoDialog.close();videoDialog.remove();videoDialog=null;}
  function openWork(work:Work){
    closeWork();videoDialog=document.createElement('dialog');videoDialog.className='parallel-work-dialog';
    const clip=(label:string,item:Clip)=>`<section><h3>${label}</h3>${item.videoUrl?`<video src="${escape(item.videoUrl)}" ${item.posterUrl?`poster="${escape(item.posterUrl)}"`:''} controls playsinline preload="metadata"></video>`:'<p class="parallel-work-placeholder">尚未完整保存</p>'}</section>`;
    videoDialog.innerHTML=`<header><h2>平行的我 · 视频对比</h2><button type="button" aria-label="关闭视频对比">×</button></header><div class="parallel-work-videos">${clip('原视频',work.original)}${clip('效果视频',work.result)}</div>`;
    videoDialog.querySelector('button')!.onclick=closeWork;videoDialog.addEventListener('cancel',event=>{event.preventDefault();closeWork();});document.body.append(videoDialog);videoDialog.showModal();
  }
  async function refresh(){
    if(!current()||loading||busy)return;
    loading=true;request=new AbortController();
    try{
      const [overview,data,workData]=await Promise.all([api<Overview>('/api/admin/parallel-self/overview',{signal:request.signal}),api<{sessions:Session[]}>('/api/admin/parallel-self/sessions?limit=20',{signal:request.signal}),api<{works:Work[]}>('/api/admin/parallel-self/works?limit=20',{signal:request.signal})]);
      if(current())render(overview,data.sessions,workData.works);
    }catch(error){if(current())failure(error instanceof Error?error.message:'连接失败，请稍后重试。');}
    finally{loading=false;request=null;}
  }
  async function mutate(path:string,method:string,body:unknown,message:string){
    if(!current()||busy)return;
    busy=true;root.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=true);
    const feedback=root.querySelector<HTMLElement>('[data-feedback]');if(feedback)feedback.textContent='正在处理…';
    try{
      await api('/api/admin/parallel-self'+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      busy=false;await refresh();
      const output=root.querySelector<HTMLElement>('[data-feedback]');if(current()&&output)output.textContent=message;
    }catch(error){if(current()&&feedback){feedback.textContent=error instanceof Error?error.message:'操作失败';feedback.dataset.error='true';}}
    finally{busy=false;if(current())root.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=false);}
  }
  root.innerHTML='<p class="parallel-admin-loading" role="status">正在连接平行的我…</p>';
  void refresh();timer=window.setInterval(()=>{if(!document.hidden)void refresh();},5000);
  return {destroy(){destroyed=true;window.clearInterval(timer);request?.abort();closeWork();}};
}
