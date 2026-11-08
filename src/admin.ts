import {api,post,patch,escape,date,toast,errorToast,icons,download,type Garment,type Tryon} from './api';
import {savedSummary,recordingSaveStatus} from './save-status';
import './admin-analytics.css';
type Overview={settings:{dailyUser:number;dailySite:number;concurrent:number;paused:boolean};storage:{used:number;reserved:number;limit:number;free:number;minFree:number};today:{count:number;seconds:number};active:number;waiting:number;day:string};
type Agent={id:string;code:string;name:string;wechatId:string;active:boolean;hasQr:boolean;qrUrl:string|null;referralUrl:string;createdAt:number;updatedAt:number;browserCount:number;tryonCount:number;generationSeconds:number};
type BusinessContact={name:string;wechatId:string;hasQr:boolean;qrUrl:string|null;updatedAt?:number};
type AgentResponse={items:Agent[];defaultContact:BusinessContact};
const labels:Record<string,string>={queued:'排队中',reserved:'准备连接',connecting:'连接中',recording:'试衣中',saving:'上传中',processing:'处理中',ready:'已保存',interrupted:'已中断',failed:'未完成'};
const gb=(value:number)=>(value/1024**3).toFixed(1)+' GB';
const videoStatus=(item:Tryon)=>savedSummary(item)||labels[item.status]||item.status;
const metric=(value:number|null|undefined,suffix='')=>typeof value==='number'?`${Math.round(value*10)/10}${suffix}`:'未知';
const performanceDetails=(item:Tryon)=>{
  const p=item.performance;if(!p)return '<p class="subtle">此记录没有性能摘要。</p>';
  const mbps=(value:number|null)=>value===null?'未知':`${(value/1e6).toFixed(2)} Mbps`,reason=p.fluidReason==='cpu'?'编码压力':p.fluidReason==='upstream'?'上行压力':p.fluidReason==='device'?'本机绘制压力':'无';
  const sender=p.senderParametersApplied===null?'动态降档未触发':p.senderParametersApplied?'动态发送参数已应用':'设备不支持动态发送参数',mode=p.qualityMode==='smooth'?'默认流畅':p.qualityMode==='reduced'?'压力降档':p.qualityMode==='fluid'?'旧版流畅':'旧版标准',profile=p.configVersion?`配置 ${p.configVersion} · 初始 ${p.initialProfile||'未知'} · 最终 ${p.finalProfile||'未知'} · 主层 ${metric(p.actualSendWidth,'×')}${p.actualSendHeight===null||p.actualSendHeight===undefined?'未知':p.actualSendHeight} · ${metric(p.actualSimulcastLayers,' 层')} · 参数上限 ${mbps(p.targetSendBitrateBps??null)}`:'';
  const cameraResult=p.cameraConstraintResult==='matched'?'初始规格匹配':p.cameraConstraintResult==='adjusted'?'同轨约束已调整':p.cameraConstraintResult==='fallback'?'规格调整回退':'未知';
  const cameraDetails=`<p>实际相机 ${metric(p.actualCameraWidth,'×')}${metric(p.actualCameraHeight)} · ${metric(p.actualCameraFps,' fps')} · ${cameraResult}</p><p>试衣前预览 ${metric(p.previewFps,' fps')} · 超过 250 ms 的额外间隔 ${metric(p.previewLongGapMs,' ms')}（不含隐藏或暂停）</p>`;
  return `<details class="performance-detail"><summary>画面与链路诊断 · ${p.samples} 个样本 · ${date(p.capturedAt)}</summary>${cameraDetails}<p>呈现停顿 ${metric(p.outputStallMs,' ms')} · ${metric(p.outputStallCount,' 次')} · 播放恢复尝试 ${metric(p.playbackRecoveryAttempts,' 次')} · 尝试后恢复出帧 ${metric(p.playbackRecoveries,' 次')}</p><p>绘制 ${metric(p.cameraFps,' fps')} · 实际呈现 ${metric(p.presentedFps,' fps')} · 发送 ${metric(p.sentFps,' fps')} · 接收 ${metric(p.receivedFps,' fps')}</p><p>往返延迟 ${metric(p.rttMs,' ms')} · 拍摄到显示 ${metric(p.glassToGlassMs,' ms')} · 冻结 ${metric(p.freezeMs,' ms')} · 解码 ${metric(p.decodeMs,' ms')}</p><p>发送 ${mbps(p.sendBitrateBps)} · 接收 ${mbps(p.receiveBitrateBps)} · 可用上行 ${mbps(p.availableOutgoingBps)} · 丢包 ${metric(p.lossFraction===null?null:p.lossFraction*100,'%')}</p><p>掉帧 ${metric(p.droppedFrames)} · 呈现丢帧 ${metric(p.presentedDrops)} · 中继 ${p.relayPathSamples} 样本 · 直连 ${p.directPathSamples} 样本</p><p>模式 ${mode} · 触发原因 ${reason} · ${sender}</p>${profile?`<p>${profile}</p>`:''}</details>`;
};
const startupDetails=(item:Tryon)=>{
  const s=item.startup;if(!s)return '';
  const mode=s.stabilityMode==='video-frame-callback'?'视频帧回调':s.stabilityMode==='decoded-frame-counter'?'解码帧计数':s.stabilityMode==='weak-playback'?'弱兼容播放状态':s.stabilityMode||'未记录';
  return `<details class="performance-detail"><summary>启动与画面就绪记录</summary><p>倒数协议 v${s.countdownVersion||1} · 实际倒数 ${metric(s.countdownMs,' ms')}</p><p>参考图确认 ${s.imageAcceptedAt?date(s.imageAcceptedAt):'未记录'} · 生成开始 ${s.generationStartedAt?date(s.generationStartedAt):'未记录'}</p><p>首帧 ${s.firstFrameAt?date(s.firstFrameAt):'未记录'} · 稳定窗口 ${s.stableVideoAt?date(s.stableVideoAt):'未记录'}</p><p>稳定观测 ${mode} · ${metric(s.stableWindowMs,' ms')} · ${s.stableFrames===null||s.stableFrames===undefined?'帧数未知':`${s.stableFrames} 帧`}</p><p>提示词版本 ${s.promptVersion||'旧版'} · 参考图摘要 ${s.referenceHash?escape(s.referenceHash.slice(0,16))+'…':'未记录'}。此项表示视频技术稳定，不代表服装匹配通过。</p>${s.promptSnapshot?`<pre class="prompt-snapshot">${escape(s.promptSnapshot)}</pre>`:''}</details>`;
};
export async function mountAdmin(root:HTMLElement){
  let overview:Overview,tab='videos',offset=0,modelViewer:{dispose:()=>void;capture:()=>Promise<Blob>}|null=null;
  let pollTimer=0,polling=false,contentVersion=0,dialogVideoId:string|null=null;
  let analytics:{destroy():void}|null=null;
  let parallel:{destroy():void}|null=null;
  async function loginPage(){++contentVersion;analytics?.destroy();analytics=null;parallel?.destroy();parallel=null;root.innerHTML=`<main class="admin-login"><h1><img src="/brand/logo.svg" alt="1➕衣" width="128" height="48"></h1><form id="login"><label class="field">管理员<input name="username" autocomplete="username" required value="admin"></label><label class="field">密码<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">登录</button></form></main>`;root.querySelector<HTMLFormElement>('#login')!.onsubmit=async event=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement,data=new FormData(form);try{await post('/api/admin/login',{username:data.get('username'),password:data.get('password')});form.reset();await shell();}catch(error){errorToast(error);}};}
  async function shell(){
    try{overview=await api<Overview>('/api/admin/overview');}catch{await loginPage();return;}
    root.innerHTML=`<div class="admin-shell"><header class="admin-top"><div><a class="brand" href="/"><img src="/brand/logo.svg" alt="1➕衣" width="128" height="48"></a><span class="subtle">管理后台</span></div><button id="logout" class="text-button">退出</button></header><section id="metrics" class="metrics"></section><div class="admin-toolbar"><nav class="tabs"><button data-admin-tab="videos">视频</button><button data-admin-tab="analytics">访问统计</button><button data-admin-tab="garments">服装</button><button data-admin-tab="api-keys">API 密钥</button><button data-admin-tab="business">商务合作</button><button data-admin-tab="parallel-self">平行的我</button><button data-admin-tab="settings">设置</button></nav><button id="admin-upload" class="primary" hidden>上传服装</button><button id="quota-settings" class="text-button">次数与并发</button><button id="refresh-admin" class="text-button">刷新</button></div><div id="admin-content"></div></div><input id="admin-file" type="file" accept=".glb,image/jpeg,image/png,image/webp" hidden><dialog id="admin-dialog" class="sheet"><header><h2 id="dialog-title"></h2><button id="dialog-close" class="icon-button" aria-label="关闭">${icons.close}</button></header><div id="dialog-content"></div></dialog>`;
    document.getElementById('logout')!.onclick=()=>{clearInterval(pollTimer);++contentVersion;analytics?.destroy();analytics=null;parallel?.destroy();parallel=null;void post('/api/admin/logout').then(loginPage).catch(errorToast);};
    document.getElementById('dialog-close')!.onclick=()=>{dialogVideoId=null;modelViewer?.dispose();modelViewer=null;(document.getElementById('admin-dialog') as HTMLDialogElement).close();};
    (document.getElementById('admin-dialog') as HTMLDialogElement).addEventListener('cancel',()=>{modelViewer?.dispose();modelViewer=null;});
    document.querySelectorAll<HTMLButtonElement>('[data-admin-tab]').forEach(button=>button.onclick=()=>{tab=button.dataset.adminTab!;offset=0;void content().catch(errorToast);});
    document.getElementById('refresh-admin')!.onclick=()=>void content().catch(errorToast);
    document.getElementById('quota-settings')!.onclick=()=>{tab='settings';void content().catch(errorToast);};
    document.getElementById('admin-upload')!.onclick=()=>(document.getElementById('admin-file') as HTMLInputElement).click();
    (document.getElementById('admin-file') as HTMLInputElement).onchange=async event=>{
      const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;
      try{if(file.size>(file.name.toLowerCase().endsWith('.glb')?100:20)*1024*1024)throw new Error('图片上限 20MB，GLB 上限 100MB。');const data=new FormData();data.append('file',file);toast('正在上传…');const item=await api<Garment>('/api/admin/garments',{method:'POST',body:data});await content();await editGarment(item);}catch(error){errorToast(error);}finally{input.value='';}
    };await content();
    clearInterval(pollTimer);pollTimer=window.setInterval(()=>void refreshProgress(),5000);
  }
  async function refreshProgress(){
    if(polling||document.hidden||!['videos','analytics'].includes(tab)||!document.getElementById('admin-content'))return;
    polling=true;const version=contentVersion,pollTab=tab;
    try{
      const [stats,data]=await Promise.all([api<Overview>('/api/admin/overview'),pollTab==='videos'?api<{items:Tryon[];total:number}>(`/api/admin/tryons?offset=${offset}`):Promise.resolve(null)]);
      if(version!==contentVersion||tab!==pollTab)return;
      overview=stats;metrics();
      if(!data)return;
      const modal=document.getElementById('admin-dialog') as HTMLDialogElement;
      if(!modal.open)renderVideoTable(data,document.getElementById('admin-content')!);
      else if(dialogVideoId){const item=data.items.find(x=>x.id===dialogVideoId)||await api<Tryon>(`/api/tryons/${dialogVideoId}`);if(modal.open&&dialogVideoId===item.id)refreshVideoDialog(item);}
    }catch{/* A transient polling failure must not close a playing video. */}finally{polling=false;}
  }
  function metrics(){const space=overview.storage;document.getElementById('metrics')!.innerHTML=`<article class="metric"><small>今日试衣</small><strong>${overview.today.count}<span class="subtle"> / ${overview.settings.dailySite}</span></strong><span class="subtle">${overview.day}</span></article><article class="metric"><small>生成时长</small><strong>${Math.round(overview.today.seconds)}<span class="subtle"> 秒</span></strong><span class="subtle">按云端会话记录</span></article><article class="metric"><small>正在试衣</small><strong>${overview.active}<span class="subtle"> / ${overview.settings.concurrent}</span></strong><span class="subtle">${overview.settings.paused?'新试衣已暂停':('排队 '+overview.waiting+' 人')}</span></article><article class="metric${space.used/space.limit>.8||space.free<space.minFree?' warning':''}"><small>素材与视频</small><strong>${gb(space.used)}</strong><span class="subtle">上限 ${gb(space.limit)} · 视频 30 天</span></article>`;}
  async function content(){
    const version=++contentVersion;analytics?.destroy();analytics=null;parallel?.destroy();parallel=null;
    const latestOverview=await api<Overview>('/api/admin/overview');
    if(version!==contentVersion)return;overview=latestOverview;metrics();document.getElementById('metrics')!.hidden=tab==='parallel-self';
    document.querySelectorAll<HTMLElement>('[data-admin-tab]').forEach(x=>x.classList.toggle('active',x.dataset.adminTab===tab));
    document.getElementById('admin-upload')!.hidden=tab!=='garments';const target=document.getElementById('admin-content')!;
    if(tab==='parallel-self'){
      target.innerHTML='<section id="parallel-admin-panel"></section>';const panel=target.firstElementChild as HTMLElement;
      const {mountParallelAdmin}=await import('./admin-parallel');
      if(version!==contentVersion||tab!=='parallel-self'||!panel.isConnected)return;
      parallel=mountParallelAdmin(panel,{isCurrent:()=>version===contentVersion&&tab==='parallel-self'});return;
    }
    if(tab==='analytics'){
      target.innerHTML='<section id="analytics-panel"></section>';const panel=target.firstElementChild as HTMLElement;
      const {mountAdminAnalytics}=await import('./admin-analytics');
      if(version!==contentVersion||tab!=='analytics'||!panel.isConnected)return;
      analytics=mountAdminAnalytics(panel,{isCurrent:()=>version===contentVersion&&tab==='analytics'});return;
    }
    if(tab==='api-keys'){
      target.innerHTML='<section id="api-keys-panel"></section>';const panel=target.firstElementChild as HTMLElement;
      const {mountApiKeys}=await import('./admin-keys');await mountApiKeys(panel);return;
    }
    if(tab==='business'){await renderBusinessAdmin(target,version);return;}
    if(tab==='settings'){
      target.innerHTML=`<form id="settings-form" class="settings-panel"><label class="field">每位用户每日次数<input type="number" name="dailyUser" min="1" max="100" value="${overview.settings.dailyUser}" required></label><label class="field">全站每日次数<input type="number" name="dailySite" min="1" max="10000" value="${overview.settings.dailySite}" required></label><label class="field">同时试衣人数<input type="number" name="concurrent" min="1" max="20" value="${overview.settings.concurrent}" required></label><label class="check"><input name="paused" type="checkbox" ${overview.settings.paused?'checked':''}> 暂停新试衣</label><p class="subtle">每件 30 秒 · 超出并发人数自动排队<br>双视频保留 30 天 · 总配额 20GB</p><p class="notice-inline">空间达到上限时停止新增，不会提前删除未到期视频。</p><button class="primary">保存</button></form>`;
      target.querySelector<HTMLFormElement>('form')!.onsubmit=event=>{event.preventDefault();const data=new FormData(event.currentTarget as HTMLFormElement);void patch('/api/admin/settings',{dailyUser:Number(data.get('dailyUser')),dailySite:Number(data.get('dailySite')),concurrent:Number(data.get('concurrent')),paused:data.get('paused')==='on'}).then(()=>{toast('已保存');return content();}).catch(errorToast);};return;
    }
    if(tab==='garments'){
      const items=await api<Garment[]>('/api/admin/garments');
      if(version!==contentVersion||tab!=='garments')return;
      target.innerHTML=`<div class="table-wrap"><table class="admin-table"><thead><tr><th>服装</th><th>名称</th><th>来源</th><th>状态</th><th>排序</th><th>操作</th></tr></thead><tbody>${items.map(item=>`<tr data-id="${item.id}"><td>${item.imageUrl?`<img src="${escape(item.imageUrl)}" alt="">`:icons.shirt}</td><td>${escape(item.name)}</td><td>${item.owned?'用户 '+escape(item.visitorId?.slice(0,8)):'内置'}${item.hasModel?' · 3D':''}</td><td><span class="tag">${item.owned?'私有':item.published?'已上架':'未上架'}</span></td><td>${item.position}</td><td><button data-edit>编辑</button><button data-source>素材</button><button data-delete>删除</button></td></tr>`).join('')}</tbody></table></div>`;
      target.querySelectorAll<HTMLElement>('[data-id]').forEach(row=>{const item=items.find(x=>x.id===row.dataset.id)!;row.querySelector<HTMLButtonElement>('[data-edit]')!.onclick=()=>void editGarment(item).catch(errorToast);row.querySelector<HTMLButtonElement>('[data-source]')!.onclick=()=>download(`/api/garments/${item.id}/original`);row.querySelector<HTMLButtonElement>('[data-delete]')!.onclick=()=>{if(confirm(`删除「${item.name}」？历史视频会保留。`))void api(`/api/garments/${item.id}`,{method:'DELETE'}).then(content).catch(errorToast);};});return;
    }
    const data=await api<{items:Tryon[];total:number}>(`/api/admin/tryons?offset=${offset}`);
    if(version!==contentVersion)return;renderVideoTable(data,target);
  }
  async function renderBusinessAdmin(target:HTMLElement,version:number){
    const data=await api<AgentResponse>('/api/admin/agents');
    if(version!==contentVersion||tab!=='business')return;
    const statusHtml='<p class="agent-feedback" data-feedback role="status" aria-live="polite"></p>';
    const editorHtml=`<form class="agent-editor" hidden><label class="field">名称<input name="name" maxlength="80" required></label><label class="field">微信号<input name="wechatId" maxlength="100"></label><div class="agent-editor-actions"><button type="submit" class="primary" data-save>保存资料</button><button type="button" data-cancel>取消编辑</button></div></form>`;
    target.innerHTML=`<div class="business-admin"><section class="agent-default"><div class="agents-heading"><h2>官方商务联系人</h2><p class="subtle">未归属代理或代理已停用时，展示此联系方式。</p></div><div data-default-card></div></section><section class="agents-section"><div class="agents-heading"><h2>代理管理</h2><p class="subtle">首次有效归属固定到当前浏览器；每位代理单独保存、单独展示。</p></div><form id="agent-create-form" class="agent-create"><h3>新增代理</h3><label class="field">代理名称<input name="name" maxlength="80" required placeholder="填写代理名称"></label><label class="field">微信号<input name="wechatId" maxlength="100" placeholder="填写用于联系的微信号"></label><button class="primary" type="submit">创建并保存</button>${statusHtml}</form><div class="agents-saved-heading"><h3>已保存代理 <span data-agent-count>${data.items.length}</span></h3><span class="subtle">修改资料请点击对应条目的“编辑资料”</span></div><div class="agent-list"></div><p data-agent-empty class="empty-list" ${data.items.length?'hidden':''}>还没有已保存代理。填写上方资料后创建。</p></section></div>`;
    const list=target.querySelector<HTMLElement>('.agent-list')!;
    let posterRequest=0;
    function feedback(container:HTMLElement,message:string,tone='success'){
      const output=container.querySelector<HTMLElement>('[data-feedback]')!;
      output.textContent=message;output.dataset.tone=tone;
    }
    function lock(container:HTMLElement){
      const controls=[...container.querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button')].map(control=>({control,disabled:control.disabled}));
      container.setAttribute('aria-busy','true');controls.forEach(({control})=>control.disabled=true);
      return ()=>{container.removeAttribute('aria-busy');controls.forEach(({control,disabled})=>control.disabled=disabled);};
    }
    function makeCard(initial:BusinessContact|Agent,isDefault=false){
      let saved={...initial},busy=false,posterToken=0;
      const card=document.createElement('article');card.className='agent-card';
      if(!isDefault)card.dataset.agentId=(saved as Agent).id;
      card.innerHTML=`<div class="agent-card-heading"><div><h3 data-saved-name></h3><p class="agent-saved-time" data-saved-time></p></div><span class="agent-state" data-state></span></div><div class="agent-record-body"><div class="agent-qr-preview" data-qr-preview></div><div class="agent-record-info"><p class="agent-wechat"><span>微信号</span><strong data-saved-wechat></strong></p>${isDefault?'<p class="subtle">默认商务联系方式</p>':'<div class="agent-stats" data-stats></div><p class="agent-code" data-code></p><label class="agent-link-label">专属推广链接<div class="agent-link"><input data-link readonly aria-label="专属推广链接"><button data-copy-link type="button">复制链接</button></div></label>'}<p class="agent-qr-state" data-qr-state></p><div class="agent-actions"><button data-edit type="button">编辑资料</button><button data-upload type="button">上传二维码</button>${isDefault?'':'<button data-agent-poster type="button">专属海报</button><button data-toggle type="button"></button>'}</div><input data-qr type="file" accept="image/png,image/jpeg,image/webp" hidden></div></div>${editorHtml}${statusHtml}`;
      const form=card.querySelector<HTMLFormElement>('.agent-editor')!,name=form.elements.namedItem('name') as HTMLInputElement,wechat=form.elements.namedItem('wechatId') as HTMLInputElement;
      const edit=card.querySelector<HTMLButtonElement>('[data-edit]')!,qrInput=card.querySelector<HTMLInputElement>('[data-qr]')!;
      const isDirty=()=>!form.hidden&&(name.value!==saved.name||wechat.value!==saved.wechatId);
      function refreshPosterButton(){
        const button=card.querySelector<HTMLButtonElement>('[data-agent-poster]');
        if(button){button.disabled=busy||!(saved as Agent).active;button.title=(saved as Agent).active?'生成此代理的专属推广海报':'代理已停用，启用后可生成专属海报';}
      }
      function renderSaved(){
        card.querySelector<HTMLElement>('[data-saved-name]')!.textContent=saved.name;
        card.querySelector<HTMLElement>('[data-saved-wechat]')!.textContent=saved.wechatId||'未填写';
        card.querySelector<HTMLElement>('[data-saved-time]')!.textContent=saved.updatedAt?`已保存 · 更新于 ${date(saved.updatedAt)}`:'已保存';
        const state=card.querySelector<HTMLElement>('[data-state]')!,agent=saved as Agent;
        state.textContent=isDefault?'官方默认':agent.active?'启用中':'已停用';state.dataset.active=String(isDefault||agent.active);
        const qr=card.querySelector<HTMLElement>('[data-qr-preview]')!;
        qr.innerHTML=saved.qrUrl?`<img src="${escape(saved.qrUrl)}" alt="${escape(saved.name)}微信二维码">`:'<span>尚未上传<br>微信二维码</span>';
        const qrState=card.querySelector<HTMLElement>('[data-qr-state]')!;
        qrState.textContent=saved.hasQr?'二维码已保存':'二维码尚未上传';
        const img=qr.querySelector<HTMLImageElement>('img');
        if(img)img.onerror=()=>{if(!qr.contains(img))return;qrState.textContent='二维码已保存，预览加载失败，请刷新重试。';qrState.dataset.error='true';};
        delete qrState.dataset.error;
        card.querySelector<HTMLButtonElement>('[data-upload]')!.textContent=saved.hasQr?'更换二维码':'上传二维码';
        if(!isDefault){
          card.querySelector<HTMLElement>('[data-stats]')!.innerHTML=`<span>归属浏览器 <strong>${agent.browserCount}</strong></span><span>试衣 <strong>${agent.tryonCount}</strong></span><span>生成 <strong>${Math.round(agent.generationSeconds)} 秒</strong></span>`;
          card.querySelector<HTMLElement>('[data-code]')!.textContent=`代理代码：${agent.code}`;
          card.querySelector<HTMLInputElement>('[data-link]')!.value=agent.referralUrl;
          card.querySelector<HTMLButtonElement>('[data-toggle]')!.textContent=agent.active?'停用代理':'重新启用';
          refreshPosterButton();
        }
      }
      function closeEditor(){form.hidden=true;edit.hidden=false;name.value=saved.name;wechat.value=saved.wechatId;}
      async function mutate(operation:()=>Promise<void>,pending:string){
        if(busy)return;busy=true;const unlock=lock(card);feedback(card,pending,'pending');
        try{await operation();}catch(error){feedback(card,`${error instanceof Error?error.message:'操作失败，请重试。'}${isDirty()?' 本条未保存的修改仍保留。':''}`,'error');}
        finally{busy=false;unlock();refreshPosterButton();}
      }
      edit.onclick=()=>{if(busy)return;name.value=saved.name;wechat.value=saved.wechatId;form.hidden=false;edit.hidden=true;feedback(card,'修改后点击“保存资料”，仅保存本条。','neutral');name.focus();};
      card.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick=()=>{if(busy)return;closeEditor();feedback(card,'已取消编辑，保留已保存资料。','neutral');};
      form.oninput=()=>feedback(card,isDirty()?'本条有未保存修改。':'资料与已保存内容一致。',isDirty()?'pending':'neutral');
      form.onsubmit=event=>{
        event.preventDefault();if(busy||!form.reportValidity())return;
        const values={name:name.value.trim(),wechatId:wechat.value.trim()};
        if(!values.name){feedback(card,'请输入代理名称。','error');name.focus();return;}
        void mutate(async()=>{
          const response=isDefault?await api<BusinessContact>('/api/admin/business-contact',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)}):await patch<Agent>(`/api/admin/agents/${(saved as Agent).id}`,values);
          saved={...saved,...response};renderSaved();closeEditor();feedback(card,'资料保存成功。');
        },'正在保存本条资料…');
      };
      card.querySelector<HTMLButtonElement>('[data-upload]')!.onclick=()=>{if(!busy)qrInput.click();};
      qrInput.onchange=()=>{
        const file=qrInput.files?.[0];if(!file||busy)return;
        void mutate(async()=>{
          const response=await uploadQr(isDefault?'/api/admin/business-contact/qr':`/api/admin/agents/${(saved as Agent).id}/qr`,file);
          saved={...saved,...response,hasQr:true};renderSaved();feedback(card,`二维码保存成功。${isDirty()?' 文字资料仍有未保存修改。':''}`);
        },'正在上传并保存二维码…').finally(()=>{qrInput.value='';});
      };
      if(!isDefault){
        const poster=card.querySelector<HTMLButtonElement>('[data-agent-poster]')!;
        poster.onclick=()=>{
          if(busy||!(saved as Agent).active||version!==contentVersion||tab!=='business'||!card.isConnected)return;
          const token=++posterToken,request=++posterRequest,agentId=(saved as Agent).id;
          const isCurrent=()=>request===posterRequest&&token===posterToken&&version===contentVersion&&tab==='business'&&card.isConnected&&(saved as Agent).id===agentId&&(saved as Agent).active;
          busy=true;const unlock=lock(card);poster.textContent='正在生成…';
          void import('./promo-poster').then(module=>{
            if(!isCurrent())return;
            return module.openAgentPromotionPoster(agentId,isCurrent);
          }).catch(error=>{if(isCurrent())feedback(card,error instanceof Error?error.message:'海报暂时无法生成，请重试。','error');}).finally(()=>{
            if(token!==posterToken)return;
            busy=false;unlock();poster.textContent='专属海报';refreshPosterButton();
          });
        };
        card.querySelector<HTMLButtonElement>('[data-toggle]')!.onclick=()=>void mutate(async()=>{
          const response=await patch<Agent>(`/api/admin/agents/${(saved as Agent).id}`,{active:!(saved as Agent).active});
          saved={...saved,...response};renderSaved();feedback(card,`${(saved as Agent).active?'已启用':'已停用'}并保存。${isDirty()?' 文字资料仍有未保存修改。':''}`);
        },'正在保存代理状态…');
        card.querySelector<HTMLButtonElement>('[data-copy-link]')!.onclick=async()=>{
          if(busy)return;
          try{await navigator.clipboard.writeText((saved as Agent).referralUrl);feedback(card,`推广链接已复制。${isDirty()?' 文字资料仍有未保存修改。':''}`);}
          catch{const input=card.querySelector<HTMLInputElement>('[data-link]')!;input.focus();input.select();feedback(card,'自动复制不可用，已选中推广链接，请手动复制。','neutral');}
        };
      }
      renderSaved();return card;
    }
    target.querySelector<HTMLElement>('[data-default-card]')!.append(makeCard(data.defaultContact,true));
    data.items.forEach(agent=>list.append(makeCard(agent)));
    const create=target.querySelector<HTMLFormElement>('#agent-create-form')!;let creating=false;
    create.onsubmit=event=>{
      event.preventDefault();if(creating||!create.reportValidity())return;
      const values=new FormData(create),name=String(values.get('name')||'').trim(),wechatId=String(values.get('wechatId')||'').trim();
      if(!name){feedback(create,'请输入代理名称。','error');return;}
      creating=true;const unlock=lock(create);feedback(create,'正在创建并保存代理…','pending');
      void post<Agent>('/api/admin/agents',{name,wechatId}).then(agent=>{
        if(!create.isConnected)return;
        const card=makeCard(agent);list.prepend(card);data.items.unshift(agent);create.reset();
        target.querySelector<HTMLElement>('[data-agent-count]')!.textContent=String(data.items.length);
        target.querySelector<HTMLElement>('[data-agent-empty]')!.hidden=true;
        feedback(create,`“${agent.name}”创建并保存成功，已加入下方列表。`);feedback(card,'创建并保存成功。请上传此代理的微信二维码。');
      }).catch(error=>feedback(create,error instanceof Error?error.message:'创建失败，请重试。','error')).finally(()=>{creating=false;unlock();});
    };
  }
  async function uploadQr(url:string,file:File){if(file.size>5*1024*1024)throw new Error('二维码图片最大 5 MB。');if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请使用 JPG、PNG 或 WebP 图片。');return api<{qrUrl:string;updatedAt?:number}>(url,{method:'PUT',headers:{'Content-Type':file.type},body:file});}
  function renderVideoTable(data:{items:Tryon[];total:number},target:HTMLElement){
    const cell=(item:Tryon,kind:string)=>{const video=item.recordings.find(x=>x.kind===kind);return video?`<span class="tag">${escape(recordingSaveStatus(video))}</span>${video.duration?`<br><small>${video.duration.toFixed(1)} 秒${video.recovered?' · 恢复片段':''}</small>`:''}`:'—';};
    target.innerHTML=`<div class="table-wrap"><table class="admin-table"><thead><tr><th>时间</th><th>用户</th><th>服装</th><th>试穿视频</th><th>原视频</th><th>操作</th></tr></thead><tbody>${data.items.map(item=>`<tr data-id="${item.id}"><td class="mono">${date(item.createdAt)}</td><td>${item.visitorId.slice(0,8)}${item.userHiddenAt?'<br><span class="tag">用户已移除</span>':''}</td><td>${escape(item.garmentName)}</td><td>${cell(item,'result')}</td><td>${cell(item,'original')}</td><td><button data-view>查看</button>${item.shareActive?'<button data-revoke-share>关闭分享</button>':''}${item.userHiddenAt?'<button data-restore>恢复到用户列表</button>':''}<button data-delete>永久删除</button></td></tr>`).join('')||'<tr><td colspan="6">暂无视频</td></tr>'}</tbody></table></div><div class="admin-pager"><button id="previous" class="text-button" ${offset===0?'disabled':''}>上一页</button><span class="subtle">${data.total} 条 · 进度自动刷新</span><button id="next" class="text-button" ${offset+50>=data.total?'disabled':''}>下一页</button></div>`;
    document.getElementById('previous')!.onclick=()=>{offset=Math.max(0,offset-50);void content().catch(errorToast);};document.getElementById('next')!.onclick=()=>{offset+=50;void content().catch(errorToast);};
    target.querySelectorAll<HTMLElement>('[data-id]').forEach(row=>{const item=data.items.find(x=>x.id===row.dataset.id)!;row.querySelector<HTMLButtonElement>('[data-view]')!.onclick=()=>viewVideo(item);row.querySelector<HTMLButtonElement>('[data-delete]')!.onclick=()=>{if(confirm('永久删除原视频和试穿成片？用户和后台均无法再查看，此操作不可恢复。'))void api(`/api/admin/tryons/${item.id}`,{method:'DELETE'}).then(content).catch(errorToast);};const revoke=row.querySelector<HTMLButtonElement>('[data-revoke-share]');if(revoke)revoke.onclick=()=>{if(confirm('关闭此分享链接？已有链接和二维码将立即失效。'))void post(`/api/admin/tryons/${item.id}/share/revoke`).then(content).catch(errorToast);};const restore=row.querySelector<HTMLButtonElement>('[data-restore]');if(restore)restore.onclick=()=>void post(`/api/admin/tryons/${item.id}/restore`).then(content).catch(errorToast);});
  }
  function dialog(title:string,html:string){dialogVideoId=null;modelViewer?.dispose();modelViewer=null;document.getElementById('dialog-title')!.textContent=title;document.getElementById('dialog-content')!.innerHTML=html;(document.getElementById('admin-dialog') as HTMLDialogElement).showModal();}
  function viewVideo(item:Tryon){dialog(item.garmentName,`<p class="subtle">${date(item.createdAt)} · ${item.visitorId.slice(0,8)} · ${date(item.expiresAt)} 到期</p><p class="subtle">${escape(videoStatus(item))}${item.userHiddenAt?' · 用户已移除，后台保留':''}</p>${startupDetails(item)}${performanceDetails(item)}<div class="pair-grid">${['original','result'].map(kind=>`<section data-recording-kind="${kind}"><h3>${kind==='original'?'原视频':'试穿成片'}</h3><p data-recording-state class="subtle"></p><div data-media-slot><div class="video-pending">等待视频</div></div><p data-upload-help class="subtle" hidden>请用户在原手机浏览器打开本站继续上传。</p><button data-processing-retry class="secondary" hidden>重试处理</button><button data-recover class="secondary" hidden>恢复已上传片段</button></section>`).join('')}</div>`);dialogVideoId=item.id;refreshVideoDialog(item);}
  function refreshVideoDialog(item:Tryon){
    for(const video of item.recordings){
      const section=document.querySelector<HTMLElement>(`#dialog-content [data-recording-kind="${video.kind}"]`);if(!section)continue;
      const state=section.querySelector<HTMLElement>('[data-recording-state]')!;state.textContent=recordingSaveStatus(video)+(video.duration?` · ${video.duration.toFixed(1)} 秒`:'');state.hidden=!video.url;
      section.querySelector<HTMLElement>('[data-upload-help]')!.hidden=!video.waitingForUpload;
      const slot=section.querySelector<HTMLElement>('[data-media-slot]')!;
      const revision=`${Boolean(video.recovered)}:${video.duration}`;
      if(video.url&&(!slot.querySelector('video')||slot.dataset.revision!==revision)){slot.dataset.revision=revision;slot.innerHTML=`<video src="${escape(video.url)}" poster="${escape(video.poster)}" controls playsinline preload="metadata"></video><a href="${escape(video.url)}?download=1" download>${video.recovered?'下载恢复片段':'下载'}</a>`;}
      else if(!video.url){const placeholder=slot.querySelector('.video-pending');if(placeholder)placeholder.textContent=recordingSaveStatus(video);}
      const retry=section.querySelector<HTMLButtonElement>('[data-processing-retry]')!;retry.hidden=!video.retryable;
      retry.onclick=()=>{retry.disabled=true;void post(`/api/tryons/${item.id}/recordings/${video.kind}/retry`).then(()=>refreshProgress()).catch(errorToast).finally(()=>{retry.disabled=false;});};
      const recover=section.querySelector<HTMLButtonElement>('[data-recover]')!;recover.hidden=!video.recoveryAvailable;
      recover.onclick=()=>{recover.disabled=true;recover.textContent='正在恢复…';void api<Tryon>(`/api/admin/tryons/${item.id}/recordings/${video.kind}/recover`,{method:'POST',signal:AbortSignal.timeout(150000)}).then(updated=>{if(dialogVideoId===item.id)refreshVideoDialog(updated);toast('已恢复片段，时长以实际文件为准');}).catch(errorToast).finally(()=>{recover.disabled=false;recover.textContent='恢复已上传片段';});};
    }
  }
  async function editGarment(item:Garment){
    dialog('编辑服装',`<form id="garment-form"><label class="field">名称<input name="name" maxlength="80" value="${escape(item.name)}" required></label><label class="field">类别<select name="category"><option value="outfit">整套</option><option value="top">上装</option><option value="bottom">下装</option><option value="accessory">配饰</option></select></label><label class="field">服装细节描述（最多 350 字）<textarea name="details" maxlength="350" placeholder="描述可见颜色、版型、领口、袖型、纹样；整套服装请说明内搭也需替换">${escape(item.details||'')}</textarea></label><p class="subtle">提示词会由服务端按类别与描述生成，换衣效果需通过录像验收。</p>${item.hasModel?'<div id="model-stage" class="model-stage"><p class="subtle">模型加载中…</p></div><button type="button" id="capture-model" class="secondary">保存当前角度为参考图</button>':''}${item.imageUrl?`<img id="reference-preview" src="${escape(item.imageUrl)}" alt="参考图" style="width:100px;height:130px;object-fit:contain;margin-top:15px">`:'<img id="reference-preview" alt="参考图" hidden style="width:100px;height:130px;object-fit:contain;margin-top:15px">'}<label class="field">排序<input name="position" type="number" value="${item.position}"></label>${!item.owned?`<label class="check"><input name="published" type="checkbox" ${item.published?'checked':''}> 上架</label>`:''}<button class="primary" style="width:100%">保存</button></form>`);
    const form=document.getElementById('garment-form') as HTMLFormElement;(form.elements.namedItem('category') as HTMLSelectElement).value=item.category;
    form.onsubmit=event=>{event.preventDefault();const data=new FormData(form);void patch(`/api/garments/${item.id}`,{name:data.get('name'),category:data.get('category'),details:data.get('details'),position:Number(data.get('position')),...(!item.owned?{published:data.get('published')==='on'}:{})}).then(()=>{modelViewer?.dispose();modelViewer=null;(document.getElementById('admin-dialog') as HTMLDialogElement).close();toast('已保存');return content();}).catch(errorToast);};
    if(item.hasModel){const {showModel}=await import('./model-viewer');modelViewer=await showModel(document.getElementById('model-stage')!,`/api/garments/${item.id}/model`);document.getElementById('capture-model')!.onclick=()=>void(async()=>{if(!modelViewer)return;const blob=await modelViewer.capture();await api(`/api/admin/garments/${item.id}/reference`,{method:'PUT',headers:{'Content-Type':'image/png'},body:blob});const image=document.getElementById('reference-preview') as HTMLImageElement;image.src=`/api/garments/${item.id}/image?v=${Date.now()}`;image.hidden=false;toast('参考图已保存');})().catch(errorToast);}
  }
  await shell();
}
