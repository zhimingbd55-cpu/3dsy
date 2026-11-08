import {api,escape} from './api';
import './admin-analytics.css';

type Segment='all'|'opened_only'|'no_tryon'|'tried';
type Summary={homeUV:number;homePV:number;shareUV:number;sharePV:number;openedOnlyUV:number;noTryonUV:number;triedUV:number;startClickUV:number;startClicks:number;sessionUV:number;sessions:number;startedUV:number;started:number;endedUV:number;ended:number;savedUV:number;saved:number};
type Visitor={id:string;firstVisitAt:number;lastVisitAt:number;visits:number;actions:Record<string,number>;activeActions:number;tryonCount:number;generationCount:number;endedCount:number;savedPairCount:number;agentName:string|null;stage:string};
type Live={windowSeconds:number;homeActiveUV:number;shareActiveUV:number;activeUV:number;tryingUV:number;tryingSessions:number;serverNow:number};
type Analytics={live?:Live|null;trackingSince:number|null;timezone:string;actionScope?:'all_pages';visitScope?:'page_opened_in_range';range:{days:number;startAt:number;endAt:number;startDay:string;endDay:string};summary:Summary;actions:Array<{type:string;visitors:number;count:number}>;items:Visitor[];total:number;offset:number;limit:number;segment:Segment};
type Options={isCurrent?:()=>boolean};
const labels:Record<string,string>={page_view:'打开页面',camera_request:'主动开启相机',camera_ready:'相机预览就绪',camera_failed:'相机预览失败',garment_select:'选择服装',start_click:'点击开始试衣',library_open:'打开我的视频',promotion_open:'打开推广海报',business_open:'打开商务合作',upload_open:'打开添加服装',upload_success:'服装上传成功',share_play:'分享页播放视频',share_tryon_click:'分享页点击试衣'};
const actionNotes:Record<string,string>={page_view:'首页与分享页合计',camera_request:'用户主动点击',camera_ready:'可自动触发，不算主动点击',camera_failed:'可自动触发，不算主动点击',start_click:'点击发生在倒数前，不等于生成',share_play:'分享页',share_tryon_click:'分享页'};
const stages:Record<string,string>={opened_only:'仅打开页面',interacted:'已有操作',start_clicked:'已点击开始',session_created:'已创建试衣',generated:'已有生成记录',recording_ended:'已有录制结束记录',pair_saved:'已有双片保存'};
const automatic=new Set(['camera_ready','camera_failed']);
const count=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?new Intl.NumberFormat('zh-CN').format(value):'—';
const stamp=(value:number|null)=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(value):'—';
const clockStamp=(value:number)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(value);

