import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID, randomBytes, createHmac, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { createStore, beijingDay } from './store.mjs';
import { createAuth } from './auth.mjs';
import { createApiKeys } from './api-keys.mjs';
import { createMedia, normalizeImage } from './media.mjs';
import { createGarmentThumbnails } from './garment-thumbnails.mjs';
import sharp from 'sharp';
import { config, fail, publicError, DURATION } from './config.mjs';
import { FLOW_VERSION, DEMO_GARMENT_IDS, flowLimits, flowJson } from './tryon-flow.mjs';
import { renderSocialMetadata } from './social-meta.mjs';
import { createAnalytics } from './analytics.mjs';
import { mountParallelAdmin } from './parallel-admin.mjs';

export function createApp(input = {}) {
  const options = { ...config, ...input };
  const store = createStore(options.dataDirectory, options), auth=createAuth(store,options), media=createMedia(store,options), apiKeys=createApiKeys(store,options);
  const analytics=createAnalytics(store);
  const garmentThumbnails=createGarmentThumbnails();
  const shareKeyPath=store.safeFile('.secrets/video-shares.key');mkdirSync(path.dirname(shareKeyPath),{recursive:true,mode:0o700});
  if(!existsSync(shareKeyPath))writeFileSync(shareKeyPath,randomBytes(32),{flag:'wx',mode:0o600});
  if(process.platform!=='win32')chmodSync(shareKeyPath,0o600);
  const shareKey=readFileSync(shareKeyPath);if(shareKey.length!==32)throw new Error('Video share encryption key invalid');
  const shareHash=token=>createHash('sha256').update(token).digest('hex');
  const encryptShareToken=token=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',shareKey,iv),value=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return Buffer.concat([iv,value,cipher.getAuthTag()]).toString('base64');};
  const decryptShareToken=value=>{const bytes=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',shareKey,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8');};
  const app = express();
  const pageTemplates=new Map();
  async function socialPage(res,template,pagePath){
    const file=path.resolve(options.root||process.cwd(),options.dev?template:`dist/${template}`);
    let pending=pageTemplates.get(file);
    if(!pending||options.dev){pending=readFile(file,'utf8');if(!options.dev)pageTemplates.set(file,pending);}
    let html;try{html=await pending;}catch(error){pageTemplates.delete(file);throw error;}
    res.set('Cache-Control','private, no-store').type('html').send(renderSocialMetadata(html,options.origin,pagePath));
  }
  let realtime;
  const incoming=store.safeFile('temporary/incoming'); mkdirSync(incoming,{recursive:true});
  const disk = multer.diskStorage({destination:incoming,filename:(req,file,cb) => cb(null,randomUUID()+'.upload')});
  const upload = multer({storage:disk,limits:{fileSize:20*1024*1024,files:2,fields:4}});
  const adminUpload=multer({storage:disk,limits:{fileSize:100*1024*1024,files:1,fields:3}});
  app.disable('x-powered-by'); app.set('trust proxy','loopback');
  app.use((req,res,next) => {
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Permissions-Policy':'camera=(self), microphone=(), web-share=(self)','X-Frame-Options':'DENY'});
    if (options.origin.startsWith('https:')) res.set('Strict-Transport-Security','max-age=31536000');
    if (!options.dev) res.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob: https: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (req.headers.host !== new URL(options.origin).host || (req.headers.origin && req.headers.origin !== options.origin)) return next(fail(403,'访问来源不受支持。'));
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin !== options.origin) return next(fail(403,'请从网站页面发起操作。'));
    if (req.path.startsWith('/api/')) res.set('Cache-Control','no-store');
    next();
  });
  app.use(express.json({limit:'64kb'}));
  function bindAgent(visitorId, codeOrId, byId=false) {
    if(typeof codeOrId!=='string'||!codeOrId)return null;
    return store.transaction(()=>{
      const current=store.get('SELECT agent_id FROM visitors WHERE id=?',visitorId);
      if(!current)return null;
      if(current.agent_id)return store.get('SELECT * FROM agents WHERE id=?',current.agent_id)||null;
      const agent=store.get(`SELECT * FROM agents WHERE ${byId?'id':'code'}=?`,codeOrId);
      if(!agent||!agent.active)return null;
      store.run('UPDATE visitors SET agent_id=? WHERE id=? AND agent_id IS NULL',agent.id,visitorId);
      const bound=store.get('SELECT agent_id FROM visitors WHERE id=?',visitorId);
      return bound?.agent_id?store.get('SELECT * FROM agents WHERE id=?',bound.agent_id)||null:null;
    });
  }
  const visitor = (req,res) => {
    const user=auth.visitor(req,res);
    const referral=typeof req.query?.ref==='string'?req.query.ref:null;
    if(referral)bindAgent(user.id,referral);
    return store.get('SELECT * FROM visitors WHERE id=?',user.id);
  };
  const garmentJson = row => ({id:row.id,name:row.name,category:row.category,categoryKnown:Boolean(row.category_known),owned:Boolean(row.owner_id),published:Boolean(row.published),position:row.position,demoOrder:row.owner_id===null&&DEMO_GARMENT_IDS.includes(row.id)?DEMO_GARMENT_IDS.indexOf(row.id)+1:null,assetType:row.model_path?'3d':'2d',hasModel:Boolean(row.model_path),thumbnailUrl:row.image_path?`/api/garments/${row.id}/thumbnail`:null,imageUrl:row.image_path?`/api/garments/${row.id}/image`:null,modelUrl:row.model_path?`/api/garments/${row.id}/model`:null,createdAt:row.created_at});
  function garment(req,res,write=false) {
    const row=store.get('SELECT * FROM garments WHERE id=?',req.params.id);
    if (!row) throw fail(404,'衣服不存在。');
    if (auth.isAdmin(req)) return row;
    const owner=visitor(req,res);
    if (write ? row.owner_id!==owner.id : row.owner_id!==owner.id && (row.owner_id!==null || !row.published)) throw fail(404,'衣服不存在。');
    return row;
  }
  function tryon(req,res) {
    const row=store.get('SELECT * FROM tryons WHERE id=?',req.params.id);
    if (!row || (!auth.isAdmin(req) && row.visitor_id!==visitor(req,res).id)) throw fail(404,'视频不存在。');
    return row;
  }
  const recordJson = row => {const video=media.playable(row);return {id:row.id,kind:row.kind,status:row.status,duration:video?.duration??row.duration,url:video?`/api/recordings/${row.id}/video`:null,poster:video?`/api/recordings/${row.id}/poster`:null,recovered:Boolean(video?.recovered),...media.describe(row)};};
  const tryonJson = row => ({id:row.id,visitorId:row.visitor_id,garmentName:row.garment_name,target:row.target||null,createdAt:row.created_at,admittedAt:row.admitted_at,queue:store.queueInfo(row.id),expiresAt:row.created_at+30*86400000,status:row.status,interrupted:Boolean(row.interrupted),userHiddenAt:row.user_hidden_at,shareActive:Boolean(store.get('SELECT 1 FROM video_shares WHERE tryon_id=? AND revoked_at IS NULL AND expires_at>?',row.id,store.now())),generationSeconds:row.generation_seconds,error:row.error,endReason:row.end_reason??null,serverNow:store.now(),hardDeadlineAt:row.hard_deadline_at??null,recordingDeadlineAt:row.recording_deadline_at??null,autoDeadlineAt:row.auto_deadline_at??null,...flowJson(store,row),startup:{preparationMs:row.preparation_ms??0,countdownMs:row.countdown_ms??0,countdownVersion:row.countdown_version??1,readyAt:row.ready_at??null,connectionStartedAt:row.connection_started_at??null,imageAccepted:Boolean(row.image_accepted_at),imageAcceptedAt:row.image_accepted_at??null,generationStartedAt:row.generation_started_at??null,firstFrameAt:row.first_frame_at??null,recordingStartedAt:row.recording_started_at??null,stableVideoAt:row.stable_video_at??null,stableWindowMs:row.stable_window_ms??null,stableFrames:row.stable_frames??null,stabilityMode:row.stability_mode??null,promptVersion:row.prompt_version??null},recordings:store.all('SELECT * FROM recordings WHERE tryon_id=? ORDER BY kind',row.id).map(recordJson)});
  const adminTryonJson = row => {const captured=store.get('SELECT captured_at,summary FROM stream_metrics WHERE tryon_id=?',row.id),item=tryonJson(row);return {...item,startup:{...item.startup,referenceHash:row.reference_hash??null,promptSnapshot:row.prompt_snapshot??null},performance:captured?{capturedAt:captured.captured_at,...JSON.parse(captured.summary)}:null};};
  function shareFor(token){
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{40,60}$/.test(token))throw fail(404,'分享链接不存在或已失效。');
    const row=store.get('SELECT s.*,t.id AS shared_tryon_id,t.garment_name,t.created_at AS tryon_created_at FROM video_shares s JOIN tryons t ON t.id=s.tryon_id WHERE s.token_hash=?',shareHash(token));
    if(!row||row.revoked_at)throw fail(404,'分享链接不存在或已失效。');
    if(row.expires_at<=store.now()||row.tryon_created_at+30*86400000<=store.now())throw fail(410,'分享已到期。');
    return row;
  }
  function shareRecording(share,kind){
    if(!['original','result'].includes(kind))throw fail(404,'视频不存在。');
    const row=store.get('SELECT * FROM recordings WHERE tryon_id=? AND kind=?',share.shared_tryon_id,kind);
    if(!row)throw fail(404,'视频不存在。');
    return row;
  }
  function businessContact(agentId){
    const settings=store.settings(),assigned=agentId?store.get('SELECT * FROM agents WHERE id=?',agentId):null;
    const agent=assigned?.active?assigned:null;
    const name=agent?.name||settings.businessName||'1➕衣商务';
    const wechatId=agent?(agent.wechat_id||''):(settings.businessWechat||'');
    const qrPath=agent?(agent.qr_path||''):(settings.businessQrPath||'');
    const referralPath=agent?`/a/${agent.code}`:null;
    return {name,wechatId,source:agent?'agent':'official',label:agent?'推荐代理':'官方商务',qrUrl:qrPath?`/api/business-contact/qr?v=${encodeURIComponent(String(agent?.updated_at||settings.businessUpdatedAt||0))}`:null,referralPath,contactPath:`/?${agent?`ref=${encodeURIComponent(agent.code)}&`:''}contact=1#business`};
  }
  const contactQrWrites=new Map();
  async function saveContactQr(buffer,{agentId=null}={}){
    // Serialize replacement per contact so each committed image owns its cleanup.
    // Separate contacts can still upload independently.
    const key=agentId||'official',prior=contactQrWrites.get(key)||Promise.resolve();
    const pending=prior.catch(()=>{}).then(()=>persistContactQr(buffer,agentId));
    contactQrWrites.set(key,pending);
    try{return await pending;}finally{if(contactQrWrites.get(key)===pending)contactQrWrites.delete(key);}
  }
  async function persistContactQr(buffer,agentId){
    if(!Buffer.isBuffer(buffer)||!buffer.length)throw fail(400,'请选择有效的二维码图片。');
    let decoded,metadata;
    try{
      decoded=sharp(buffer,{limitInputPixels:16000000,animated:false,failOn:'error'});metadata=await decoded.metadata();
      if(!['jpeg','png','webp'].includes(metadata.format)||!metadata.width||!metadata.height||metadata.pages&&metadata.pages>1||metadata.width<128||metadata.height<128||metadata.width>4096||metadata.height>4096)throw new Error('format');
    }catch{throw fail(400,'请上传单页有效 JPG、PNG 或 WebP 二维码（128–4096 像素）。');}
    const border=Math.max(12,Math.ceil(Math.min(metadata.width,metadata.height)*.05));
    let png;
    try{png=await decoded.rotate().extend({top:border,bottom:border,left:border,right:border,background:'#ffffff'}).png({compressionLevel:9,palette:false}).toBuffer();}catch{throw fail(400,'二维码图片无法解码。');}
    const folder=agentId?path.join('files','agents',agentId):path.join('files','business-contact');
    const destination=path.join(folder,`contact-${randomUUID()}.png`),temporary=path.join(folder,`contact-${randomUUID()}.tmp`);
    store.canWrite(png.length);await mkdir(store.safeFile(folder),{recursive:true});
    let committed=false;
    try{
      await writeFile(store.safeFile(temporary),png,{flag:'wx'});
      await rename(store.safeFile(temporary),store.safeFile(destination));
      const row=agentId?store.get('SELECT qr_path,updated_at FROM agents WHERE id=?',agentId):null,settings=store.settings();
      const old=agentId?row?.qr_path:settings.businessQrPath;
      const updated=Math.max(store.now(),Number((agentId?row?.updated_at:settings.businessUpdatedAt)||0)+1);
      if(agentId)store.run('UPDATE agents SET qr_path=?,updated_at=? WHERE id=?',destination,updated,agentId);
      else store.transaction(()=>{store.run('UPDATE settings SET value=? WHERE key=?',JSON.stringify(destination),'businessQrPath');store.run('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)', 'businessUpdatedAt',JSON.stringify(updated));});
      committed=true;
      if(old&&old!==destination)await rm(store.safeFile(old),{force:true}).catch(()=>{});
      return {qrUrl:agentId?`/api/admin/agents/${agentId}/qr?v=${updated}`:`/api/admin/business-contact/qr?v=${updated}`,updatedAt:updated};
    }catch(error){
      await rm(store.safeFile(temporary),{force:true}).catch(()=>{});
      if(!committed)await rm(store.safeFile(destination),{force:true}).catch(()=>{});
      throw error;
    }
  }
  function contactQrPath(agentId){
    const settings=store.settings(),agent=agentId?store.get('SELECT * FROM agents WHERE id=?',agentId):null;
    return agent?.active?agent.qr_path:settings.businessQrPath;
  }
  function agentJson(row){
    const counts=row.browser_count===undefined?store.get(`SELECT
      (SELECT COUNT(*) FROM visitors WHERE agent_id=?) AS browser_count,
      (SELECT COUNT(*) FROM tryons WHERE agent_id=?) AS tryon_count,
      (SELECT COALESCE(SUM(generation_seconds),0) FROM tryons WHERE agent_id=?) AS generation_seconds`,row.id,row.id,row.id):row;
    return {id:row.id,code:row.code,name:row.name,wechatId:row.wechat_id,active:Boolean(row.active),hasQr:Boolean(row.qr_path),qrUrl:row.qr_path?`/api/admin/agents/${row.id}/qr?v=${row.updated_at}`:null,referralUrl:`${options.origin}/a/${row.code}`,createdAt:row.created_at,updatedAt:row.updated_at,browserCount:Number(counts.browser_count),tryonCount:Number(counts.tryon_count),generationSeconds:Number(counts.generation_seconds)};
  }
  function defaultBusinessContactJson(){
    const settings=store.settings();
    return {name:settings.businessName||'1➕衣商务',wechatId:settings.businessWechat||'',hasQr:Boolean(settings.businessQrPath),qrUrl:settings.businessQrPath?`/api/admin/business-contact/qr?v=${settings.businessUpdatedAt||0}`:null,updatedAt:settings.businessUpdatedAt||0};
  }
  const limitWrites=(req,res,next) => { try { store.rate(`write:${req.ip}`,60,60000); const max=(req.path.startsWith('/api/admin/')?101:req.path==='/api/garments'?26:21)*1024*1024;const size=Number(req.headers['content-length'])||max;if(size>max)throw fail(413,'上传文件超出限制。');const release=store.reserveWrite(size);res.once('finish',release);res.once('close',release);next(); } catch (e) { next(e); } };
  app.get('/api/health',(req,res) => res.json({name:'1➕衣',version:'2.0.0',ok:true}));
  app.get(['/', '/index.html'],async(req,res)=>{
    // Reading metadata never creates a visitor or binds an agent. Existing
    // first-touch ownership takes precedence over a later referral parameter.
    let existing=null;try{existing=auth.visitor(req,null,false);}catch(error){if(error.status!==401)throw error;}
    const agent=existing?.agent_id?store.get('SELECT code,active FROM agents WHERE id=?',existing.agent_id):typeof req.query.ref==='string'?store.get('SELECT code,active FROM agents WHERE code=?',req.query.ref):null;
    res.vary('Cookie');
    await socialPage(res,'index.html',agent?.active?`/a/${agent.code}`:'/');
  });
  app.get('/a/:code',(req,res)=>{
    const user=auth.visitor(req,res),agent=bindAgent(user.id,String(req.params.code||''));
    const effective=agent?.active?agent:null;
    res.set('Cache-Control','no-store').redirect(302,effective?`/?ref=${encodeURIComponent(effective.code)}`:'/');
  });
  app.get('/api/business-contact',(req,res)=>{
    const user=visitor(req,res);res.set('Referrer-Policy','no-referrer').json(businessContact(user.agent_id));
  });
  app.get('/api/business-contact/qr',(req,res)=>{
    const user=visitor(req,res),relative=contactQrPath(user.agent_id);
    if(!relative)throw fail(404,'当前商务联系人尚未上传二维码。');
    res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).type('png').sendFile(store.safeFile(relative),{dotfiles:'allow'});
  });
  app.get('/manifest.webmanifest',(req,res)=>{
    const user=visitor(req,res),agent=user.agent_id?store.get('SELECT code,active FROM agents WHERE id=?',user.agent_id):null;
    const startUrl=agent?.active?`/?ref=${encodeURIComponent(agent.code)}`:'/';
    res.set('Cache-Control','no-store').type('application/manifest+json').json({id:'/',name:'1➕衣',short_name:'1➕衣',start_url:startUrl,scope:'/',display:'standalone',background_color:'#fafafa',theme_color:'#fafafa',description:'1➕衣移动试衣',icons:[{src:'/brand/icon-192.png',sizes:'192x192',type:'image/png'},{src:'/brand/icon-512.png',sizes:'512x512',type:'image/png'}]});
  });
  app.get('/api/me',(req,res) => {
    const user=visitor(req,res), quota=store.quota(user.id), space=store.storage();
    try{analytics.enable(user.id);}catch{/* Optional analytics must not prevent camera/session initialization. */}
    res.json({consented:Boolean(user.consent_at),remaining:Math.max(0,quota.dailyUser-quota.userUsed),dailyLimit:quota.dailyUser,duration:DURATION,available:apiKeys.configured()&&!quota.paused&&quota.siteUsed<quota.dailySite,storageFull:space.used+space.reserved>=space.limit||space.free<space.minFree});
  });
  app.post('/api/analytics/events',(req,res)=>{const user=auth.visitor(req,res,false);res.json(analytics.receive(user.id,req.body));});
  app.post('/api/analytics/presence',(req,res)=>{const user=auth.visitor(req,res,false);res.json(analytics.presence(user.id,req.body));});
  app.post('/api/me/consent',(req,res) => { const user=visitor(req,res); store.run('UPDATE visitors SET consent_at=? WHERE id=?',store.now(),user.id); res.json({consented:true}); });
  app.get('/api/garments',(req,res) => { const user=visitor(req,res); res.json(store.all("SELECT * FROM garments WHERE (owner_id IS NULL AND published=1) OR owner_id=? ORDER BY CASE WHEN id='maid-lolita' THEN 0 WHEN id='fantasy-outfit-07' THEN 1 ELSE 2 END,owner_id DESC,position ASC,created_at DESC",user.id).map(garmentJson).sort((a,b)=>(a.demoOrder??99)-(b.demoOrder??99))); });
  app.post('/api/garments',limitWrites,upload.fields([{name:'file',maxCount:1},{name:'reference',maxCount:1}]),async(req,res) => {
    const files=req.files||{},file=files.file?.[0],reference=files.reference?.[0];
    if (!file) { if(reference)await rm(reference.path,{force:true}).catch(()=>{}); throw fail(400,'请选择服装图片或 GLB 模型。'); }
    const user=visitor(req,res); file.originalname=Buffer.from(file.originalname,'latin1').toString('utf8');
    res.status(201).json(garmentJson(await media.addGarment(file,user.id,req.body,reference)));
  });
  app.get('/api/garments/:id/image',(req,res) => { const row=garment(req,res); if (!row.image_path) throw fail(404,'参考图尚未生成。'); res.type('webp').sendFile(store.safeFile(row.image_path),{dotfiles:'allow'}); });
  app.get('/api/garments/:id/thumbnail',async(req,res) => {
    const row=garment(req,res);if(!row.image_path)throw fail(404,'参考图尚未生成。');
    const {buffer,etag}=await garmentThumbnails.get(store.safeFile(row.image_path));
    // Encoding may yield; a deleted/unpublished garment must not be served afterwards.
    const current=garment(req,res);if(current.image_path!==row.image_path)throw fail(409,'参考图已更新，请重新加载。');
    res.set({'Cache-Control':'private, max-age=0, must-revalidate','ETag':etag});
    res.type('webp').send(buffer);
  });
  app.get('/api/garments/:id/original',(req,res) => { const row=garment(req,res,true); res.download(store.safeFile(row.original_path),row.original_name,{dotfiles:'allow'}); });
  app.get('/api/garments/:id/model',(req,res) => { const row=garment(req,res); if (!row.model_path) throw fail(404,'没有三维模型。'); res.type('model/gltf-binary').sendFile(store.safeFile(row.model_path),{dotfiles:'allow'}); });
  app.patch('/api/garments/:id',(req,res) => {
    const row=garment(req,res,true), body=req.body || {};
    const name=String(body.name ?? row.name).trim();
    if (!name || name.length>80) throw fail(400,'名称长度须为 1–80 字。');
    const category=body.category ?? row.category;
    if (!['top','bottom','outfit','accessory'].includes(category)) throw fail(400,'服装类别无效。');
    const admin=auth.isAdmin(req);if(body.details!==undefined&&!admin)throw fail(403,'只有管理员可以修改服装细节描述。');
    const details=body.details===undefined?(row.details||''):String(body.details).trim();if(details.length>350)throw fail(400,'服装细节描述不能超过 350 个字符。');
    const published=admin&&body.published!==undefined?Number(Boolean(body.published)):row.published;
    if (published&&!row.image_path) throw fail(400,'请先生成服装参考图。');
    const position=admin&&body.position!==undefined?Number(body.position):row.position;
    if (!Number.isInteger(position)||Math.abs(position)>100000) throw fail(400,'排序无效。');
    const categoryKnown=Number(Boolean(row.category_known)||body.category!==undefined);
    store.run('UPDATE garments SET name=?,category=?,category_known=?,details=?,published=?,position=? WHERE id=?',name,category,categoryKnown,details,published,position,row.id);
    res.json(garmentJson(store.get('SELECT * FROM garments WHERE id=?',row.id)));
  });
  app.delete('/api/garments/:id',async(req,res) => { const row=garment(req,res,true); if (store.get("SELECT 1 FROM tryons WHERE status IN ('queued','reserved','connecting','recording') AND (garment_id=? OR flow_locked_garment_id=? OR EXISTS(SELECT 1 FROM json_each(COALESCE(tryons.flow_playlist,'[]')) WHERE value=?))",row.id,row.id,row.id)) throw fail(409,'这件衣服正在排队或试穿，请稍后删除。'); await rm(store.safeFile(path.join('files',row.id)),{recursive:true,force:true}); store.run('DELETE FROM garments WHERE id=?',row.id); res.status(204).end(); });
  app.post('/api/tryons',(req,res) => {
    if (!apiKeys.configured()) throw fail(503,'试衣暂未就绪。');
    store.rate(`start:${req.ip}`,60,60000);
    const flowVersion=req.body.flowVersion??0,mode=req.body.mode??'fixed';
    if(![0,FLOW_VERSION].includes(flowVersion)||!['auto','fixed'].includes(mode)||(flowVersion===0&&req.body.mode!==undefined))throw fail(400,'试衣流程版本或模式无效。');
    const user=visitor(req,res), row=store.get('SELECT * FROM garments WHERE id=?',flowVersion===FLOW_VERSION&&mode==='auto'?DEMO_GARMENT_IDS[0]:String(req.body.garmentId || ''));
    if (!row?.image_path || (row.owner_id!==user.id&&(row.owner_id!==null||!row.published))) throw fail(404,'请选择一件可试穿的衣服。');
    if(flowVersion===FLOW_VERSION&&mode==='auto')for(const id of DEMO_GARMENT_IDS){const item=store.get('SELECT image_path,owner_id,published FROM garments WHERE id=?',id);if(!item?.image_path||item.owner_id!==null||!item.published||!existsSync(store.safeFile(item.image_path)))throw fail(409,'自动试衣服装暂不可用，请选择一件服装再开始。');}
    store.rate(`start-user:${user.id}`,10,60000);
    const target=req.body.target;
    if(target!==undefined&&!['top','bottom','outfit'].includes(target))throw fail(400,'替换部位无效。');
    const bounded=(value,max,label)=>{if(value===undefined)return 0;if(!Number.isInteger(value)||value<0||value>max)throw fail(400,`${label}无效。`);return value;};
    const preparationMs=bounded(req.body.preparationMs,600000,'准备时间'),countdownMs=bounded(req.body.countdownMs,30000,'倒数时间'),countdownVersion=req.body.countdownVersion??1;
    if(![1,2,3].includes(countdownVersion)||!Number.isInteger(countdownVersion))throw fail(400,'倒数版本无效。');
    if(flowVersion===FLOW_VERSION&&(![2,3].includes(countdownVersion)||req.body.countdownMs===undefined))throw fail(400,'请完成站位倒数后再开始。');
    if(countdownVersion===3&&req.body.countdownMs===undefined)throw fail(400,'请完成 5 秒站位倒数后再开始。');
    if(req.body.countdownMs!==undefined&&((countdownVersion===1&&(countdownMs<2500||countdownMs>4000))||(countdownVersion===2&&(countdownMs<7900||countdownMs>30000))||(countdownVersion===3&&(countdownMs<4900||countdownMs>30000))))throw fail(400,countdownVersion===3?'请完成至少 5 秒站位倒数后再开始。':countdownVersion===2?'请完成至少 8 秒站位倒数后再开始。':'请完成 3 秒站位倒数后再开始。');
    res.status(201).json(tryonJson(store.reserve(user,row,{acceptRecording:req.body.acceptRecording===true,allowQueue:req.body.queue===true,target:flowVersion===FLOW_VERSION?row.category:target||row.category,preparationMs,countdownMs,countdownVersion,flowVersion,mode})));
  });
  app.get('/api/tryons',(req,res) => { const user=visitor(req,res); res.json(store.all('SELECT * FROM tryons WHERE visitor_id=? AND user_hidden_at IS NULL ORDER BY created_at DESC LIMIT 100',user.id).map(tryonJson)); });
  app.get('/api/tryons/:id',(req,res) => res.json(tryonJson(tryon(req,res))));
  app.post('/api/tryons/:id/lock',(req,res)=>{const row=tryon(req,res);if(typeof req.body.garmentId!=='string'||req.body.garmentId.length>100)throw fail(400,'服装选择无效。');realtime.lock(row.id,req.body.garmentId);res.json(tryonJson(store.get('SELECT * FROM tryons WHERE id=?',row.id)));});
  app.post('/api/tryons/:id/stable',(req,res)=>{const row=tryon(req,res);realtime.stable(row.id,req.body);res.json(tryonJson(store.get('SELECT * FROM tryons WHERE id=?',row.id)));});
  app.post('/api/tryons/:id/share',(req,res)=>{
    const user=visitor(req,res),row=tryon(req,res),expiresAt=row.created_at+30*86400000,agentId=row.agent_id||user.agent_id||null;
    if(expiresAt<=store.now())throw fail(410,'视频已到期，无法分享。');
    const result=store.get("SELECT * FROM recordings WHERE tryon_id=? AND kind='result'",row.id);
    if(!result||!media.playable(result))throw fail(409,'试穿成片保存完成后即可分享。');
    let existing=store.get('SELECT * FROM video_shares WHERE tryon_id=?',row.id);
    if(existing&&!existing.revoked_at&&existing.expires_at>store.now()){
      if(!existing.agent_id&&agentId)store.run('UPDATE video_shares SET agent_id=? WHERE tryon_id=? AND agent_id IS NULL',agentId,row.id);
      return res.json({url:`${options.origin}/s/${decryptShareToken(existing.token_cipher)}`,expiresAt:existing.expires_at});
    }
    const token=randomBytes(32).toString('base64url'),createdAt=store.now();
    store.run('INSERT INTO video_shares(tryon_id,agent_id,token_hash,token_cipher,created_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(tryon_id) DO UPDATE SET agent_id=COALESCE(video_shares.agent_id,excluded.agent_id),token_hash=excluded.token_hash,token_cipher=excluded.token_cipher,created_at=excluded.created_at,expires_at=excluded.expires_at,revoked_at=NULL',row.id,agentId,shareHash(token),encryptShareToken(token),createdAt,expiresAt);
    res.json({url:`${options.origin}/s/${token}`,expiresAt});
  });
  app.get('/api/shares/:token',(req,res)=>{
    const share=shareFor(req.params.token),summary={garmentName:share.garment_name,createdAt:share.tryon_created_at,expiresAt:share.expires_at};
    let currentAgentId=null;try{currentAgentId=auth.visitor(req,null,false).agent_id;}catch(error){if(error.status!==401)throw error;}
    const referralAgent=store.get('SELECT code,active FROM agents WHERE id=?',currentAgentId||share.agent_id||'');
    summary.tryOnUrl=referralAgent?.active?`/a/${encodeURIComponent(referralAgent.code)}`:'/';
    for(const kind of ['original','result']){
      const recording=shareRecording(share,kind),video=media.playable(recording),details=media.describe(recording);
      summary[kind]={status:video?'ready':recording.status,duration:video?.duration??recording.duration,videoUrl:video?`/api/shares/${req.params.token}/${kind}/video`:null,posterUrl:video?`/api/shares/${req.params.token}/${kind}/poster`:null,waitingForUpload:details.waitingForUpload,error:details.error};
    }
    res.set({'Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'}).json(summary);
  });
  app.get('/api/shares/:token/:kind/video',(req,res)=>{
    const share=shareFor(req.params.token),recording=shareRecording(share,req.params.kind),video=media.playable(recording);
    if(!video)throw fail(404,'视频尚不可用。');
    res.set({'Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'}).type('mp4').sendFile(store.safeFile(video.final_path),{dotfiles:'allow'});
  });
  app.get('/api/shares/:token/:kind/poster',(req,res)=>{
    const share=shareFor(req.params.token),recording=shareRecording(share,req.params.kind),video=media.playable(recording);
    if(!video)throw fail(404,'视频封面尚不可用。');
    res.set({'Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'}).type('jpeg').sendFile(store.safeFile(video.poster_path),{dotfiles:'allow'});
  });
  app.get('/s/:token',async(req,res)=>{const share=shareFor(req.params.token),user=auth.visitor(req,res);try{analytics.enable(user.id);}catch{/* Sharing remains available if optional analytics storage fails. */}if(!user.agent_id&&share.agent_id)bindAgent(user.id,share.agent_id,true);res.set({'Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=()','X-Robots-Tag':'noindex, nofollow'});await socialPage(res,'share.html',`/s/${req.params.token}`);});
  app.post('/api/tryons/:id/queue',(req,res)=>{const row=tryon(req,res);store.rate(`queue:${row.id}`,90,60000);res.json(tryonJson(store.heartbeatQueue(row.id)));});
  app.post('/api/tryons/:id/ready',(req,res)=>{
    const row=tryon(req,res),body=req.body||{},preparationMs=body.preparationMs??0,countdownMs=body.countdownMs??0,countdownVersion=body.countdownVersion??row.countdown_version??1;
    if(countdownVersion<(row.countdown_version??1))throw fail(400,'本次试衣的倒数版本不能降低。');
    if(row.flow_version===FLOW_VERSION&&![2,3].includes(countdownVersion))throw fail(400,'请完成站位倒数后再开始。');
    if(![1,2,3].includes(countdownVersion)||!Number.isInteger(countdownVersion)||!Number.isInteger(preparationMs)||preparationMs<0||preparationMs>600000||!Number.isInteger(countdownMs)||(countdownVersion===1&&(countdownMs<2500||countdownMs>4000))||(countdownVersion===2&&(countdownMs<7900||countdownMs>30000))||(countdownVersion===3&&(countdownMs<4900||countdownMs>30000)))throw fail(400,'站位倒数信息无效。');
    res.json(tryonJson(store.markReady(row.id,row.visitor_id,{preparationMs,countdownMs,countdownVersion})));
  });
  app.post('/api/tryons/:id/performance',(req,res)=>{
    const row=tryon(req,res);store.rate(`performance:${row.id}`,3,60000);
    if(!row.first_frame_at||store.now()-row.first_frame_at>10*60000)throw fail(409,'本次试衣未开始或已过期。');
    const body=req.body||{},summary={};
    for(const [key,max] of [['samples',300],['sentFps',120],['receivedFps',120],['rttMs',120000],['droppedFrames',1200000],['cpuLimitedSamples',300],['bandwidthLimitedSamples',300],['sendBitrateBps',100000000],['receiveBitrateBps',100000000],['availableOutgoingBps',100000000],['freezeMs',600000],['decodeMs',120000],['sendQueueDelayMs',120000],['lossFraction',1],['cameraFps',120],['presentedFps',120],['paintP95Ms',120000],['presentedDrops',1200000],['glassToGlassMs',120000],['relayPathSamples',300],['directPathSamples',300],['outputStallMs',600000],['outputStallCount',120],['playbackRecoveryAttempts',120],['playbackRecoveries',120]]){
      const value=body[key];
      if(value===undefined||value===null){summary[key]=null;continue;}
      if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max)throw fail(400,'性能数据无效。');
      const precision=key==='lossFraction'?10000:10;summary[key]=Math.round(value*precision)/precision;
    }
    summary.qualityMode=body.qualityMode??'standard';summary.fluidReason=body.fluidReason??null;summary.senderParametersApplied=body.senderParametersApplied??null;
    if(!['standard','fluid','smooth','reduced'].includes(summary.qualityMode)||!['cpu','upstream','device',null].includes(summary.fluidReason)||![true,false,null].includes(summary.senderParametersApplied))throw fail(400,'性能模式数据无效。');
    summary.configVersion=body.configVersion??null;summary.initialProfile=body.initialProfile??null;summary.finalProfile=body.finalProfile??null;
    if(![null,'smooth-v1','smooth-v2'].includes(summary.configVersion)||![null,'smooth'].includes(summary.initialProfile)||![null,'smooth','reduced','draw-only'].includes(summary.finalProfile))throw fail(400,'性能配置数据无效。');
    summary.cameraConstraintResult=body.cameraConstraintResult??null;
    if(![null,'matched','adjusted','fallback','unknown'].includes(summary.cameraConstraintResult))throw fail(400,'相机规格调整结果无效。');
    for(const [key,max] of [['actualCameraWidth',4096],['actualCameraHeight',4096],['actualCameraFps',120],['previewFps',120],['previewLongGapMs',600000]]){
      const value=body[key];if(value===undefined||value===null){summary[key]=null;continue;}
      if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max||(['actualCameraWidth','actualCameraHeight'].includes(key)&&!Number.isInteger(value)))throw fail(400,'相机或预览性能数据无效。');
      summary[key]=Math.round(value*10)/10;
    }
    for(const [key,max] of [['actualSendWidth',4096],['actualSendHeight',4096],['actualSimulcastLayers',8],['targetSendBitrateBps',100000000]]){
      const value=body[key];if(value===undefined||value===null){summary[key]=null;continue;}
      if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max||(['actualSendWidth','actualSendHeight','actualSimulcastLayers'].includes(key)&&!Number.isInteger(value)))throw fail(400,'实际发送规格无效。');
      summary[key]=Math.round(value);
    }
    if(!Number.isInteger(summary.samples)||summary.samples<1||summary.cpuLimitedSamples>summary.samples||summary.bandwidthLimitedSamples>summary.samples||summary.relayPathSamples>summary.samples||summary.directPathSamples>summary.samples)throw fail(400,'性能样本无效。');
    // Store only bounded numeric diagnostics, never candidate IPs, raw SDK
    // reports, credentials or video. Retention follows the parent recording.
    store.run('INSERT INTO stream_metrics VALUES (?,?,?) ON CONFLICT(tryon_id) DO UPDATE SET captured_at=excluded.captured_at,summary=excluded.summary',row.id,store.now(),JSON.stringify(summary));
    res.status(204).end();
  });
  app.get('/api/tryons/:id/transport',(req,res) => {
    const row=tryon(req,res);
    const admitted=row.admitted_at??row.created_at;
    if (!['reserved','connecting','recording'].includes(row.status) || store.now()-admitted>45000) throw fail(409,'本次连接已结束。');
    if (!options.turnSecret || !options.turnHost) return res.json({iceServers:[]});
    // One short-lived credential per reserved session, never a public open relay.
    const username=`${Math.floor((admitted+(row.flow_version===FLOW_VERSION?300000:75000))/1000)}:${row.id}`;
    const credential=createHmac('sha1',options.turnSecret).update(username).digest('base64');
    res.json({iceServers:[{urls:[`turn:${options.turnHost}:3478?transport=udp`,`turn:${options.turnHost}:3478?transport=tcp`,`turns:${options.turnHost}:5349?transport=tcp`],username,credential}]});
  });
  app.post('/api/tryons/:id/diagnostic',(req,res) => {
    const row=tryon(req,res);store.rate(`diagnostic:${row.id}`,8,60000);
    const codes={ICE_CONNECT_FAILED:'视频通道连接失败',SIGNAL_FAILED:'信令连接失败',MEDIA_FAILED:'视频处理失败',TIMEOUT:'连接或生成超时'};
    if (!(req.body.code in codes)) throw fail(400,'诊断类型无效。');
    const platform=['ios','android','desktop'].includes(req.body.platform)?req.body.platform:'unknown';
    // A late browser disconnect must not replace the provider's actual cause.
    store.run('UPDATE tryons SET error=COALESCE(error,?) WHERE id=?',`${codes[req.body.code]} (${platform})`,row.id);
    res.status(204).end();
  });
  app.post('/api/tryons/:id/started',(req,res) => {
    const row=tryon(req,res),body=req.body||{},mode=body.stabilityMode,stableWindowMs=body.stableWindowMs,stableFrames=body.stableFrames;
    const hasStability=mode!==undefined||stableWindowMs!==undefined||stableFrames!==undefined;
    if(!hasStability&&Number(row.countdown_version||1)<2){
      // Cached v1 pages do not send frame-stability telemetry. Keep them able to
      // start recording after the existing server-side image/generation checks.
      store.run("UPDATE tryons SET stability_mode=COALESCE(stability_mode,'legacy-client') WHERE id=?",row.id);
    }else{
      if(!['video-frame-callback','decoded-frame-counter','weak-playback'].includes(mode)||!Number.isInteger(stableWindowMs)||stableWindowMs<2000||stableWindowMs>30000||(mode!=='weak-playback'&&(!Number.isInteger(stableFrames)||stableFrames<3||stableFrames>10000))||(mode==='weak-playback'&&stableFrames!==null))throw fail(400,'稳定画面观测数据无效。');
      store.run('UPDATE tryons SET stable_video_at=?,stable_window_ms=?,stable_frames=?,stability_mode=? WHERE id=? AND stable_video_at IS NULL',store.now(),stableWindowMs,stableFrames,mode,row.id);
    }
    realtime.startRecording(row.id,body);res.json({duration:flowLimits(row).recordingSeconds});
  });
  app.post('/api/tryons/:id/recording-started',(req,res)=>{const row=tryon(req,res);realtime.recordingStarted(row.id);res.status(204).end();});
  app.post('/api/tryons/:id/finish',(req,res) => { const row=tryon(req,res); realtime.finish(row.id,req.body.interrupted!==false); media.settle(row.id); res.json(tryonJson(store.get('SELECT * FROM tryons WHERE id=?',row.id))); });
  // Old cached pages used this endpoint to destroy files and local upload jobs.
  // Reject it so their old success handler cannot discard unuploaded footage.
  app.delete('/api/tryons/:id',(req,res) => { tryon(req,res); throw fail(409,'视频管理已更新，请刷新页面后操作。'); });
  app.post('/api/tryons/:id/hide',(req,res)=>{tryon(req,res);throw fail(409,'用户视频无法移除。');});
  app.put('/api/tryons/:id/recordings/:kind/chunks/:seq',express.raw({type:'application/octet-stream',limit:'2mb'}),async(req,res) => {
    const row=tryon(req,res), recording=store.get('SELECT * FROM recordings WHERE tryon_id=? AND kind=?',row.id,req.params.kind);
    if (!recording) throw fail(404,'视频不存在。');
    await media.uploadChunk(recording,Number(req.params.seq),req.body,req.headers['x-recording-type']); res.status(204).end();
  });
  app.post('/api/tryons/:id/recordings/:kind/complete',async(req,res) => { const row=tryon(req,res), recording=store.get('SELECT * FROM recordings WHERE tryon_id=? AND kind=?',row.id,req.params.kind); if (!recording) throw fail(404,'视频不存在。'); await media.complete(recording,req.body.chunks); res.json({accepted:true}); });
  app.post('/api/tryons/:id/recordings/:kind/manifest',async(req,res)=>{const row=tryon(req,res),recording=store.get('SELECT * FROM recordings WHERE tryon_id=? AND kind=?',row.id,req.params.kind);if(!recording)throw fail(404,'视频不存在。');await media.manifest(recording,req.body.chunks,req.body.mime);res.json({accepted:true});});
  app.post('/api/tryons/:id/recordings/:kind/retry',async(req,res)=>{const row=tryon(req,res),recording=store.get('SELECT * FROM recordings WHERE tryon_id=? AND kind=?',row.id,req.params.kind);if(!recording)throw fail(404,'视频不存在。');store.rate(`media-retry:${recording.id}`,3,60000);await media.retry(recording);res.json({accepted:true});});
  function ownRecording(req,res) {
    const row=store.get('SELECT r.*,t.visitor_id FROM recordings r JOIN tryons t ON t.id=r.tryon_id WHERE r.id=?',req.params.id);
    if (!row || (!auth.isAdmin(req)&&row.visitor_id!==visitor(req,res).id)) throw fail(404,'视频尚不可用。');
    const video=media.playable(row);if(!video)throw fail(404,'视频尚不可用。');
    return {...row,...video};
  }
  app.get('/api/recordings/:id/video',(req,res) => { const row=ownRecording(req,res);if(req.query.download==='1'&&!auth.isAdmin(req))throw fail(409,'用户视频不提供下载，请使用分享视频。');if(req.query.download==='1')res.download(store.safeFile(row.final_path),`1➕衣-${row.kind==='result'?'试穿':'原片'}${row.recovered?'-恢复片段':''}-${row.tryon_id.slice(0,8)}.mp4`,{dotfiles:'allow'});else res.type('mp4').sendFile(store.safeFile(row.final_path),{dotfiles:'allow'}); });
  app.get('/api/recordings/:id/poster',(req,res) => { const row=ownRecording(req,res); res.type('jpeg').sendFile(store.safeFile(row.poster_path),{dotfiles:'allow'}); });
  app.post('/api/admin/login',(req,res) => res.json(auth.login(req,res)));
  app.post('/api/admin/logout',(req,res) => { auth.logout(req,res); res.status(204).end(); });
  app.use('/api/admin',auth.requireAdmin);
  mountParallelAdmin(app,auth,options);
  app.get('/api/admin/analytics',(req,res)=>res.json(analytics.report(req.query)));
  app.get('/api/admin/agents',(req,res)=>{
    const items=store.all(`SELECT a.*,
      (SELECT COUNT(*) FROM visitors v WHERE v.agent_id=a.id) AS browser_count,
      (SELECT COUNT(*) FROM tryons t WHERE t.agent_id=a.id) AS tryon_count,
      (SELECT COALESCE(SUM(t.generation_seconds),0) FROM tryons t WHERE t.agent_id=a.id) AS generation_seconds
      FROM agents a ORDER BY a.created_at DESC,a.id ASC`);
    res.json({items:items.map(agentJson),defaultContact:defaultBusinessContactJson()});
  });
  app.post('/api/admin/agents',(req,res)=>{
    const body=req.body||{},name=String(body.name||'').trim(),wechat=String(body.wechatId||'').trim();
    if(!name||name.length>80||wechat.length>100||(body.active!==undefined&&typeof body.active!=='boolean'))throw fail(400,'代理名称、微信号或启用状态无效。');
    let code;do{code=randomBytes(9).toString('base64url');}while(store.get('SELECT 1 FROM agents WHERE code=?',code));
    const id=randomUUID(),time=store.now();store.run('INSERT INTO agents(id,code,name,wechat_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',id,code,name,wechat,body.active===false?0:1,time,time);
    res.status(201).json(agentJson(store.get('SELECT * FROM agents WHERE id=?',id)));
  });
  app.patch('/api/admin/agents/:id',(req,res)=>{
    const row=store.get('SELECT * FROM agents WHERE id=?',req.params.id);if(!row)throw fail(404,'代理不存在。');
    const body=req.body||{},name=String(body.name??row.name).trim(),wechat=String(body.wechatId??row.wechat_id).trim();
    if(!name||name.length>80||wechat.length>100||(body.active!==undefined&&typeof body.active!=='boolean'))throw fail(400,'代理资料无效。');
    const updated=Math.max(store.now(),row.updated_at+1);
    store.run('UPDATE agents SET name=?,wechat_id=?,active=?,updated_at=? WHERE id=?',name,wechat,body.active===undefined?row.active:Number(body.active),updated,row.id);
    res.json(agentJson(store.get('SELECT * FROM agents WHERE id=?',row.id)));
  });
  app.put('/api/admin/agents/:id/qr',express.raw({type:['image/png','image/jpeg','image/webp'],limit:'5mb'}),async(req,res)=>{
    const agent=store.get('SELECT * FROM agents WHERE id=?',req.params.id);if(!agent)throw fail(404,'代理不存在。');
    res.json(await saveContactQr(req.body,{agentId:agent.id}));
  });
  app.get('/api/admin/agents/:id/qr',(req,res)=>{const row=store.get('SELECT qr_path FROM agents WHERE id=?',req.params.id);if(!row?.qr_path)throw fail(404,'代理尚未上传二维码。');res.type('png').sendFile(store.safeFile(row.qr_path),{dotfiles:'allow'});});
  app.put('/api/admin/business-contact',(req,res)=>{
    const body=req.body||{},name=String(body.name||'').trim(),wechat=String(body.wechatId||'').trim();
    if(!name||name.length>80||wechat.length>100)throw fail(400,'官方商务资料无效。');
    const updated=Math.max(store.now(),Number(store.settings().businessUpdatedAt||0)+1);
    store.transaction(()=>{store.run('UPDATE settings SET value=? WHERE key=?',JSON.stringify(name),'businessName');store.run('UPDATE settings SET value=? WHERE key=?',JSON.stringify(wechat),'businessWechat');store.run('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)','businessUpdatedAt',JSON.stringify(updated));});
    res.json(defaultBusinessContactJson());
  });
  app.put('/api/admin/business-contact/qr',express.raw({type:['image/png','image/jpeg','image/webp'],limit:'5mb'}),async(req,res)=>{res.json(await saveContactQr(req.body));});
  app.get('/api/admin/business-contact/qr',(req,res)=>{const relative=store.settings().businessQrPath;if(!relative)throw fail(404,'官方商务尚未上传二维码。');res.type('png').sendFile(store.safeFile(relative),{dotfiles:'allow'});});
  app.delete('/api/admin/tryons/:id',(req,res)=>{const row=tryon(req,res);if(media.isRecovering(row.id))throw fail(409,'正在恢复片段，请稍后删除。');store.deleteTryon(row.id,'admin');res.status(204).end();});
  app.post('/api/admin/tryons/:id/share/revoke',(req,res)=>{const row=tryon(req,res);store.run('UPDATE video_shares SET revoked_at=COALESCE(revoked_at,?) WHERE tryon_id=?',store.now(),row.id);res.status(204).end();});
  app.post('/api/admin/tryons/:id/restore',(req,res)=>{store.restoreTryon(req.params.id);res.status(204).end();});
  app.post('/api/admin/tryons/:id/recordings/:kind/recover',async(req,res)=>{const row=tryon(req,res),record=store.get('SELECT * FROM recordings WHERE tryon_id=? AND kind=?',row.id,req.params.kind);if(!record)throw fail(404,'视频不存在。');store.rate(`recover:${row.id}`,4,60000);await media.recoverPartial(record);res.json(tryonJson(store.get('SELECT * FROM tryons WHERE id=?',row.id)));});
  app.get('/api/admin/api-keys',(req,res)=>res.json(apiKeys.list()));
  app.post('/api/admin/api-keys/:id/quota',async(req,res)=>{store.rate(`key-quota:${req.ip}`,30,60000);res.json(await apiKeys.refreshQuota(req.params.id));});
  app.post('/api/admin/api-keys',(req,res)=>{
    store.rate(`key-import:${req.ip}`,20,60000);
    res.json(apiKeys.importKeys(req.body?.keys,req.body?.label));
  });
  app.patch('/api/admin/api-keys/:id',(req,res)=>res.json(apiKeys.update(req.params.id,req.body)));
  app.post('/api/admin/api-keys/:id/restore-credit',(req,res)=>res.json(apiKeys.restoreCredit(req.params.id)));
  app.post('/api/admin/api-keys/:id/activate',(req,res)=>res.json(apiKeys.activate(req.params.id)));
  app.delete('/api/admin/api-keys/:id',(req,res)=>{apiKeys.remove(req.params.id);res.status(204).end();});
  app.get('/api/admin/overview',(req,res) => {
    const day=beijingDay(store.now()), usage=store.get('SELECT COALESCE(SUM(used),0) AS count,COALESCE(SUM(seconds),0) AS seconds FROM usage WHERE day=?',day);
    res.json({settings:store.settings(),storage:store.storage(),today:usage,active:store.get("SELECT COUNT(*) AS n FROM tryons WHERE status IN ('reserved','connecting','recording')").n,waiting:store.get("SELECT COUNT(*) AS n FROM tryons WHERE status='queued'").n,day});
  });
  app.patch('/api/admin/settings',(req,res) => {
    const body=req.body || {};
    for (const [key,min,max] of [['dailyUser',1,100],['dailySite',1,10000],['concurrent',1,20]]) if (body[key]!==undefined && (!Number.isInteger(body[key])||body[key]<min||body[key]>max)) throw fail(400,'次数或并发设置无效。');
    if (body.paused!==undefined&&typeof body.paused!=='boolean') throw fail(400,'暂停设置无效。');
    store.transaction(() => { for (const key of ['dailyUser','dailySite','concurrent','paused']) if (body[key]!==undefined) store.run('UPDATE settings SET value=? WHERE key=?',JSON.stringify(body[key]),key); });
    store.pumpQueue();
    res.json(store.settings());
  });
  app.get('/api/admin/tryons',(req,res) => {
    const offset=Math.max(0,Math.min(100000,parseInt(req.query.offset)||0));
    // Keep audit/quota rows, but omit failed connections with nothing to view
    // or recover. Short videos, active uploads and retained chunks stay visible.
    const visible=`NOT (t.status='failed' AND t.first_frame_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM recordings r WHERE r.tryon_id=t.id AND (
        r.status IN ('ready','queued','processing') OR
        EXISTS (SELECT 1 FROM chunks c WHERE c.recording_id=r.id)
      )
    ))`;
    res.json({items:store.all(`SELECT t.* FROM tryons t WHERE ${visible} ORDER BY t.created_at DESC,t.id DESC LIMIT 50 OFFSET ?`,offset).map(adminTryonJson),total:store.get(`SELECT COUNT(*) AS n FROM tryons t WHERE ${visible}`).n});
  });
  app.get('/api/admin/garments',(req,res) => res.json(store.all('SELECT * FROM garments ORDER BY owner_id ASC,position,created_at DESC').map(row=>({...garmentJson(row),details:row.details||'',visitorId:row.owner_id}))));
  app.post('/api/admin/garments',limitWrites,adminUpload.single('file'),async(req,res) => { if (!req.file) throw fail(400,'请选择服装文件。'); req.file.originalname=Buffer.from(req.file.originalname,'latin1').toString('utf8'); res.status(201).json(garmentJson(await media.addGarment(req.file,null,req.body))); });
  app.put('/api/admin/garments/:id/reference',express.raw({type:['image/png','image/jpeg','image/webp'],limit:'20mb'}),async(req,res) => {
    const row=garment(req,res,true), image=await normalizeImage(req.body); store.canWrite(image.bytes.length);
    const relative=path.join('files',row.id,'reference.webp'); await writeFile(store.safeFile(relative),image.bytes); store.run('UPDATE garments SET image_path=? WHERE id=?',relative,row.id); res.json(garmentJson(store.get('SELECT * FROM garments WHERE id=?',row.id)));
  });
  app.use('/api',(req,res) => res.status(404).json({message:'接口不存在。'}));
  function errors(error,req,res,next) {
    if (req.file?.path) void rm(req.file.path,{force:true}).catch(()=>{});
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) return res.status(413).json({message:'上传文件超出限制。'});
    if (!error.status) console.warn('Request failed:',error.code || error.name);
    res.status(error.status || 500).json({message:publicError(error)});
  }
  app.use(errors);
  return { app,store,auth,media,apiKeys,analytics,options,errors,attach: value=>{realtime=value;},setOrigin:value=>{options.origin=value;},close:()=>{realtime?.close();media.close();apiKeys.close();analytics.close();store.close();} };
}
