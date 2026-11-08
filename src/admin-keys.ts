import {api,post,patch,escape,date,toast,errorToast} from './api';

type KeyItem={id:string;label:string;masked:string;enabled:boolean;active:boolean;createdAt:number;lastUsedAt:number|null;lastCode:string|null;retryAt:number;disabledReason:string|null;quota:{limit:number|null;active:number|null;remaining:number|null}|null;quotaCheckedAt:number|null;quotaCode:string|null;creditState:'unknown'|'insufficient';creditCheckedAt:number|null;usedSeconds:number};
type KeyList={activeId:string|null;nextId:string|null;failover:{maxAttempts:number;cooldownSeconds:number};usageLimitSeconds:number;items:KeyItem[];retired?:{label:string;masked:string;usedSeconds:number;retiredAt:number;endReason:string}[]};
type ImportResult={added:number;duplicates:number;invalid:{line:number;message:string}[]};
const statuses:Record<string,string>={OK:'令牌已签发',INVALID_API_KEY:'密钥无效',ACCESS_DENIED:'无模型权限',INSUFFICIENT_CREDITS:'额度不足',RATE_LIMITED:'调用受限',INVALID_PARAMETERS:'参数错误',NETWORK_ERROR:'网络异常',PROVIDER_ERROR:'服务异常',INVALID_RESPONSE:'返回内容无效',KEY_UNREADABLE:'密钥无法解密'};

