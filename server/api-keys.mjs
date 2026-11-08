import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fail } from './config.mjs';
import { createProvider, ProviderError } from './provider.mjs';
import { flowLimits } from './tryon-flow.mjs';

const validKey = /^dct_[A-Za-z0-9_.-]{16,252}$/;
const codes = new Set(['OK','INVALID_API_KEY','ACCESS_DENIED','INSUFFICIENT_CREDITS','RATE_LIMITED','INVALID_PARAMETERS','NETWORK_ERROR','PROVIDER_ERROR','INVALID_RESPONSE','KEY_UNREADABLE']);
const permanentFailures = new Set(['INVALID_API_KEY','ACCESS_DENIED','KEY_UNREADABLE']);
export const KEY_FAILOVER = Object.freeze({ maxAttempts:3, attemptTimeoutMs:5000, totalTimeoutMs:12000, cooldownMs:60000 });
// Per-key lifetime budget of billed generation seconds. Reaching it retires the key.
export const KEY_TIME_LIMIT = Object.freeze({ limitSeconds: 450 });

export function createApiKeys(store, options) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS provider_keys (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, encrypted TEXT NOT NULL,
      fingerprint TEXT UNIQUE NOT NULL, suffix TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER, last_code TEXT
    );
    CREATE TABLE IF NOT EXISTS provider_key_config (
      id INTEGER PRIMARY KEY CHECK(id=1), active_id TEXT REFERENCES provider_keys(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS retired_provider_keys (
      fingerprint TEXT PRIMARY KEY, label TEXT NOT NULL, suffix TEXT NOT NULL,
      used_seconds REAL NOT NULL, retired_at INTEGER NOT NULL, end_reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_key_usage (
      tryon_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, key_id TEXT,
      started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      local_seconds REAL NOT NULL DEFAULT 0, reported_seconds REAL NOT NULL DEFAULT 0,
      billed_seconds REAL NOT NULL DEFAULT 0, ended_at INTEGER, end_reason TEXT
    );
  `);
  // Additive migration preserves the existing encrypted keys and selection.
  for(const [table,column,type] of [
    ['provider_keys','retry_at','INTEGER NOT NULL DEFAULT 0'],
    ['provider_keys','disabled_reason','TEXT'],
    ['provider_keys','revision','INTEGER NOT NULL DEFAULT 0'],
    ['provider_keys','quota_json','TEXT'],
    ['provider_keys','quota_checked_at','INTEGER'],
    ['provider_keys','quota_code','TEXT'],
    ['provider_keys','credit_state',"TEXT NOT NULL DEFAULT 'unknown'"],
    ['provider_keys','credit_checked_at','INTEGER'],
    ['provider_keys','used_seconds','REAL NOT NULL DEFAULT 0'],
    ['provider_key_config','revision','INTEGER NOT NULL DEFAULT 0'],
    ['provider_key_config','auto_select','INTEGER NOT NULL DEFAULT 0'],
    ['provider_key_usage','source',"TEXT NOT NULL DEFAULT 'tryon'"],
    ['provider_key_usage','limit_seconds','REAL'],
    ['provider_key_usage','deadline_at','INTEGER'],
    ['provider_key_usage','clock_started','INTEGER NOT NULL DEFAULT 1'],
  ])if(!store.all(`PRAGMA table_info(${table})`).some(row=>row.name===column))store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  const directory=store.safeFile('.secrets'),filename=path.join(directory,'api-keys.key');
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(!existsSync(filename)){
    // Never silently replace a lost encryption key for an existing database.
    if(store.get('SELECT COUNT(*) AS n FROM provider_keys').n)throw new Error('API key encryption file missing; restore data/.secrets/api-keys.key');
    try{writeFileSync(filename,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  }
  if(process.platform!=='win32'){chmodSync(directory,0o700);chmodSync(filename,0o600);}
  const master=readFileSync(filename);
  if(master.length!==32)throw new Error('API key encryption file invalid');
  function encrypt(id,key){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(Buffer.from(id));
    const encrypted=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]);
    return Buffer.concat([iv,encrypted,cipher.getAuthTag()]).toString('base64');
  }
  function decrypt(row){
    const bytes=Buffer.from(row.encrypted,'base64'),decipher=createDecipheriv('aes-256-gcm',master,bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(row.id));decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8');
  }
  const fingerprint=key=>createHmac('sha256',master).update(key).digest('hex');
  store.db.exec('PRAGMA secure_delete=ON');
  function insert(key,label){
    const id=randomUUID(),time=store.now();
    store.run('INSERT INTO provider_keys(id,label,encrypted,fingerprint,suffix,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',id,label,encrypt(id,key),fingerprint(key),key.slice(-6),time,time);
    return id;
  }
  // One-time migration. A deleted/disabled key must not reappear from the old
  // environment configuration on the next process restart.
  if(!store.get('SELECT id FROM provider_key_config WHERE id=1'))store.transaction(()=>{
    const id=options.apiKey?insert(options.apiKey,'原服务器密钥'):null;
    store.run('INSERT INTO provider_key_config(id,active_id) VALUES (1,?)',id);
  });
  const configuration=()=>store.get('SELECT active_id,revision FROM provider_key_config WHERE id=1');
  function candidates(config=configuration()){
    // NULL means an administrator deliberately paused selection. An automatic
    // failure keeps the selected row as an anchor so cooldowns can expire.
    if(!config.active_id)return [];
    return store.all("SELECT * FROM provider_keys WHERE enabled=1 AND credit_state<>'insufficient' AND retry_at<=? AND used_seconds<? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,created_at,rowid",store.now(),KEY_TIME_LIMIT.limitSeconds,config.active_id);
  }
  const rowFor=id=>{const row=store.get('SELECT * FROM provider_keys WHERE id=?',id);if(!row)throw fail(404,'密钥不存在。');return row;};
  function list(){
    const config=configuration(),activeId=config.active_id;
    return {activeId,nextId:candidates(config)[0]?.id||null,failover:{maxAttempts:KEY_FAILOVER.maxAttempts,cooldownSeconds:KEY_FAILOVER.cooldownMs/1000},usageLimitSeconds:KEY_TIME_LIMIT.limitSeconds,items:store.all('SELECT id,label,suffix,enabled,created_at,last_used_at,last_code,retry_at,disabled_reason,quota_json,quota_checked_at,quota_code,credit_state,credit_checked_at,used_seconds FROM provider_keys ORDER BY created_at DESC,rowid DESC').map(row=>({id:row.id,label:row.label,masked:'••••••'+row.suffix,enabled:Boolean(row.enabled),active:row.id===activeId,createdAt:row.created_at,lastUsedAt:row.last_used_at,lastCode:row.last_code,retryAt:row.retry_at,disabledReason:row.disabled_reason,quota:row.quota_json?JSON.parse(row.quota_json):null,quotaCheckedAt:row.quota_checked_at,quotaCode:row.quota_code,creditState:row.credit_state,creditCheckedAt:row.credit_checked_at,usedSeconds:row.used_seconds})),retired:store.all('SELECT label,suffix,used_seconds,retired_at,end_reason FROM retired_provider_keys ORDER BY retired_at DESC LIMIT 100').map(row=>({label:row.label,masked:'••••••'+row.suffix,usedSeconds:row.used_seconds,retiredAt:row.retired_at,endReason:row.end_reason}))};
  }
  const quotaRequests=new Map();
  async function refreshQuota(id){
    const row=rowFor(id);
    if(row.quota_checked_at&&store.now()-row.quota_checked_at<30000)return list();
    if(quotaRequests.has(id))return quotaRequests.get(id);
    const request=(async()=>{
      let data=null,code='OK';
      try{let secret;try{secret=decrypt(row);}catch{throw new ProviderError('密钥无法解密。',503,'KEY_UNREADABLE');}data=await createProvider(secret,options.fetcher).quota();}
      catch(error){code=codes.has(error.code)?error.code:'PROVIDER_ERROR';}
      store.run('UPDATE provider_keys SET quota_json=?,quota_checked_at=?,quota_code=? WHERE id=?',data?JSON.stringify(data):null,store.now(),code,id);
      if(code==='INSUFFICIENT_CREDITS')creditState(id,'insufficient');
      return list();
    })().finally(()=>quotaRequests.delete(id));
    quotaRequests.set(id,request);return request;
  }
  function creditState(id,state){
    if(!['unknown','insufficient'].includes(state))return;
    store.run('UPDATE provider_keys SET credit_state=?,credit_checked_at=? WHERE id=?',state,store.now(),id);
  }
  function restoreCredit(id){
    rowFor(id);
    store.run("UPDATE provider_keys SET credit_state='unknown',credit_checked_at=?,retry_at=0,last_code=CASE WHEN last_code='INSUFFICIENT_CREDITS' THEN NULL ELSE last_code END,revision=revision+1 WHERE id=?",store.now(),id);
    return list();
  }
  function importKeys(text,label){
    if(typeof text!=='string'||text.length>60000)throw fail(400,'请粘贴密钥，每行一个，每次最多 100 行。');
    const lines=text.split(/\r?\n/).map((value,index)=>({key:value.trim(),line:index+1})).filter(x=>x.key);
    if(!lines.length||lines.length>100)throw fail(400,'每次请填写 1–100 个密钥。');
    if(label!==undefined&&(typeof label!=='string'||label.trim().length>60||/dct_[A-Za-z0-9_.-]{16,}/.test(label)))throw fail(400,'名称最多 60 字，请不要在名称中填写密钥。');
    return store.transaction(()=>{
      const result={added:0,duplicates:0,invalid:[]};
      const hadKeys=store.get('SELECT COUNT(*) AS n FROM provider_keys').n>0;
      if(store.get('SELECT COUNT(*) AS n FROM provider_keys').n+lines.length>1000)throw fail(400,'最多保存 1000 个密钥，请先整理已有记录。');
      for(const {key,line} of lines){
        if(!validKey.test(key)){result.invalid.push({line,message:'密钥格式无效'});continue;}
        if(store.get('SELECT id FROM provider_keys WHERE fingerprint=?',fingerprint(key))||store.get('SELECT fingerprint FROM retired_provider_keys WHERE fingerprint=?',fingerprint(key))){result.duplicates++;continue;}
        insert(key,lines.length===1&&label?.trim()?label.trim():`密钥 · ${key.slice(-6)}`);result.added++;
      }
      // Importing after the last key retired itself restores selection; a
      // first-time setup or a deliberate pause keeps requiring a manual choice.
      if(result.added&&!hadKeys){const config=store.get('SELECT active_id,auto_select FROM provider_key_config WHERE id=1');if(config.auto_select&&!config.active_id)store.run('UPDATE provider_key_config SET active_id=(SELECT id FROM provider_keys ORDER BY created_at,rowid LIMIT 1),auto_select=0,revision=revision+1 WHERE id=1');}
      return result;
    });
  }
  function update(id,body){
    rowFor(id);
    if(!body||typeof body!=='object'||body.enabled!==undefined&&typeof body.enabled!=='boolean')throw fail(400,'状态无效。');
    if(body.label!==undefined&&(typeof body.label!=='string'||!body.label.trim()||body.label.trim().length>60||/dct_[A-Za-z0-9_.-]{16,}/.test(body.label)))throw fail(400,'名称无效。');
    store.transaction(()=>{
      if(body.enabled!==undefined){
        store.run('UPDATE provider_keys SET enabled=?,retry_at=0,disabled_reason=NULL,revision=revision+1,updated_at=? WHERE id=?',Number(body.enabled),store.now(),id);
        store.run('UPDATE provider_key_config SET active_id=CASE WHEN active_id=? AND ?=0 THEN NULL ELSE active_id END,auto_select=0,revision=revision+1 WHERE id=1',id,Number(body.enabled));
      }
      if(body.label!==undefined)store.run('UPDATE provider_keys SET label=?,updated_at=? WHERE id=?',body.label.trim(),store.now(),id);
    });
    return list();
  }
  function activate(id){
    const row=rowFor(id);if(!row.enabled)throw fail(409,'请先启用此密钥。');
    decrypt(row);store.run('UPDATE provider_key_config SET active_id=?,auto_select=0,revision=revision+1 WHERE id=1',id);return list();
  }
  function remove(id){
    const row=rowFor(id);
    if(configuration().active_id===id&&row.enabled)throw fail(409,'请先切换或停用当前密钥，再删除。');
    store.transaction(()=>{
      // Preserve other usable keys when deleting an automatically disabled row.
      if(configuration().active_id===id)store.run('UPDATE provider_key_config SET active_id=?,auto_select=0 WHERE id=1',candidates().find(item=>item.id!==id)?.id||null);
      store.run('DELETE FROM provider_keys WHERE id=?',id);
      store.run('UPDATE provider_key_config SET revision=revision+1 WHERE id=1');
    });
  }
  const leases=new Map(),usageByTryon=new Map(),usageByKey=new Map(),frozenKeys=new Set();
  function detachUsage(state){
    usageByTryon.delete(state.tryonId);
    const group=usageByKey.get(state.keyId);group?.delete(state);if(group&&!group.size)usageByKey.delete(state.keyId);
  }
  function persistUsage(state,endedAt=null,endReason=null){
    store.run('UPDATE provider_key_usage SET updated_at=?,local_seconds=?,reported_seconds=?,billed_seconds=?,ended_at=COALESCE(ended_at,?),end_reason=COALESCE(end_reason,?) WHERE tryon_id=?',store.now(),state.localSeconds,state.reportedSeconds,state.billedSeconds,endedAt,endReason,state.tryonId);
  }
  function retire(id,endReason='lifetime_limit'){
    if(frozenKeys.has(id))return;
    frozenKeys.add(id);
    const row=store.get('SELECT fingerprint,label,suffix,used_seconds FROM provider_keys WHERE id=?',id);
    if(!row)return;
    const time=store.now();
    store.transaction(()=>{
      store.run('INSERT INTO retired_provider_keys(fingerprint,label,suffix,used_seconds,retired_at,end_reason) VALUES (?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET label=excluded.label,suffix=excluded.suffix,used_seconds=MAX(retired_provider_keys.used_seconds,excluded.used_seconds),retired_at=excluded.retired_at,end_reason=excluded.end_reason',row.fingerprint,row.label,row.suffix,row.used_seconds,time,endReason);
      const config=configuration();
      if(config.active_id===id){
        const next=candidates(config).find(item=>item.id!==id)?.id||null;
        store.run('UPDATE provider_key_config SET active_id=?,auto_select=?,revision=revision+1 WHERE id=1',next,next?0:1);
      }
      store.run('UPDATE provider_key_usage SET ended_at=COALESCE(ended_at,?),end_reason=COALESCE(end_reason,?),updated_at=? WHERE fingerprint=? AND ended_at IS NULL',time,endReason,time,row.fingerprint);
      store.run('DELETE FROM provider_keys WHERE id=?',id);
    });
    for(const [tryonId,lease] of leases){
      if(lease.keyId!==id)continue;
      leases.delete(tryonId);
      try{lease.cancel?.();}catch{}
      try{lease.onRetire?.(endReason);}catch{}
    }
    for(const state of [...(usageByKey.get(id)||[])])detachUsage(state);
    try{store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}catch{}
    console.info(JSON.stringify({event:'key-retired',label:row.label,suffix:row.suffix,usedSeconds:row.used_seconds,endReason}));
  }
  function applyKeyDelta(id,delta,endReason='lifetime_limit'){
    const amount=Math.max(0,Number(delta)||0);
    if(!amount||frozenKeys.has(id))return;
    const row=store.get('SELECT used_seconds FROM provider_keys WHERE id=?',id);
    if(!row)return;
    const total=Math.min(KEY_TIME_LIMIT.limitSeconds,row.used_seconds+amount);
    store.run('UPDATE provider_keys SET used_seconds=? WHERE id=?',total,id);
    if(total>=KEY_TIME_LIMIT.limitSeconds)retire(id,endReason);
  }
  function pulseKey(keyId,mono=performance.now()){
    const states=[...(usageByKey.get(keyId)||[])];if(!states.length||frozenKeys.has(keyId))return;
    const row=store.get('SELECT used_seconds FROM provider_keys WHERE id=?',keyId);if(!row){for(const state of states)detachUsage(state);return;}
    const changes=states.map(state=>{
      state.localSeconds=Math.max(state.localSeconds,Math.min(state.localLimit??Infinity,Math.max(0,(mono-state.startedMono)/1000)));
      const target=Math.max(state.localSeconds,state.reportedSeconds);
      return {state,delta:Math.max(0,target-state.billedSeconds)};
    });
    const requested=changes.reduce((sum,item)=>sum+item.delta,0);
    if(requested<=0){for(const {state} of changes)persistUsage(state);return;}
    const room=Math.max(0,KEY_TIME_LIMIT.limitSeconds-row.used_seconds),ratio=Math.min(1,room/requested);
    let added=0;
    for(const {state,delta} of changes){const billed=delta*ratio;state.billedSeconds+=billed;added+=billed;persistUsage(state);}
    const total=Math.min(KEY_TIME_LIMIT.limitSeconds,row.used_seconds+added);
    store.run('UPDATE provider_keys SET used_seconds=? WHERE id=?',total,keyId);
    if(total>=KEY_TIME_LIMIT.limitSeconds)retire(keyId,'lifetime_limit');
  }
  function beginUsage(tryonId){
    const lease=leases.get(tryonId);if(!lease||frozenKeys.has(lease.keyId))return false;
    const key=store.get('SELECT fingerprint,used_seconds FROM provider_keys WHERE id=? AND enabled=1',lease.keyId);
    if(!key||key.used_seconds>=KEY_TIME_LIMIT.limitSeconds){retire(lease.keyId);return false;}
    if(usageByTryon.has(tryonId))return true;
    const existing=store.get('SELECT * FROM provider_key_usage WHERE tryon_id=?',tryonId);
    if(existing?.ended_at)return false;
    const time=store.now(),mono=performance.now();
    store.run('INSERT OR IGNORE INTO provider_key_usage(tryon_id,fingerprint,key_id,started_at,updated_at) VALUES (?,?,?,?,?)',tryonId,key.fingerprint,lease.keyId,time,time);
    const session=store.get('SELECT * FROM tryons WHERE id=?',tryonId);
    const reportLimit=lease.usageSource==='parallel-self'?lease.usageLimitSeconds:Number(session?.flow_version)>0?flowLimits(session).generationSeconds:60;
    if(lease.usageSource==='parallel-self')store.run('UPDATE provider_key_usage SET started_at=?,updated_at=?,clock_started=1 WHERE tryon_id=? AND clock_started=0',time,time,tryonId);
    const localLimit=lease.usageSource==='parallel-self'?Math.min(reportLimit,Math.max(0,(lease.usageDeadlineAt-time)/1000)):Infinity;
    const state={tryonId,keyId:lease.keyId,fingerprint:key.fingerprint,startedMono:mono,reportLimit,localLimit,localSeconds:0,reportedSeconds:0,billedSeconds:0};
    usageByTryon.set(tryonId,state);if(!usageByKey.has(state.keyId))usageByKey.set(state.keyId,new Set());usageByKey.get(state.keyId).add(state);
    return true;
  }
  function reportUsage(tryonId,seconds){
    let state=usageByTryon.get(tryonId);
    if(!state&&!beginUsage(tryonId))return;
    state=usageByTryon.get(tryonId);if(!state)return;
    state.reportedSeconds=Math.max(state.reportedSeconds,Math.max(0,Math.min(state.reportLimit,Number(seconds)||0)));
    pulseKey(state.keyId);
  }
  function endUsage(tryonId,endReason='session_ended'){
    const state=usageByTryon.get(tryonId);
    if(state){pulseKey(state.keyId);if(usageByTryon.has(tryonId)){persistUsage(state,store.now(),endReason);detachUsage(state);}}
    else store.run('UPDATE provider_key_usage SET ended_at=COALESCE(ended_at,?),end_reason=COALESCE(end_reason,?),updated_at=? WHERE tryon_id=?',store.now(),endReason,store.now(),tryonId);
    leases.delete(tryonId);
  }
  function recordUsage(id,seconds){applyKeyDelta(id,seconds);}
  function recoverInterruptedUsage(){
    const time=store.now();
    for(const row of store.all('SELECT * FROM provider_key_usage WHERE ended_at IS NULL')){
      const session=store.get('SELECT * FROM tryons WHERE id=?',row.tryon_id);
      const modern=Number(session?.flow_version)>0;
      const external=row.source==='parallel-self';
      const limit=external?Math.min(105,Math.max(0,Number(row.limit_seconds)||105)):modern?flowLimits(session).generationSeconds:60;
      const connectionDeadline=external?row.deadline_at??row.started_at+limit*1000:modern&&session.hard_deadline_at?session.hard_deadline_at:modern&&session.connection_started_at?session.connection_started_at+flowLimits(session).connectionSeconds*1000:row.started_at+limit*1000;
      const end=Math.min(time,connectionDeadline,session?.ended_at??Infinity);
      const elapsed=Math.max(0,Math.min(limit,(end-row.started_at)/1000));
      const local=Math.max(row.local_seconds,elapsed),target=Math.max(local,row.reported_seconds),delta=Math.max(0,target-row.billed_seconds);
      const current=store.get('SELECT used_seconds FROM provider_keys WHERE id=?',row.key_id);
      let billed=row.billed_seconds;
      if(current&&delta>0){const add=Math.min(delta,Math.max(0,KEY_TIME_LIMIT.limitSeconds-current.used_seconds));billed+=add;store.run('UPDATE provider_keys SET used_seconds=? WHERE id=?',Math.min(KEY_TIME_LIMIT.limitSeconds,current.used_seconds+add),row.key_id);}
      store.run("UPDATE provider_key_usage SET updated_at=?,local_seconds=?,billed_seconds=?,ended_at=?,end_reason='service_restart_recovery' WHERE tryon_id=?",time,local,billed,time,row.tryon_id);
      if(current&&current.used_seconds+delta>=KEY_TIME_LIMIT.limitSeconds)retire(row.key_id,'lifetime_limit');
    }
  }
  async function token(model,duration,origin,{signal,tryonId,onRetire,usageSource='tryon',usageLimitSeconds,usageDeadlineAt}={}){
    signal?.throwIfAborted();
    if(usageSource!=='tryon'){
      if(usageSource!=='parallel-self'||!/^parallel:[0-9a-f-]{36}$/.test(tryonId||'')||!Number.isFinite(usageLimitSeconds)||usageLimitSeconds<=0||usageLimitSeconds>105||!Number.isSafeInteger(usageDeadlineAt)||usageDeadlineAt<=store.now()||usageDeadlineAt>store.now()+105000)throw fail(400,'外部会话限制无效。');
      if(store.get('SELECT 1 FROM provider_key_usage WHERE tryon_id=?',tryonId))throw fail(409,'外部会话已使用，不能重新建立。');
    }
    // Self-heal capped rows an interrupted retire left behind, before reading the selection.
    for(const row of store.all('SELECT id FROM provider_keys WHERE enabled=1 AND used_seconds>=?',KEY_TIME_LIMIT.limitSeconds))retire(row.id);
    const initial=configuration(),attempted=new Set();
    if(!initial.active_id)throw new ProviderError('尚未选择可用的 API 密钥，请在后台配置。',503,'KEY_MISSING');
    const deadline=AbortSignal.timeout(KEY_FAILOVER.totalTimeoutMs);
    const requestSignal=AbortSignal.any([deadline,...(signal?[signal]:[])]);
    let lastError=new ProviderError('暂无可用的 API 密钥，请稍后重试或在后台检查。',503,'KEY_UNAVAILABLE');
    while(attempted.size<KEY_FAILOVER.maxAttempts){
      signal?.throwIfAborted();
      const config=configuration();
      // Manual selection/disable wins over a delayed failure from an older request.
      if(config.revision!==initial.revision||deadline.aborted)throw lastError;
      const row=candidates(config).find(item=>!attempted.has(item.id));
      if(!row)throw lastError;
      attempted.add(row.id);
      store.run('UPDATE provider_key_config SET active_id=? WHERE id=1 AND revision=?',row.id,initial.revision);
      const requestAbort=new AbortController();
      const lease={keyId:row.id,onRetire,usageSource,usageLimitSeconds,usageDeadlineAt,cancel:()=>requestAbort.abort()};
      if(tryonId)leases.set(tryonId,lease);
      try{
        let secret;
        try{secret=decrypt(row);}catch{throw new ProviderError('此 API 密钥无法解密，请重新添加。',503,'KEY_UNREADABLE');}
        const attemptSignal=AbortSignal.any([requestSignal,requestAbort.signal]);
        const result=await createProvider(secret,options.fetcher).token(model,duration,origin,{signal:attemptSignal,timeoutMs:KEY_FAILOVER.attemptTimeoutMs});
        signal?.throwIfAborted();
        if(requestAbort.signal.aborted||frozenKeys.has(row.id)||!store.get('SELECT id FROM provider_keys WHERE id=? AND used_seconds<?',row.id,KEY_TIME_LIMIT.limitSeconds))throw new ProviderError('密钥使用上限已到，本次试衣已结束。',409,'KEY_RETIRED');
        lease.cancel=null;
        // Persist external token leases before releasing them. A restart with
        // unknown upstream progress must conservatively settle this bounded
        // interval, even when no old-project tryons row exists.
        if(usageSource==='parallel-self')store.run("INSERT INTO provider_key_usage(tryon_id,fingerprint,key_id,started_at,updated_at,source,limit_seconds,deadline_at,clock_started) VALUES (?,?,?,?,?,'parallel-self',?,?,0)",tryonId,row.fingerprint,row.id,store.now(),store.now(),usageLimitSeconds,usageDeadlineAt);
        store.run('UPDATE provider_keys SET last_used_at=?,last_code=?,retry_at=0,revision=revision+1 WHERE id=? AND revision=?',store.now(),'OK',row.id,row.revision);
        return {...result,keyId:row.id};
      }catch(error){
        if(leases.get(tryonId)===lease)leases.delete(tryonId);
        // User cancellation must not disable a healthy key or start another request.
        signal?.throwIfAborted();
        if(requestAbort.signal.aborted||frozenKeys.has(row.id))throw new ProviderError('密钥使用上限已到，本次试衣已结束。',409,'KEY_RETIRED');
        if(deadline.aborted)error=new ProviderError('连接 Decart 超时，请稍后重试。',502,'NETWORK_ERROR');
        const code=codes.has(error.code)?error.code:'PROVIDER_ERROR';
        if(code==='INSUFFICIENT_CREDITS')creditState(row.id,'insufficient');
        const permanent=permanentFailures.has(code);
        const temporary=code==='NETWORK_ERROR'||code==='INVALID_RESPONSE'||code==='PROVIDER_ERROR'&&error.status>=500;
        store.run('UPDATE provider_keys SET last_used_at=?,last_code=?,enabled=CASE WHEN ? THEN 0 ELSE enabled END,disabled_reason=?,retry_at=?,revision=revision+1 WHERE id=? AND revision=?',store.now(),code,Number(permanent),permanent?code:null,temporary?store.now()+KEY_FAILOVER.cooldownMs:0,row.id,row.revision);
        lastError=error;
        // Credits, rate limits and invalid request parameters stop this request.
        if(!permanent&&!temporary||deadline.aborted)throw error;
      }
    }
    throw lastError;
  }
  recoverInterruptedUsage();
  const usageTimer=setInterval(()=>{for(const keyId of usageByKey.keys())pulseKey(keyId);},100);
  usageTimer.unref();
  return {list,importKeys,update,activate,remove,token,refreshQuota,creditState,restoreCredit,recordUsage,beginUsage,reportUsage,endUsage,close:()=>clearInterval(usageTimer),configured:()=>candidates().length>0};
}