/** Read-only admin view. Its request lifetime belongs to the selected tab. */
export function mountAdminAnalytics(root:HTMLElement,options:Options={}){
  let active=true,version=0,days=1,segment:Segment='all',offset=0,total=0,limit=20,busy=false;
  let controller:AbortController|null=null,pollTimer=0,resumeTimer=0,hasData=false,pending=false,lastKey='',lastUpdated=0;
  root.innerHTML=`<section class="analytics-panel" aria-labelledby="analytics-title"><header class="analytics-heading"><div><span class="analytics-eyebrow">访问与使用</span><h2 id="analytics-title">访问统计</h2></div><button type="button" data-analytics-refresh>刷新统计</button></header><p class="analytics-freshness" data-analytics-freshness role="status">正在读取最新统计…</p><aside class="analytics-scope"><strong>按匿名浏览器去重，人数不等于真实用户数</strong><p>同一浏览器在所选时段内计 1 位访客；同一人换浏览器或清除浏览器数据，会重新计数。</p><p data-analytics-coverage>访问与动作从本功能上线后开始记录，之前没有完整历史记录。</p><p>首页访客按所选时段内打开首页计数，不是实时在线人数；此前已打开的页面继续操作可能只有动作数，不增加本时段访问人数或次数。</p><p>自动相机预览不算主动点击；点击开始、实际生成、录制结束和双片保存分别统计。结束不代表视频保存完整。</p></aside><div class="analytics-controls"><div class="analytics-range" role="group" aria-label="统计时段"><button type="button" data-days="1" aria-pressed="true">今天</button><button type="button" data-days="7" aria-pressed="false">近 7 天</button><button type="button" data-days="30" aria-pressed="false">近 30 天</button></div><p data-analytics-range class="analytics-caption">按北京时间统计</p></div><p data-analytics-loading class="analytics-loading" role="status">正在读取访问统计…</p><div class="analytics-error" data-analytics-error role="alert" hidden><p></p><button type="button" data-analytics-retry>重新读取</button></div><div data-analytics-body hidden><section class="analytics-live-section"><header><h3>当前活跃</h3><p>与下方日期筛选无关，按匿名浏览器计数。</p></header><div class="analytics-live" data-analytics-live></div></section><h3 class="analytics-cumulative-title" data-analytics-cumulative>今天累计</h3><div class="analytics-metrics" data-analytics-metrics></div><div class="analytics-secondary" data-analytics-secondary></div><section class="analytics-section"><header><h3>所有页面动作</h3><p>含首页与分享页；人数按该动作发生的浏览器去重，次数为动作触发总数。自动状态单独标注。</p></header><div class="analytics-action-wrap"><table class="analytics-action-table"><thead><tr><th scope="col">动作</th><th scope="col">人数</th><th scope="col">次数</th></tr></thead><tbody data-analytics-actions></tbody></table></div></section><section class="analytics-section"><header class="analytics-visitors-heading"><div><h3>访客明细</h3><p>展示所选时段打开过首页的浏览器与其首页操作，试衣进展以服务端记录为准。</p></div><label class="analytics-filter">筛选访客<select data-analytics-segment><option value="all">全部访客</option><option value="opened_only">只打开页面</option><option value="no_tryon">未实际试衣</option><option value="tried">已实际试衣</option></select></label></header><p class="analytics-filter-help" data-analytics-filter-help></p><div data-analytics-visitors class="analytics-visitors"></div><div class="analytics-pagination"><button type="button" data-analytics-previous>上一页</button><span data-analytics-page aria-live="polite"></span><button type="button" data-analytics-next>下一页</button></div></section></div></section>`;
  const $=<T extends HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
  const body=$('[data-analytics-body]'),loading=$('[data-analytics-loading]'),error=$('[data-analytics-error]');
  const current=()=>active&&root.isConnected&&options.isCurrent?.()!==false;
  const setBusy=(value:boolean)=>{busy=value;root.setAttribute('aria-busy',String(value));loading.hidden=!value||hasData;$<HTMLButtonElement>('[data-analytics-refresh]').disabled=value;$<HTMLButtonElement>('[data-analytics-previous]').disabled=value||offset===0;$<HTMLButtonElement>('[data-analytics-next]').disabled=value||offset+limit>=total;};
  function render(data:Analytics){
    total=data.total;offset=data.offset;limit=data.limit;
    const live=data.live,known=(value:number|undefined)=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
    const liveCount=(value:number|undefined)=>known(value)?count(value):'未知';
    $('[data-analytics-live]').innerHTML=`<article class="analytics-live-card"><h4>近 2 分钟前台活跃</h4><strong data-live="activeUV">${liveCount(live?.activeUV)}<span>人</span></strong><p>首页 ${liveCount(live?.homeActiveUV)} 人 · 分享页 ${liveCount(live?.shareActiveUV)} 人</p><small>按近 120 秒前台心跳估算，并非精确在线人数；两页人数可能重合。</small></article><article class="analytics-live-card"><h4>正在试衣</h4><strong data-live="tryingUV">${liveCount(live?.tryingUV)}<span>人</span></strong><p>当前 ${liveCount(live?.tryingSessions)} 场连接或录制</p><small>以服务端当前连接中、录制中会话为准。</small></article>`;
    $('[data-analytics-cumulative]').textContent=data.range.days===1?'今天累计':`近 ${data.range.days} 天累计`;
    const s=data.summary,metrics:Array<[string,string,number,string]>=[
      ['homeUV','首页访问人数',s.homeUV,'按浏览器去重'],['homePV','首页访问次数',s.homePV,'首页打开与刷新'],
      ['openedOnlyUV','只打开页面',s.openedOnlyUV,'无主动操作，且未创建试衣'],['noTryonUV','未实际试衣',s.noTryonUV,'没有实际生成记录'],
      ['startClickUV','点击开始试衣',s.startClickUV,`${count(s.startClicks)} 次点击，不等于生成`],['startedUV','实际开始生成',s.startedUV,`${count(s.started)} 场试衣`],
      ['endedUV','已结束录制',s.endedUV,`${count(s.ended)} 场，不代表保存完整`],['savedUV','双片完整保存',s.savedUV,`${count(s.saved)} 条原片与成片均已保存`],
    ];
    $('[data-analytics-metrics]').innerHTML=metrics.map(([key,label,value,note])=>`<article class="analytics-metric${key==='savedUV'?' analytics-metric-accent':''}" data-metric="${key}"><h3>${label}</h3><strong>${count(value)}<span>${key==='homePV'?'次':'人'}</span></strong><p>${note}</p></article>`).join('');
    $('[data-analytics-secondary]').innerHTML=`<p>分享页访问 <strong>${count(s.shareUV)}</strong> 人 / <strong>${count(s.sharePV)}</strong> 次，单独统计。</p><p>已创建试衣 <strong>${count(s.sessions)}</strong> 场 / <strong>${count(s.sessionUV)}</strong> 人；创建后可能仍在排队或连接。</p>`;
    $('[data-analytics-coverage]').textContent=data.trackingSince?`访问与动作自 ${stamp(data.trackingSince)}（北京时间）开始记录，之前没有完整历史记录。`:'访问与动作从本功能上线后开始记录，之前没有完整历史记录。';
    $('[data-analytics-range]').textContent=`${data.range.startDay} 至 ${data.range.endDay} · 北京时间`;
    $('[data-analytics-actions]').innerHTML=data.actions.map(action=>`<tr data-action-type="${escape(action.type)}"><th scope="row"><span>${escape(labels[action.type]||action.type)}</span>${automatic.has(action.type)?'<span class="analytics-auto-label">自动状态</span>':''}${actionNotes[action.type]?`<small>${escape(actionNotes[action.type])}</small>`:''}</th><td>${count(action.visitors)}</td><td>${count(action.count)}</td></tr>`).join('')||'<tr><td colspan="3" class="analytics-empty">所选时段尚无动作记录</td></tr>';
    $('[data-analytics-filter-help]').textContent=segment==='opened_only'?'只打开页面：没有主动操作，也没有创建试衣；自动相机预览不算主动操作。':segment==='no_tryon'?'未实际试衣：没有生成开始记录，可能选过服装、点击过开始或仍在排队。':segment==='tried'?'已实际试衣：存在生成开始记录；不代表两份视频均已保存。':'“只打开页面”与“未实际试衣”并不相同；开始点击不算实际试衣。';
    $('[data-analytics-visitors]').innerHTML=data.items.map(item=>{
      const actions=Object.entries(item.actions).filter(([type,n])=>n>0&&type!=='page_view');
      return `<article class="analytics-visitor" data-visitor-id="${escape(item.id)}"><div class="analytics-visitor-identity"><span class="analytics-field-label">匿名浏览器</span><strong title="${escape(item.id)}">${escape(item.id.slice(0,8))}</strong><span class="analytics-stage" data-stage="${escape(item.stage)}">${escape(stages[item.stage]||'阶段待确认')}</span></div><div class="analytics-visitor-visits"><span class="analytics-field-label">最近访问</span><time>${escape(stamp(item.lastVisitAt))}</time><p>${count(item.visits)} 次访问</p></div><div class="analytics-visitor-actions"><span class="analytics-field-label">首页动作 · ${count(item.activeActions)} 次主动操作</span><div class="analytics-action-tags">${actions.length?actions.map(([type,n])=>`<span class="${automatic.has(type)?'is-automatic':''}">${escape(labels[type]||type)} × ${count(n)}${automatic.has(type)?'（自动状态）':''}</span>`).join(''):'<span>无其他已记录动作</span>'}</div></div><div class="analytics-visitor-tryons"><span class="analytics-field-label">试衣进展</span><p>创建 ${count(item.tryonCount)} · 生成 ${count(item.generationCount)}</p><p>录制结束 ${count(item.endedCount)} · 双片保存 ${count(item.savedPairCount)}</p></div><div class="analytics-visitor-agent"><span class="analytics-field-label">归属代理</span><p>${escape(item.agentName||'无')}</p></div></article>`;
    }).join('')||'<p class="analytics-empty">所选时段和筛选条件下暂无访客</p>';
    $('[data-analytics-page]').textContent=total?`${count(total)} 位浏览器访客 · 第 ${Math.floor(offset/limit)+1} / ${Math.ceil(total/limit)} 页`:'0 位浏览器访客';
    body.hidden=false;
  }
  const queryKey=()=>`${days}:${segment}:${offset}:${limit}`;
  const clearPoll=()=>{window.clearTimeout(pollTimer);pollTimer=0;};
  const freshness=$('[data-analytics-freshness]');
  const freshnessText=(suffix:string)=>hasData?`更新于 ${clockStamp(lastUpdated)}（北京时间） · ${suffix}`:suffix;
  function schedulePoll(){
    clearPoll();if(!current()||document.hidden||busy)return;
    pollTimer=window.setTimeout(()=>void refresh(true),15000);
  }
  async function refresh(silent=false){
    if(!current()||document.hidden)return;
    // Keep at most one request running. A changed filter supersedes its result,
    // but waits for it to settle before issuing the latest selection.
    if(busy){if(!silent){++version;pending=true;freshness.textContent=freshnessText('正在读取已选条件，以下为上次结果');}return;}
    clearPoll();pending=false;
    const requestVersion=++version,key=queryKey(),request=new AbortController();controller=request;let timedOut=false;
    const timeout=window.setTimeout(()=>{timedOut=true;request.abort();},15000);
    error.hidden=true;setBusy(true);freshness.classList.remove('is-stale');
    freshness.textContent=freshnessText(hasData?'正在更新，保留上次数据':'正在读取最新统计…');
    try{
      const query=new URLSearchParams({days:String(days),segment,offset:String(offset),limit:String(limit)});
      const data=await api<Analytics>(`/api/admin/analytics?${query}`,{signal:request.signal});
      if(!current()||requestVersion!==version||request.signal.aborted||key!==queryKey())return;
      const scroll=hasData?{x:window.scrollX,y:window.scrollY}:null;
      render(data);hasData=true;lastKey=key;
      lastUpdated=data.live?.serverNow||data.range.endAt||Date.now();
      freshness.textContent=freshnessText('可见时每 15 秒自动更新');
      if(scroll)window.scrollTo(scroll.x,scroll.y);
    }catch(cause){
      if(!current()||requestVersion!==version||request.signal.aborted&&!timedOut)return;
      error.hidden=false;
      const reason=timedOut?'读取超时':cause instanceof Error?cause.message:'访问统计暂时无法读取';
      error.querySelector('p')!.textContent=hasData?`刷新失败，当前显示上次成功读取的数据。${reason}，请重试。`:`${reason}，请重新读取。`;
      freshness.classList.add('is-stale');freshness.textContent=freshnessText(hasData?'刷新失败，当前为上次数据':'读取失败，暂无可用统计');
    }finally{
      clearTimeout(timeout);if(controller===request)controller=null;
      if(current()){
        setBusy(false);
        if(hasData&&lastKey!==queryKey()){
          $<HTMLButtonElement>('[data-analytics-previous]').disabled=true;
          $<HTMLButtonElement>('[data-analytics-next]').disabled=true;
        }
        if(pending&&!document.hidden)void refresh();else schedulePoll();
      }
    }
  }
  function resumed(){
    if(!current()||document.hidden)return;
    window.clearTimeout(resumeTimer);
    resumeTimer=window.setTimeout(()=>{resumeTimer=0;void refresh(true);},150);
  }
  function visibilityChanged(){
    if(document.hidden){clearPoll();window.clearTimeout(resumeTimer);resumeTimer=0;controller?.abort();}
    else resumed();
  }
  document.addEventListener('visibilitychange',visibilityChanged);
  window.addEventListener('focus',resumed);
  window.addEventListener('pageshow',resumed);
  window.addEventListener('online',resumed);
  root.querySelectorAll<HTMLButtonElement>('[data-days]').forEach(button=>button.onclick=()=>{
    const next=Number(button.dataset.days);if(days===next)return;days=next;offset=0;
    root.querySelectorAll<HTMLButtonElement>('[data-days]').forEach(item=>item.setAttribute('aria-pressed',String(Number(item.dataset.days)===days)));void refresh();
  });
  $<HTMLSelectElement>('[data-analytics-segment]').onchange=event=>{segment=(event.target as HTMLSelectElement).value as Segment;offset=0;void refresh();};
  $<HTMLButtonElement>('[data-analytics-refresh]').onclick=()=>void refresh();
  $<HTMLButtonElement>('[data-analytics-retry]').onclick=()=>void refresh();
  $<HTMLButtonElement>('[data-analytics-previous]').onclick=()=>{if(busy||offset===0)return;offset=Math.max(0,offset-limit);void refresh();};
  $<HTMLButtonElement>('[data-analytics-next]').onclick=()=>{if(busy||offset+limit>=total)return;offset+=limit;void refresh();};
  void refresh();
  return {refresh,destroy(){
    if(!active)return;active=false;++version;pending=false;clearPoll();window.clearTimeout(resumeTimer);controller?.abort();
    document.removeEventListener('visibilitychange',visibilityChanged);window.removeEventListener('focus',resumed);window.removeEventListener('pageshow',resumed);window.removeEventListener('online',resumed);
    root.removeAttribute('aria-busy');
  }};
}
