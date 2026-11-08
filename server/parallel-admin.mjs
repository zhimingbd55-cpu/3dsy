import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fail } from './config.mjs';

const INTERNAL = '/api/internal/admin';
const boundedNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sessionId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
const statusNames = new Set(['reserved','connecting','observing','active','ended']);
const providerNames = new Set(['disabled','mock','decart']);

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid bridge origin');
  return url.origin;
}
function publicOrigin(value) {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}
function cleanSession(row) {
  if (!row || !sessionId(row.id) || !statusNames.has(row.status) || !providerNames.has(row.providerMode)) throw fail(502,'平行的我返回了无效会话数据。');
  const look = row.look && typeof row.look === 'object' ? row.look : {};
  return {
    id:row.id,status:row.status,providerMode:row.providerMode,
    createdAt:boundedNumber(row.createdAt),readyAt:boundedNumber(row.readyAt),endedAt:boundedNumber(row.endedAt),
    endReason:typeof row.endReason === 'string' && /^[a-z_]{1,60}$/.test(row.endReason) ? row.endReason : null,
    usageSeconds:boundedNumber(row.usageSeconds),revision:boundedNumber(row.revision),acknowledgedRevision:boundedNumber(row.acknowledgedRevision),
    look:Object.fromEntries(['direction','hair','beauty','garment'].map(key=>[key,typeof look[key]==='string'&&/^[a-z0-9_-]{1,80}$/.test(look[key])?look[key]:null])),
  };
}

