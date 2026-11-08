import {api,ApiError,type Recording} from './api';
import {VIDEO_PROFILE} from './video-profile';
import {recordingStillActive} from './upload-recovery';
import {holdUploadLock,markLiveSession,anotherLiveSession,type UploadLockRelease} from './upload-lock';
import {browserUuid} from './browser-uuid.ts';

type Kind='original'|'result';
type Job={id:string;ended:boolean;interrupted?:boolean;counts:Record<Kind,number>;mime:Record<Kind,string>;createdAt:number;recorderOwner?:string;ownerUntil?:number;updatedAt?:number;recoveryObservedAt?:number};
type Chunk={key:string;id:string;kind:Kind;seq:number;blob:Blob;mime:string};
type PartProgress={total:number;uploaded:number;remaining:number};
export type PendingUpload={id:string;state:'recording'|'queued'|'uploading'|'paused'|'retry';progress:number;error?:string;recordings:Record<Kind,PartProgress>};
const kinds:Kind[]=['result','original'],CHUNK_BYTES=64*1024,OWNER_TTL=30000;
let database:Promise<IDBDatabase>;
function db(){return database??=new Promise((resolve,reject)=>{const r=indexedDB.open('amen-video-uploads',1);r.onupgradeneeded=()=>{r.result.createObjectStore('jobs',{keyPath:'id'});r.result.createObjectStore('chunks',{keyPath:'key'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function operation<T>(table:string,mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction(table,mode),r=action(tx.objectStore(table));let value:T;r.onsuccess=()=>{value=r.result;};tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('本机存储空间不足。'));});}
const all=<T>(table:string)=>operation<T[]>(table,'readonly',s=>s.getAll());
const getJob=(id:string)=>operation<Job|undefined>('jobs','readonly',s=>s.get(id));
const remove=(table:string,key:IDBValidKey)=>operation(table,'readwrite',s=>s.delete(key));
const chunkKeys=()=>operation('chunks','readonly',s=>s.getAllKeys());
async function changeJob(id:string,change:(job:Job)=>Job|undefined){
  const database=await db();return new Promise<Job|undefined>((resolve,reject)=>{
    const tx=database.transaction('jobs','readwrite'),store=tx.objectStore('jobs'),r=store.get(id);let saved:Job|undefined;
    r.onsuccess=()=>{if(r.result){saved=change(r.result);if(saved)store.put(saved);}};
    tx.oncomplete=()=>resolve(saved);tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
async function nextChunk(id:string,kind:Kind){
  // Old keys were unpadded: numeric ordering keeps 10 after 2.
  const keys=await chunkKeys(),prefix=`${id}:${kind}:`;
  const key=keys.filter(key=>String(key).startsWith(prefix)).sort((a,b)=>Number(String(a).slice(prefix.length))-Number(String(b).slice(prefix.length)))[0];
  return key===undefined?undefined:operation<Chunk|undefined>('chunks','readonly',s=>s.get(key));
}
let syncing:Promise<void>|null=null,recovering:Promise<void>|null=null,paused=false,activeId='',retryTimer=0,wake=false;
let uploadLock:UploadLockRelease|null=null;
const inflight=new Set<AbortController>();
const abortUploads=()=>{for(const controller of inflight)controller.abort();};
async function requireUploadLock(){if(uploadLock&&!await uploadLock.valid())throw new Error('另一页面已接手续传，本机未确认的片段仍保留。');}
let live={id:'',allowedUntil:0,nextAt:0,kind:'result' as Kind};
const errors=new Map<string,string>(),recordingIds=new Set<string>();
const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('amen-upload-events'):null;
const changed=()=>{window.dispatchEvent(new Event('amen:uploads'));channel?.postMessage('changed');};
channel?.addEventListener('message',event=>{if(event.data==='live')abortUploads();window.dispatchEvent(new Event('amen:uploads'));});
export async function pendingUploads():Promise<PendingUpload[]>{
  const [jobs,keys]=await Promise.all([all<Job>('jobs'),chunkKeys()]);
  return jobs.map(job=>{
    const part=(kind:Kind)=>{const total=job.counts[kind],remaining=keys.filter(key=>String(key).startsWith(`${job.id}:${kind}:`)).length;return {total,remaining,uploaded:Math.max(0,total-remaining)};};
    const recordings={original:part('original'),result:part('result')},total=job.counts.original+job.counts.result,uploaded=recordings.original.uploaded+recordings.result.uploaded;
    return {id:job.id,state:!job.ended?'recording':paused?'paused':errors.has(job.id)?'retry':activeId===job.id?'uploading':'queued',progress:total?Math.floor(uploaded/total*100):0,error:errors.get(job.id),recordings};
  });
}
function schedule(delay=15000){clearTimeout(retryTimer);retryTimer=window.setTimeout(()=>void recoverUploads().catch(()=>{}),delay);}
export function pauseUploads(value:boolean){paused=value;markLiveSession(value);live.allowedUntil=0;abortUploads();clearTimeout(retryTimer);if(value)channel?.postMessage('live');else void recoverUploads().catch(()=>{});changed();}
export function allowLiveUploads(id:string,allowed:boolean){
  if(!recordingIds.has(id))return;
  if(live.id!==id)live={id,allowedUntil:0,nextAt:0,kind:'result'};
  live.id=id;live.allowedUntil=allowed?Date.now()+3000:0;
  if(!allowed){abortUploads();return;}void syncUploads().catch(()=>{});
}
// API errors never authorize erasing the only remaining local copy.
export async function discardUpload(id:string){
  if(recordingIds.has(id))return;
  if(activeId===id)abortUploads();
  const database=await db();await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction(['jobs','chunks'],'readwrite'),store=tx.objectStore('chunks');
    const cursor=store.openCursor(IDBKeyRange.bound(`${id}:`,`${id}:\uffff`));cursor.onsuccess=()=>{if(cursor.result){cursor.result.delete();cursor.result.continue();}};
    tx.objectStore('jobs').delete(id);tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
  });errors.delete(id);changed();
}
function errorText(error:unknown){
  if(error instanceof ApiError&&[401,403,404].includes(error.status))return '暂时无法访问这条录像，本机片段已保留；请在原微信或浏览器继续保存。';
  if(error instanceof ApiError&&error.status===410)return '上传期限已过，本机片段仍保留，请联系管理员。';
  return error instanceof Error&&error.name!=='AbortError'?error.message:'上传暂时中断，返回页面后会继续保存。';
}
async function request<T>(url:string,options:RequestInit={},early=false):Promise<T>{
  await requireUploadLock();
  const otherLive=await anotherLiveSession();
  if((paused&&!early)||early&&(document.hidden||live.allowedUntil<Date.now())||otherLive)throw new DOMException('Paused','AbortError');
  const controller=new AbortController();inflight.add(controller);
  const timer=window.setTimeout(()=>controller.abort(),early?1500:20000);
  try{return await api<T>(url,{...options,signal:controller.signal});}finally{clearTimeout(timer);inflight.delete(controller);}
}
const send=(url:string,body:unknown)=>request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
export function recoverUploads():Promise<void>{
  if(recovering){wake=true;return recovering;}
  recovering=(async()=>{
    if(!paused)for(const snapshot of await all<Job>('jobs'))if(!snapshot.ended&&!recordingIds.has(snapshot.id)){
      const release=await holdUploadLock(`record:${snapshot.id}`);if(!release)continue;
      try{
        const record=await request<{status:string}>(`/api/tryons/${snapshot.id}`);
        if(recordingStillActive(record.status))continue;
        if(!await release.valid())continue;
        // Re-read inside the transaction, never write a pre-request snapshot.
        await changeJob(snapshot.id,latest=>{
          if(latest.ended||recordingIds.has(latest.id)||(latest.ownerUntil??0)>Date.now())return;
          // Legacy tabs have no lock/heartbeat. Observe a terminal server twice;
          // any old tail write replaces this marker, restarting the quiet period.
          if(!latest.recorderOwner&&!latest.recoveryObservedAt)return {...latest,recoveryObservedAt:Date.now()};
          if(!latest.recorderOwner&&Date.now()-(latest.recoveryObservedAt??0)<5000)return;
          return {...latest,ended:true,interrupted:true,updatedAt:Date.now()};
        });
      }catch(error){errors.set(snapshot.id,errorText(error));}finally{release();}
    }
    changed();await syncUploads();
  })().finally(()=>{recovering=null;});return recovering;
}
function fullyReceived(job:Job,recordings:Recording[]){
  return kinds.every(kind=>{const row=recordings.find(row=>row.kind===kind),total=job.counts[kind];
    return row&&row.expectedChunks===total&&row.receivedChunks>=total&&['queued','processing','ready','failed'].includes(row.status);
  });
}
async function uploadChunk(chunk:Chunk,early=false){
  await request(`/api/tryons/${chunk.id}/recordings/${chunk.kind}/chunks/${chunk.seq}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Recording-Type':chunk.mime},body:chunk.blob},early);
  await requireUploadLock();
  await remove('chunks',chunk.key);changed();
}
async function uploadEnded(job:Job){
  const base=`/api/tryons/${job.id}`;
  await send(`${base}/finish`,{interrupted:job.interrupted!==false});
  const record=await request<{recordings:Recording[]}>(base),blocked=new Set<Kind>();
  for(const kind of kinds){
    const row=record.recordings.find(row=>row.kind===kind);
    if(row?.status!=='uploading'){blocked.add(kind);continue;}
    try{await send(`${base}/recordings/${kind}/manifest`,{chunks:job.counts[kind],mime:job.mime[kind]});}
    catch(error){blocked.add(kind);errors.set(job.id,errorText(error));}
  }
  let work=true;
  while(work&&!paused){
    work=false;
    for(const kind of kinds){
      if(paused)return;if(blocked.has(kind))continue;
      try{
        const chunk=await nextChunk(job.id,kind);
        if(chunk){work=true;await uploadChunk(chunk);}
        else{await send(`${base}/recordings/${kind}/complete`,{chunks:job.counts[kind]});blocked.add(kind);}
      }catch(error){blocked.add(kind);errors.set(job.id,errorText(error));}
    }
  }
  if(paused)return;
  const final=await request<{recordings:Recording[]}>(base);
  await requireUploadLock();
  if(fullyReceived(job,final.recordings))await discardUpload(job.id);
  else if(!errors.has(job.id))errors.set(job.id,'尚未完整保存，本机片段已保留，稍后继续上传。');
}
export function syncUploads():Promise<void>{
  if(syncing){wake=true;return syncing;}
  clearTimeout(retryTimer);
  syncing=(async()=>{
    const release=await holdUploadLock('uploader');if(!release)return;
    uploadLock=release;
    try{
      if(await anotherLiveSession())return;
      if(paused){
        // At most 64 KiB every 2 seconds with fresh healthy live stats.
        // No final lengths or transcoding while capture is running.
        if(document.hidden||live.allowedUntil<Date.now()||live.nextAt>Date.now()||!recordingIds.has(live.id))return;
        const job=await getJob(live.id);if(!job||job.ended||Date.now()-job.createdAt<5000)return;
        const chunk=await nextChunk(job.id,live.kind)??await nextChunk(job.id,live.kind==='result'?'original':'result');
        if(!chunk||chunk.blob.size>CHUNK_BYTES)return;
        live.nextAt=Date.now()+2000;live.kind=chunk.kind==='result'?'original':'result';
        try{await uploadChunk(chunk,true);}catch{live.nextAt=Date.now()+10000;live.allowedUntil=0;}
        return;
      }
      for(const job of await all<Job>('jobs')){
        if(paused)break;if(!job.ended)continue;
        if(Date.now()-job.createdAt>24*3600000){errors.set(job.id,'上传期限已过，本机片段仍保留，请联系管理员。');continue;}
        activeId=job.id;errors.delete(job.id);changed();
        try{await uploadEnded(job);}catch(error){errors.set(job.id,errorText(error));}
        finally{activeId='';changed();}
      }
    }finally{if(uploadLock===release)uploadLock=null;release();}
  })().finally(()=>{syncing=null;const delay=wake&&!paused?0:paused?2000:15000;wake=false;schedule(delay);});return syncing;
}
export function supportedMime(){
  if(!window.MediaRecorder||!window.indexedDB)throw new Error('请使用 Safari 或 Chrome 打开，以录制试穿视频。');
  for(const type of ['video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp8','video/webm'])if(MediaRecorder.isTypeSupported(type))return type;
  throw new Error('此浏览器暂不支持视频录制，请用系统浏览器打开。');
}
export async function recordPair(id:string,original:MediaStream,result:MediaStream,onFailure:(error:unknown)=>void){
  const mime=supportedMime(),release=await holdUploadLock(`record:${id}`);if(!release)throw new Error('此录像正在另一个页面保存。');
  const owner=browserUuid();let writes=Promise.resolve(),failed:unknown=null,stopping:Promise<void>|null=null;
  let heartbeat=0;
  const recorders:MediaRecorder[]=[],stops:Promise<void>[]=[],started=new Set<MediaRecorder>();
  const notifyFailure=(error:unknown)=>{if(!failed){failed=error;onFailure(error);}};
  const stop=(interrupted=true)=>stopping??=(async()=>{
    try{
      for(const recorder of recorders)if(started.has(recorder)&&recorder.state!=='inactive')recorder.stop();
      await Promise.all(stops.filter((_,index)=>started.has(recorders[index])));
      await writes;
      if(!await release.valid())throw new Error('录像已由另一页面接管，已保存的本机片段仍保留。');
      await changeJob(id,latest=>latest.recorderOwner===owner?{...latest,ended:true,interrupted:interrupted||Boolean(failed),ownerUntil:0,updatedAt:Date.now()}:undefined);
    }finally{clearInterval(heartbeat);recordingIds.delete(id);release();changed();void recoverUploads().catch(()=>{});}
    if(failed)throw new Error('视频未完整录制，请查看已保存的片段。');
  })();
  try{
    await operation('jobs','readwrite',store=>store.add({id,ended:false,counts:{original:0,result:0},mime:{original:mime,result:mime},createdAt:Date.now(),updatedAt:Date.now(),recorderOwner:owner,ownerUntil:Date.now()+OWNER_TTL} satisfies Job));recordingIds.add(id);
    heartbeat=window.setInterval(()=>void release.valid().then(valid=>{if(!valid)throw new Error('录像已由另一页面接管。');return changeJob(id,latest=>latest.recorderOwner===owner&&!latest.ended?{...latest,ownerUntil:Date.now()+OWNER_TTL}:undefined);}).catch(notifyFailure),5000);
    for(const kind of ['original','result'] as Kind[]){
      const source=kind==='original'?original:result;
      const recorder=new MediaRecorder(new MediaStream(source.getVideoTracks()),{mimeType:mime,videoBitsPerSecond:VIDEO_PROFILE.recorder[kind]});
      recorders.push(recorder);stops.push(new Promise<void>(resolve=>recorder.addEventListener('stop',()=>resolve(),{once:true})));
      recorder.ondataavailable=event=>{
        if(!event.data.size)return;
        writes=writes.then(async()=>{
          if(!await release.valid())throw new Error('录像已由另一页面接管，已保存的片段仍保留。');
          const database=await db();await new Promise<void>((resolve,reject)=>{
            const tx=database.transaction(['jobs','chunks'],'readwrite'),jobs=tx.objectStore('jobs'),read=jobs.get(id);
            read.onsuccess=()=>{
              const latest=read.result as Job|undefined;
              if(!latest||latest.ended||latest.recorderOwner!==owner){tx.abort();return;}
              for(let offset=0;offset<event.data.size;offset+=CHUNK_BYTES){const seq=latest.counts[kind]++;tx.objectStore('chunks').put({key:`${id}:${kind}:${seq}`,id,kind,seq,blob:event.data.slice(offset,offset+CHUNK_BYTES),mime:recorder.mimeType} satisfies Chunk);}
              latest.mime[kind]=recorder.mimeType;latest.updatedAt=Date.now();latest.ownerUntil=Date.now()+OWNER_TTL;jobs.put(latest);
            };
            tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error||new Error('录像保存状态发生变化，本机已有片段已保留。'));
          });changed();
        }).catch(notifyFailure);
      };
      recorder.onerror=()=>notifyFailure(new Error('视频录制中断。'));
    }
    for(const recorder of recorders){recorder.start(2000);started.add(recorder);}
    return {stop};
  }catch(error){await stop(true).catch(()=>{});throw error;}
}
window.addEventListener('online',()=>void recoverUploads().catch(()=>{}));
window.addEventListener('pageshow',()=>void recoverUploads().catch(()=>{}));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void recoverUploads().catch(()=>{});});