export async function mountApiKeys(root:HTMLElement){
  if(!root.isConnected)return;
  root.innerHTML=`<div class="key-imports"><form id="single-key" class="key-panel" autocomplete="off"><h2>添加密钥</h2><label class="field">名称<input name="label" maxlength="60" placeholder="例如：主账号"></label><label class="field">API 密钥<input name="key" type="password" required maxlength="256" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="dct_…"></label><button class="primary">添加</button></form><form id="batch-keys" class="key-panel" autocomplete="off"><h2>批量导入</h2><label class="field">每行一个密钥<textarea name="keys" rows="5" required maxlength="60000" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="粘贴密钥，每行一个"></textarea></label><p class="subtle">每次最多 100 行，重复密钥自动跳过。</p><button class="primary">导入</button></form></div><p id="key-import-result" class="key-feedback" role="status" hidden></p><div class="key-list-heading"><h2>已保存密钥</h2><p id="key-summary" class="subtle"></p></div><p class="subtle key-help">列表仅显示尾号。设为当前密钥后，对下一次试衣生效。</p><div id="key-list" class="key-list"></div>`;
  const result=root.querySelector<HTMLElement>('#key-import-result')!;
  async function refresh(){
    const data=await api<KeyList>('/api/admin/api-keys');if(!root.isConnected)return;
    const next=data.items.find(x=>x.id===data.nextId);
    root.querySelector('#key-summary')!.textContent=next?`下次使用：${next.label} · ${next.masked}`:data.activeId?'暂无可用密钥，新试衣暂停':'尚未选择密钥，新试衣暂不可用';
    root.querySelector('.key-help')!.textContent=`故障自动切换，每次最多尝试 ${data.failover.maxAttempts} 个。无效密钥自动停用，临时异常跳过 ${data.failover.cooldownSeconds} 秒。额度不足、限流和参数错误停止请求；额度不足的密钥会跳过，充值后可手动恢复尝试。累计时长按本站实时计时并由云端用量校正，多用户同时生成分别累计。达到 ${data.usageLimitSeconds} 秒后立即结束该密钥的所有连接、删除密文并切换到下一把。`;
    const list=root.querySelector<HTMLElement>('#key-list')!;
    list.innerHTML=data.items.length?data.items.map(item=>{
      const cooling=item.enabled&&item.retryAt>Date.now();
      const state=item.creditState==='insufficient'?'额度不足 · 已跳过':!item.enabled?(item.disabledReason?'自动停用':'已停用'):cooling?'暂时跳过':item.active?'当前使用':'备用';
      const detail=item.disabledReason?`已自动停用：${statuses[item.disabledReason]||'密钥异常'}。修正后可手动启用。`:cooling?`${date(item.retryAt)} 后恢复候选`:'首选密钥失效后，自动使用下一可用密钥。';
      const quota=item.quota?`并发上限 ${item.quota.limit??'未设限'} · 使用中 ${item.quota.active??'未知'} · 剩余 ${item.quota.remaining??'未知'}`:item.quotaCheckedAt?`并发查询：${statuses[item.quotaCode||'']||'暂不可用'}`:'并发名额：尚未查询';
      return `<article class="key-card${item.id===data.nextId?' current':''}${item.enabled?'':' disabled'}" data-key-id="${item.id}"><div class="key-card-heading"><strong>${escape(item.label)}</strong><span class="tag">${state}</span></div><code>${escape(item.masked)}</code><p class="subtle">${item.lastUsedAt?`最近请求 ${date(item.lastUsedAt)} · ${statuses[item.lastCode||'']||'未验证'}`:'尚未请求'}</p><p class="subtle">累计生成 ${Math.round(item.usedSeconds)} / ${data.usageLimitSeconds} 秒，本地计时与云端报告校正。</p><p class="${item.creditState==='insufficient'?'notice-inline':'subtle'}">余额：${item.creditState==='insufficient'?`额度不足（${date(item.creditCheckedAt!)} 返回）`:'官方未提供余额查询'}</p><p class="subtle">${escape(quota)}${item.quotaCheckedAt?`<br>查询时间 ${date(item.quotaCheckedAt)}`:''}</p><p class="subtle">并发名额不代表余额或剩余试衣次数。<a href="https://platform.decart.ai" target="_blank" rel="noopener">查看平台余额</a></p>${item.disabledReason||cooling?`<p class="subtle">${escape(detail)}</p>`:''}<div class="key-actions">${item.creditState==='insufficient'?'<button data-credit>已充值，恢复使用</button>':''}<button data-quota>查询并发</button><button data-activate ${item.active||!item.enabled?'disabled':''}>${item.active?'当前首选':'设为当前'}</button><button data-toggle>${item.enabled?'停用':'启用'}</button><button data-rename>改名</button><button data-remove class="danger" ${item.active&&item.enabled?'disabled':''}>删除</button></div></article>`;
    }).join(''):'<p class="subtle empty-list">还没有密钥</p>';
    if(data.retired?.length)list.insertAdjacentHTML('beforeend',`<section class="retired-keys"><h3>已达上限并删除密文</h3>${data.retired.map(item=>`<p><strong>${escape(item.label)}</strong> <code>${escape(item.masked)}</code><span>${Math.round(item.usedSeconds)} 秒 · ${date(item.retiredAt)} · ${escape(item.endReason==='lifetime_limit'?'达到 450 秒':item.endReason)}</span></p>`).join('')}</section>`);
    for(const card of list.querySelectorAll<HTMLElement>('[data-key-id]')){
      const item=data.items.find(x=>x.id===card.dataset.keyId)!;
      const action=(selector:string,fn:()=>Promise<unknown>)=>{
        const button=card.querySelector<HTMLButtonElement>(selector)!;
        button.onclick=()=>void(async()=>{button.disabled=true;try{await fn();await refresh();}catch(error){errorToast(error);}finally{if(button.isConnected)button.disabled=false;}})();
      };
      if(card.querySelector('[data-credit]'))action('[data-credit]',async()=>{await post(`/api/admin/api-keys/${item.id}/restore-credit`);toast('已允许重新尝试；累计时长保留');});
      action('[data-activate]',async()=>{await post(`/api/admin/api-keys/${item.id}/activate`);toast('已切换，下一次试衣生效');});
      action('[data-quota]',async()=>{await post(`/api/admin/api-keys/${item.id}/quota`);});
      action('[data-toggle]',async()=>{if(item.active&&!confirm('停用当前密钥后，新试衣将暂停。继续停用？'))return;await patch(`/api/admin/api-keys/${item.id}`,{enabled:!item.enabled});});
      action('[data-rename]',async()=>{const label=prompt('密钥名称',item.label);if(label?.trim()&&label.trim()!==item.label)await patch(`/api/admin/api-keys/${item.id}`,{label:label.trim()});});
      action('[data-remove]',async()=>{if(confirm(`删除「${item.label}」？`))await api(`/api/admin/api-keys/${item.id}`,{method:'DELETE'});});
    }
  }
  for(const selector of ['#single-key','#batch-keys']){
    const form=root.querySelector<HTMLFormElement>(selector)!;
    form.onsubmit=event=>{event.preventDefault();void(async()=>{
      const button=form.querySelector<HTMLButtonElement>('button')!,data=new FormData(form);
      button.disabled=true;
      try{
        const value=await post<ImportResult>('/api/admin/api-keys',{keys:data.get('keys')??data.get('key'),...(selector==='#single-key'?{label:data.get('label')}: {})});
        form.reset();result.hidden=false;
        result.textContent=`新增 ${value.added} 个 · 重复 ${value.duplicates} 个 · 无效 ${value.invalid.length} 行${value.invalid.length?'（第 '+value.invalid.map(x=>x.line).join('、')+' 行）':''}`;
        await refresh();
      }catch(error){errorToast(error);}finally{button.disabled=false;}
    })();};
  }
  await refresh();
}