/** Fixed management operations only; never forward browser headers or arbitrary URLs. */
export function mountParallelAdmin(app, auth, options) {
  const prefix = '/api/admin/parallel-self';
  app.use(prefix, auth.requireAdmin);
  function bridgeConfig(){
    let origin, token;
    try {
      origin = loopbackOrigin(options.parallelAdminOrigin || 'http://127.0.0.1:8776');
      token = (options.parallelAdminBridgeFile ? readFileSync(options.parallelAdminBridgeFile, 'utf8') : options.parallelAdminBridgeToken || '').trim();
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Bridge not configured');
    } catch { throw fail(503,'平行的我的独立管理连接尚未配置，请检查部署设置。'); }
    return {origin,token};
  }
  async function call(route, method = 'GET', body) {
    const {origin,token}=bridgeConfig();
    let response, value;
    try {
      response = await fetch(origin + INTERNAL + route, {
        method,redirect:'manual',signal:AbortSignal.timeout(3000),
        headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if(response.status===404)throw fail(404,'平行的我的会话不存在。');
        if([401,403].includes(response.status))throw fail(503,'平行的我的管理连接认证失败，请检查部署设置。');
        throw fail(503,'平行的我暂时无法完成操作，请稍后重试。');
      }
      const reader=response.body?.getReader();if(!reader)throw new Error('Missing body');
      const chunks=[];let bytes=0;
      for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>128*1024){await reader.cancel();throw new Error('Response too large');}chunks.push(Buffer.from(item.value));}
      value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch(error) {
      if(error?.expose)throw error;
      throw fail(503,'平行的我暂时无法连接，请稍后重试。');
    }
    return value;
  }
  const cleanOverview = data => {
    if (data?.projectId !== 'parallel-self-poc-v1' || !providerNames.has(data.providerMode) || typeof data.paused !== 'boolean') throw fail(502,'平行的我管理数据不匹配，请检查独立服务配置。');
    return {
      projectId:data.projectId,providerMode:data.providerMode,liveReady:data.liveReady===true,paused:data.paused,
      providerSource:data.providerSource==='shared-tryon'?'shared-tryon':'independent',
      stage:'effect-validation',publicOrigin:publicOrigin(options.parallelPublicOrigin),
      ...Object.fromEntries(['activeSessions','maxConcurrent','totalBudgetSeconds','usedSeconds','remainingSeconds','dailyBudgetSeconds','dailyUsedSeconds','dailyRemainingSeconds','reservedSeconds','sessionCount'].map(key=>[key,boundedNumber(data[key])])),
    };
  };
  app.get(prefix + '/overview', async(req,res) => res.json(cleanOverview(await call('/overview'))));
  app.get(prefix + '/sessions', async(req,res) => {
    const keys=Object.keys(req.query);if(keys.some(key=>key!=='limit'))throw fail(400,'不支持的查询参数。');
    const limit=req.query.limit===undefined?20:Number(req.query.limit);
    if(!Number.isInteger(limit)||limit<1||limit>100)throw fail(400,'记录数量应为 1 至 100。');
    const data=await call(`/sessions?limit=${limit}`);
    if(!Array.isArray(data?.sessions))throw fail(502,'平行的我返回了无效会话列表。');
    res.json({sessions:data.sessions.slice(0,limit).map(cleanSession)});
  });
  app.patch(prefix + '/settings', async(req,res) => {
    if(!req.body||Object.keys(req.body).length!==1||typeof req.body.paused!=='boolean')throw fail(400,'仅允许设置是否暂停新体验。');
    const data=await call('/settings','PATCH',{paused:req.body.paused});
    res.json(cleanOverview(data));
  });
  app.post(prefix + '/sessions/:id/end', async(req,res) => {
    if(!sessionId(req.params.id)||Object.keys(req.body||{}).length)throw fail(400,'结束会话参数无效。');
    res.json(cleanSession(await call(`/sessions/${req.params.id}/end`,'POST',{})));
  });
  const cleanWork=row=>{
    const states=new Set(['pending','uploading','processing','ready','error','expired','deleted']);
    if(!row||!sessionId(row.id)||!states.has(row.status))throw fail(502,'平行的我返回了无效作品数据。');
    const recording=kind=>{const item=row[kind]||{};return {state:states.has(item.state)?item.state:'pending',receivedChunks:boundedNumber(item.receivedChunks),totalChunks:boundedNumber(item.totalChunks),durationMs:boundedNumber(item.durationMs),complete:item.complete===true,videoUrl:typeof item.videoUrl==='string'?`${prefix}/works/${row.id}/${kind}/video`:null,posterUrl:typeof item.posterUrl==='string'?`${prefix}/works/${row.id}/${kind}/poster`:null};};
    return {id:row.id,createdAt:boundedNumber(row.createdAt),expiresAt:boundedNumber(row.expiresAt),status:row.status,shareActive:row.shareActive===true,original:recording('original'),result:recording('result')};
  };
  app.get(prefix+'/works',async(req,res)=>{
    if(Object.keys(req.query).some(key=>key!=='limit'))throw fail(400,'不支持的查询参数。');
    const limit=req.query.limit===undefined?20:Number(req.query.limit);if(!Number.isInteger(limit)||limit<1||limit>100)throw fail(400,'记录数量应为 1 至 100。');
    const data=await call(`/works?limit=${limit}`);if(!Array.isArray(data?.works))throw fail(502,'平行的我返回了无效作品列表。');
    res.json({works:data.works.slice(0,limit).map(cleanWork)});
  });
  app.get(prefix+'/works/:id',async(req,res)=>{if(!sessionId(req.params.id))throw fail(404,'作品不存在。');res.json(cleanWork(await call(`/works/${req.params.id}`)));});
  app.post(prefix+'/works/:id/share/revoke',async(req,res)=>{if(!sessionId(req.params.id)||Object.keys(req.body||{}).length)throw fail(400,'参数无效。');const data=await call(`/works/${req.params.id}/share/revoke`,'POST',{});if(data?.revoked!==true)throw fail(502,'关闭分享尚未确认。');res.json({revoked:true});});
  app.delete(prefix+'/works/:id',async(req,res)=>{if(!sessionId(req.params.id)||Object.keys(req.body||{}).length)throw fail(400,'参数无效。');const data=await call(`/works/${req.params.id}`,'DELETE');if(data?.deleted!==true)throw fail(502,'永久删除尚未确认。');res.json({deleted:true});});
  app.get(prefix+'/works/:id/:kind/:media',async(req,res)=>{
    const {id,kind,media}=req.params;
    if(!sessionId(id)||!['original','result'].includes(kind)||!['video','poster'].includes(media)||Object.keys(req.query).some(key=>key!=='download')||(req.query.download!==undefined&&req.query.download!=='1'))throw fail(404,'视频不存在。');
    if(req.headers.range&&!/^bytes=\d*-\d*$/.test(req.headers.range))throw fail(416,'不支持的视频范围。');
    const {origin,token}=bridgeConfig(),controller=new AbortController();
    let timer=setTimeout(()=>controller.abort(),3000);const cancel=()=>controller.abort();res.once('close',cancel);
    try{
      const response=await fetch(`${origin}${INTERNAL}/works/${id}/${kind}/${media}`,{redirect:'manual',signal:controller.signal,headers:{Authorization:`Bearer ${token}`,...(req.headers.range?{Range:req.headers.range}:{})}});
      clearTimeout(timer);timer=setTimeout(()=>controller.abort(),120000);
      if(!response.ok){await response.body?.cancel();throw fail(response.status===404?404:response.status===416?416:503,response.status===404?'视频不存在或已失效。':'视频暂时无法读取。');}
      if(!response.body)throw fail(503,'视频暂时无法读取。');
      const type=response.headers.get('content-type')?.split(';')[0];if(!['video/mp4','video/webm','image/jpeg','image/png','image/webp'].includes(type)){await response.body.cancel();throw fail(502,'媒体格式无效。');}
      res.status(response.status).set({'Content-Type':type,'Cache-Control':'private, no-store','Content-Disposition':`${req.query.download==='1'?'attachment':'inline'}; filename="parallel-${id}-${kind}.${media==='video'?(type==='video/webm'?'webm':'mp4'):(type==='image/png'?'png':type==='image/webp'?'webp':'jpg')}"`});
      for(const header of ['content-length','content-range','accept-ranges']){const value=response.headers.get(header);if(value)res.set(header,value);}
      await pipeline(Readable.fromWeb(response.body),res);
    }catch(error){if(res.headersSent){res.destroy();return;}if(error?.expose)throw error;throw fail(503,'视频暂时无法读取。');}
    finally{clearTimeout(timer);res.off('close',cancel);}
  });
}
