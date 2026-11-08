import { mkdir, readFile, writeFile, rename, rm, open, readdir, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { fail, RETENTION_DAYS } from './config.mjs';
import { hash } from './store.mjs';
import { recordingPolicy, recordingIsShort, posterTime } from './recording-policy.mjs';
const execute = promisify(execFile);
export const MAX_VIDEO = 50 * 1024 * 1024;
export async function normalizeImage(buffer) {
  try {
    const image = sharp(buffer, { limitInputPixels: 40000000, animated: false, failOn: 'error' });
    const meta = await image.metadata();
    if (!['jpeg','png','webp'].includes(meta.format) || (meta.pages || 1) > 1) throw new Error('format');
    return { bytes: await image.rotate().flatten({background:'#ffffff'}).resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).webp({ quality: 93 }).toBuffer(), format: meta.format };
  } catch { throw fail(400, '请使用有效的 JPG、PNG 或 WebP 图片。'); }
}
export function validateGlb(buffer, { maxBytes = Infinity, maxTriangles = Infinity, maxMaterials = Infinity, maxAnimations = Infinity } = {}) {
  try {
    if (buffer.length > maxBytes) throw new Error('size');
    if (buffer.length < 24 || buffer.toString('ascii',0,4) !== 'glTF' || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length || buffer.readUInt32LE(16) !== 0x4e4f534a) throw new Error();
    const length = buffer.readUInt32LE(12);
    if (length > 8 * 1024 * 1024 || length + 20 > buffer.length) throw new Error();
    const gltf = JSON.parse(buffer.toString('utf8',20,20+length));
    if (!gltf.meshes?.length) throw new Error();
    for (const resource of [...(gltf.buffers || []), ...(gltf.images || [])]) if (resource.uri && !resource.uri.startsWith('data:')) throw new Error('external');
    if ((gltf.accessors || []).some(x => x.count > 3000000)) throw new Error();
    if ((gltf.materials || []).length > maxMaterials) throw new Error('materials');
    if ((gltf.animations || []).length > maxAnimations) throw new Error('animations');
    let triangles = 0;
    for (const mesh of gltf.meshes) for (const primitive of mesh.primitives || []) {
      if ((primitive.mode ?? 4) !== 4) throw new Error('primitive');
      const count = Number.isInteger(primitive.indices) ? gltf.accessors?.[primitive.indices]?.count : gltf.accessors?.[primitive.attributes?.POSITION]?.count;
      if (!Number.isFinite(count) || count < 3) throw new Error('geometry');
      triangles += Math.floor(count / 3);
    }
    if (triangles > maxTriangles) throw new Error('triangles');
    return gltf;
  } catch (error) {
    const reason = error?.message;
    if (reason === 'size') throw fail(413, '3D 模型不能超过 20 MB，请改用 2D 服装图片。');
    if (reason === 'triangles') throw fail(400, '3D 模型超过 50,000 个三角面，请简化模型或改用 2D 图片。');
    if (reason === 'materials') throw fail(400, '3D 模型材质超过 4 个，请合并材质或改用 2D 图片。');
    if (reason === 'animations') throw fail(400, '服装模型不需要动画，请移除动画后重试。');
    if (reason === 'primitive') throw fail(400, '只支持三角形网格的 GLB 服装模型。');
    if (reason === 'geometry') throw fail(400, '模型网格缺少有效三角面，请改用 2D 图片。');
    throw fail(400, '请上传完整的 GLB 2.0 文件，且纹理须内嵌。');
  }
}
export function createMedia(store, options) {
  let running = false, recovering = null, closed = false, timer;
  const locks = new Map();
  function serialized(id, operation) {
    const prior = locks.get(id) || Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    locks.set(id,next);
    next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => {});
    return next;
  }
  async function addGarment(file, owner, metadata = {}, referenceFile = null) {
    const id = metadata.id || randomUUID();
    let folder;
    try {
      const buffer = await readFile(file.path);
      const isGlb = path.extname(file.originalname).toLowerCase() === '.glb';
      if (!isGlb && buffer.length > 20*1024*1024) throw fail(413,'图片不能超过 20MB。');
      if (isGlb && owner) validateGlb(buffer,{maxBytes:20*1024*1024,maxTriangles:50000,maxMaterials:4,maxAnimations:0});
      let image;
      if (isGlb) {
        validateGlb(buffer);
        if (owner && !referenceFile) throw fail(400,'请先预览模型并生成服装参考图。');
        if (referenceFile) image = await normalizeImage(await readFile(referenceFile.path));
      } else image = await normalizeImage(buffer);
      store.canWrite(buffer.length + (image?.bytes.length || 0));
      folder = store.safeFile(path.join('files',id));
      await mkdir(folder, { recursive: true });
      const ext = isGlb ? 'glb' : image.format === 'jpeg' ? 'jpg' : image.format;
      const originalPath = path.join('files',id,`original.${ext}`);
      await rename(file.path, store.safeFile(originalPath));
      const imagePath = image ? path.join('files',id,'reference.webp') : null;
      if (image) await writeFile(store.safeFile(imagePath),image.bytes);
      const name = String(metadata.name || path.parse(file.originalname).name || '新衣服').trim().slice(0,80);
      const hasCategory = metadata.category !== undefined && metadata.category !== '';
      if (hasCategory && !['top','bottom','outfit','accessory'].includes(metadata.category)) throw fail(400,'服装类别无效。');
      const category = hasCategory ? metadata.category : 'outfit';
      store.run('INSERT INTO garments(id,owner_id,name,category,category_known,original_name,original_path,mime,image_path,model_path,published,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, owner || null, name, category, Number(hasCategory), file.originalname.slice(0,180), originalPath, isGlb ? 'model/gltf-binary' : `image/${image.format}`, imagePath, isGlb ? originalPath : null, 0, store.now());
      return store.get('SELECT * FROM garments WHERE id=?',id);
    } catch (error) { if (folder) await rm(folder,{recursive:true,force:true}); throw error; }
    finally { await rm(file.path,{force:true}).catch(() => {}); if(referenceFile?.path)await rm(referenceFile.path,{force:true}).catch(()=>{}); }
  }
  async function uploadChunk(recording, seq, bytes, mime) {
    return serialized(recording.id, async () => {
      const current = store.get('SELECT * FROM recordings WHERE id=?',recording.id);
      const digest=Buffer.isBuffer(bytes)?hash(bytes):null, existing=store.get('SELECT * FROM chunks WHERE recording_id=? AND seq=?',recording.id,seq);
      // The final chunk may already have queued processing when its HTTP reply
      // was lost. A matching retransmission is safe even after that transition.
      if(existing&&existing.digest===digest)return;
      if (current.status !== 'uploading') throw fail(409, '这段视频已停止接收上传。');
      if (!Number.isInteger(seq) || seq < 0 || seq > 2047 || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 2*1024*1024) throw fail(400, '视频分片无效。');
      const type = String(mime || '').split(';')[0];
      if (!['video/webm','video/mp4'].includes(type) || (current.mime && current.mime !== type)) throw fail(400,'视频格式不支持。');
      if (existing) { if (existing.digest !== digest) throw fail(409,'重复分片内容不一致。'); return; }
      if(current.expected_chunks!==null&&seq>=current.expected_chunks)throw fail(400,'分片超出已声明的视频长度。');
      if (current.bytes + bytes.length > MAX_VIDEO) throw fail(413,'视频超过大小限制。');
      const session = store.get('SELECT * FROM tryons WHERE id=?',recording.tryon_id);
      if (!session || store.now() - session.created_at > 24*3600000) throw fail(410,'视频上传已过期。');
      if (!session.charged || !session.first_frame_at) throw fail(409,'试衣尚未开始。');
      store.canWrite(bytes.length, session.reserved_bytes);
      const relative = path.join('temporary',recording.tryon_id,recording.kind,String(seq).padStart(5,'0')+'.part');
      await mkdir(path.dirname(store.safeFile(relative)),{recursive:true});
      await writeFile(store.safeFile(relative),bytes);
      store.transaction(() => {
        store.run('INSERT INTO chunks VALUES (?,?,?,?,?)',recording.id,seq,bytes.length,digest,relative);
        store.run('UPDATE recordings SET bytes=bytes+?,mime=?,upload_updated_at=? WHERE id=?',bytes.length,type,store.now(),recording.id);
      });
      queueIfComplete(recording.id);settle(recording.tryon_id);
    });
  }
  function queueIfComplete(id){
    const row=store.get('SELECT * FROM recordings WHERE id=?',id);
    if(row?.status!=='uploading'||!row.expected_chunks)return false;
    const chunks=store.all('SELECT seq FROM chunks WHERE recording_id=? ORDER BY seq',id);
    if(chunks.length!==row.expected_chunks||chunks.some((chunk,index)=>chunk.seq!==index))return false;
    store.run("UPDATE recordings SET status='queued',processing_error=NULL WHERE id=?",id);
    settle(row.tryon_id);void pump();return true;
  }
  async function manifest(recording,total,mime){
    return serialized(recording.id,async()=>{
      const row=store.get('SELECT * FROM recordings WHERE id=?',recording.id),session=store.get('SELECT * FROM tryons WHERE id=?',recording.tryon_id);
      if(!session?.charged||!session.first_frame_at)throw fail(409,'试衣尚未开始。');
      if(store.now()-session.created_at>24*3600000)throw fail(410,'视频上传已过期。');
      const type=String(mime||'').split(';')[0];
      if(!Number.isInteger(total)||total<0||total>2048||!['video/webm','video/mp4'].includes(type))throw fail(400,'视频上传信息无效。');
      if(row.expected_chunks!==null&&row.expected_chunks!==total||row.mime&&row.mime!==type)throw fail(409,'视频上传信息不一致。');
      const max=store.get('SELECT MAX(seq) AS n FROM chunks WHERE recording_id=?',row.id).n;
      if(max!==null&&max>=total)throw fail(409,'分片数量与已有数据不一致。');
      if(['queued','processing','ready','failed'].includes(row.status))return;
      store.run('UPDATE recordings SET expected_chunks=?,mime=?,upload_updated_at=COALESCE(upload_updated_at,?) WHERE id=?',total,type,store.now(),row.id);
      if(total===0)store.run("UPDATE recordings SET status='failed',processing_error='未录制到视频' WHERE id=?",row.id);
      else queueIfComplete(row.id);
      settle(recording.tryon_id);
    });
  }
  async function complete(recording, total) {
    return serialized(recording.id, async () => {
      const current = store.get('SELECT * FROM recordings WHERE id=?',recording.id);
      // A late or retried finish may not erase an already declared upload.
      // Validate even when processing already started; only matching totals
      // are idempotent acknowledgments of the same recording.
      if (!Number.isInteger(total) || total < 0 || total > 2048) throw fail(400,'视频分片数量无效。');
      if(current.expected_chunks!==null&&current.expected_chunks!==total)throw fail(409,'视频分片数量不一致。');
      if (['queued','processing','ready'].includes(current.status)) return;
      const chunks = store.all('SELECT seq FROM chunks WHERE recording_id=? ORDER BY seq',recording.id);
      if(total===0&&chunks.length)throw fail(409,'分片数量与已有数据不一致。');
      if(total===0&&current.status==='failed'&&current.expected_chunks===0)return;
      if (current.status !== 'uploading') throw fail(409,'视频无法继续处理。');
      if(total===0){store.run("UPDATE recordings SET status='failed',expected_chunks=0,processing_error='未录制到视频' WHERE id=?",recording.id);settle(recording.tryon_id);return;}
      if (chunks.length !== total || chunks.some((x,i) => x.seq !== i)) throw fail(409,'视频尚未上传完整，请重试。');
      store.run("UPDATE recordings SET status='queued',expected_chunks=? WHERE id=?",total,recording.id);
      settle(recording.tryon_id);
      void pump();
    });
  }
  async function probe(file) {
    const { stdout } = await execute(options.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type,codec_name,width,height,pix_fmt,profile,level,sample_aspect_ratio','-of','json',file], { windowsHide:true, timeout:15000, maxBuffer:512*1024 });
    return JSON.parse(stdout);
  }
  async function makePoster(session, input, relativeOutput, duration) {
    const segments=Number(session.flow_version)>0?store.all('SELECT stable_at,is_locked FROM tryon_segments WHERE tryon_id=? AND stable_at IS NOT NULL ORDER BY seq',session.id):[];
    const second=posterTime(session,segments,duration);
    await execute(options.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-threads','1','-ss',second.toFixed(3),'-i',input,'-frames:v','1','-vf','scale=540:-2',store.safeFile(relativeOutput)],{windowsHide:true,timeout:15000,maxBuffer:512*1024});
  }
  async function transcode(recording) {
    const session=store.get('SELECT * FROM tryons WHERE id=?',recording.tryon_id);
    const policy=recordingPolicy(session);
    store.canWrite(recording.bytes+12*1024*1024,session.reserved_bytes);
    const folder = store.safeFile(path.join('sessions',recording.tryon_id));
    await mkdir(folder,{recursive:true});
    const input = store.safeFile(path.join('temporary',recording.tryon_id,recording.kind+'.input'));
    const chunks = store.all('SELECT * FROM chunks WHERE recording_id=? ORDER BY seq',recording.id);
    const first = await readFile(store.safeFile(chunks[0].file_path));
    const webm = first.length >= 4 && first.readUInt32BE(0) === 0x1a45dfa3;
    const mp4 = first.length >= 12 && first.toString('ascii',4,8) === 'ftyp';
    if ((!webm && !mp4) || (webm && recording.mime !== 'video/webm') || (mp4 && recording.mime !== 'video/mp4')) throw new Error('Invalid video container');
    const handle = await open(input,'w');
    try { for (const chunk of chunks) await handle.writeFile(await readFile(store.safeFile(chunk.file_path))); } finally { await handle.close(); }
    const info = await probe(input);
    const video = info.streams.find(x => x.codec_type === 'video');
    if (!video || !video.width || !video.height || video.width > 4096 || video.height > 4096 || Number(info.format.duration || 0) > policy.maxInputSeconds) throw new Error('Invalid video dimensions/duration');
    const finalPath = path.join('sessions',recording.tryon_id,recording.kind+'.mp4');
    const posterPath = path.join('sessions',recording.tryon_id,recording.kind+'.jpg');
    const output = store.safeFile(finalPath);
    const common=['-nostdin','-hide_banner','-loglevel','error','-y','-threads','2','-protocol_whitelist','file,pipe','-f',webm?'matroska':'mov','-i',input,'-t',String(policy.maxSeconds),'-map','0:v:0','-an','-sn','-dn','-map_metadata','-1'];
    const withinSize=video.width>=video.height?video.width<=1280&&video.height<=720:video.width<=720&&video.height<=1280;
    const compatible=mp4&&video.codec_name==='h264'&&video.pix_fmt==='yuv420p'&&withinSize&&Number(video.level)<=42&&['Baseline','Constrained Baseline','Main','High'].includes(video.profile)&&['1:1',undefined].includes(video.sample_aspect_ratio);
    let copied=false;
    if(compatible){
      try{
        await execute(options.ffmpeg,[...common,'-c:v','copy','-movflags','+faststart',output],{windowsHide:true,timeout:30000,maxBuffer:512*1024});
        const check=await probe(output);copied=Number(check.format.duration)>0&&Number(check.format.duration)<=policy.maxSeconds+.5&&check.streams.every(s=>s.codec_type==='video');
      }catch{/* Unusual MP4 inputs still use the known H.264 conversion path. */}
    }
    if(!copied)await execute(options.ffmpeg,[...common,'-vf',"scale='if(gte(iw,ih),min(iw,1280),min(iw,720))':-2",'-c:v','libx264','-preset','veryfast','-crf','23','-maxrate','2500k','-bufsize','5M','-pix_fmt','yuv420p','-threads','2','-movflags','+faststart',output], {windowsHide:true,timeout:policy.transcodeTimeoutMs,maxBuffer:512*1024});
    const finalInfo = await probe(output), duration = Number(finalInfo.format.duration);
    if (!(duration > 0 && duration <= policy.maxSeconds+.5) || statSync(output).size > MAX_VIDEO) throw new Error('Invalid processed duration');
    await makePoster(session,output,posterPath,duration);
    store.run("UPDATE recordings SET status='ready',duration=?,final_path=?,poster_path=?,processing_error=NULL,processing_started_at=NULL WHERE id=?",duration,finalPath,posterPath,recording.id);
    await rm(input,{force:true});
    await rm(store.safeFile(path.join('temporary',recording.tryon_id,recording.kind)),{recursive:true,force:true});
    store.run('DELETE FROM chunks WHERE recording_id=?',recording.id);
  }
  function settle(id) {
    const session = store.get('SELECT * FROM tryons WHERE id=?',id);
    const recordings = store.all('SELECT * FROM recordings WHERE tryon_id=?',id);
    if (!session || ['queued','reserved','connecting','recording'].includes(session.status)) return;
    if (recordings.every(x => x.status === 'ready')) {
      const interrupted = session.interrupted || recordingIsShort(session,recordings);
      store.run('UPDATE tryons SET status=?,interrupted=?,reserved_bytes=0 WHERE id=?',interrupted?'interrupted':'ready',Number(Boolean(interrupted)),id);
    } else if (recordings.every(x => ['ready','failed'].includes(x.status))) store.run("UPDATE tryons SET status='failed',reserved_bytes=0,error='部分视频处理失败' WHERE id=?",id);
    else if(session.first_frame_at)store.run('UPDATE tryons SET status=? WHERE id=?',recordings.some(x=>['queued','processing'].includes(x.status))?'processing':'saving',id);
  }
  function describe(row){
    const session=store.get('SELECT created_at,ended_at,first_frame_at FROM tryons WHERE id=?',row.tryon_id);
    const count=Number(store.get('SELECT COUNT(*) AS n FROM chunks WHERE recording_id=?',row.id).n);
    const last=row.upload_updated_at??session?.ended_at??session?.first_frame_at??session?.created_at??store.now();
    const recovery=store.get('SELECT chunk_count FROM recording_recoveries WHERE recording_id=?',row.id);
    const prefix=store.all('SELECT seq,file_path FROM chunks WHERE recording_id=? ORDER BY seq',row.id);
    let available=0;for(const chunk of prefix){if(chunk.seq!==available||!existsSync(store.safeFile(chunk.file_path)))break;available++;}
    return {receivedChunks:row.status==='ready'?(row.expected_chunks??count):count,expectedChunks:row.expected_chunks,bytes:row.bytes,lastUploadAt:row.upload_updated_at,
      waitingForUpload:row.status==='uploading'&&Boolean(session?.first_frame_at)&&store.now()-last>90000,
      recoveryAvailable:Boolean(session?.first_frame_at)&&!['ready','queued','processing'].includes(row.status)&&available>(recovery?.chunk_count||0),
      error:row.processing_error,retryable:row.status==='failed'&&row.expected_chunks>0&&count===row.expected_chunks};
  }
  function playable(row){
    if(row.status==='ready'&&row.final_path&&existsSync(store.safeFile(row.final_path)))return {...row,recovered:false};
    const recovery=store.get('SELECT * FROM recording_recoveries WHERE recording_id=?',row.id);
    return recovery&&existsSync(store.safeFile(recovery.final_path))?{...recovery,recovered:true}:null;
  }
  async function recoverPartial(recording){
    return serialized(recording.id,async()=>{
      const row=store.get('SELECT * FROM recordings WHERE id=?',recording.id),session=store.get('SELECT * FROM tryons WHERE id=?',recording.tryon_id);
      if(!row||!session)throw fail(404,'视频不存在。');
      const policy=recordingPolicy(session);
      if(row.status==='ready')return;
      if(!session.first_frame_at||['queued','reserved','connecting','recording'].includes(session.status)||['queued','processing'].includes(row.status))throw fail(409,'视频尚未停止录制或正在处理。');
      if(session.created_at<store.now()-RETENTION_DAYS*86400000)throw fail(410,'视频已到期。');
      if(running||recovering)throw fail(409,'正在处理其他视频，请稍后恢复。');
      const chunks=[];
      for(const chunk of store.all('SELECT * FROM chunks WHERE recording_id=? ORDER BY seq',row.id)){
        if(chunk.seq!==chunks.length||!existsSync(store.safeFile(chunk.file_path)))break;
        chunks.push(chunk);
      }
      if(!chunks.length)throw fail(409,'没有可恢复的视频分片，需要原手机继续上传。');
      const old=store.get('SELECT * FROM recording_recoveries WHERE recording_id=?',row.id);
      if(old&&old.chunk_count>=chunks.length&&existsSync(store.safeFile(old.final_path)))return;
      const total=chunks.reduce((sum,chunk)=>sum+chunk.size,0);
      if(total>MAX_VIDEO)throw fail(413,'视频超过大小限制。');
      store.canWrite(total+12*1024*1024,session.reserved_bytes);
      recovering=session.id;
      const suffix=randomUUID(),input=store.safeFile(path.join('temporary',session.id,`recover-${row.kind}-${suffix}.input`));
      const finalPath=path.join('sessions',session.id,`recovered-${row.kind}-${suffix}.mp4`),posterPath=finalPath.replace(/\.mp4$/,'.jpg');
      let saved=false;
      try{
        await mkdir(path.dirname(input),{recursive:true});await mkdir(path.dirname(store.safeFile(finalPath)),{recursive:true});
        const handle=await open(input,'wx');
        try{for(const chunk of chunks){const bytes=await readFile(store.safeFile(chunk.file_path));if(bytes.length!==chunk.size||hash(bytes)!==chunk.digest)throw new Error('Invalid retained chunk');await handle.writeFile(bytes);}}finally{await handle.close();}
        const info=await probe(input),video=info.streams.find(stream=>stream.codec_type==='video');
        if(!video?.width||!video.height||video.width>4096||video.height>4096||Number(info.format.duration||0)>policy.maxInputSeconds)throw new Error('Invalid video dimensions');
        await execute(options.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-threads','2','-protocol_whitelist','file,pipe','-fflags','+discardcorrupt','-err_detect','ignore_err','-i',input,'-t',String(policy.maxSeconds),'-map','0:v:0','-an','-sn','-dn','-map_metadata','-1','-vf',"scale='if(gte(iw,ih),min(iw,1280),min(iw,720))':-2",'-c:v','libx264','-preset','veryfast','-crf','23','-maxrate','2500k','-bufsize','5M','-pix_fmt','yuv420p','-threads','2','-movflags','+faststart',store.safeFile(finalPath)],{windowsHide:true,timeout:policy.transcodeTimeoutMs,maxBuffer:512*1024});
        const result=await probe(store.safeFile(finalPath)),duration=Number(result.format.duration);
        if(!(duration>0&&duration<=policy.maxSeconds+.5)||result.streams.some(stream=>stream.codec_type!=='video')||statSync(store.safeFile(finalPath)).size>MAX_VIDEO)throw new Error('Invalid recovered video');
        await makePoster(session,store.safeFile(finalPath),posterPath,duration);
        store.transaction(()=>{
          store.run('INSERT INTO recording_recoveries(recording_id,final_path,poster_path,duration,chunk_count,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(recording_id) DO UPDATE SET final_path=excluded.final_path,poster_path=excluded.poster_path,duration=excluded.duration,chunk_count=excluded.chunk_count,created_at=excluded.created_at',row.id,finalPath,posterPath,duration,chunks.length,store.now());
          store.run('INSERT INTO video_actions(tryon_id,action,actor,created_at) VALUES (?,?,?,?)',session.id,'recover_'+row.kind,'admin',store.now());
        });
        saved=true;
        if(old)for(const file of [old.final_path,old.poster_path])await rm(store.safeFile(file),{force:true}).catch(()=>{});
      }catch(error){if(error.status)throw error;console.warn(`Video recovery failed: ${row.id}`);throw fail(422,'现有分片无法解码为视频，需要原手机继续上传。');}
      finally{
        await rm(input,{force:true}).catch(()=>{});
        if(!saved)for(const file of [finalPath,posterPath])await rm(store.safeFile(file),{force:true}).catch(()=>{});
        recovering=null;void pump();
      }
    });
  }
  async function retry(recording){
    return serialized(recording.id,async()=>{
      const row=store.get('SELECT * FROM recordings WHERE id=?',recording.id);
      if(['queued','processing','ready'].includes(row.status))return;
      if(!describe(row).retryable)throw fail(409,'视频未上传完整，需要原手机继续上传。');
      const chunks=store.all('SELECT seq FROM chunks WHERE recording_id=? ORDER BY seq',row.id);
      if(chunks.some((chunk,index)=>chunk.seq!==index))throw fail(409,'视频分片不完整。');
      store.run("UPDATE recordings SET status='queued',processing_error=NULL WHERE id=?",row.id);settle(row.tryon_id);void pump();
    });
  }
  async function pump() {
    if (running || recovering || closed) return;
    running = true;
    try {
      let row;
      while (!closed && (row = store.get("SELECT * FROM recordings WHERE status='queued' ORDER BY CASE kind WHEN 'result' THEN 0 ELSE 1 END,rowid LIMIT 1"))) {
        store.run("UPDATE recordings SET status='processing',processing_started_at=?,processing_error=NULL WHERE id=?",store.now(),row.id);
        try { await transcode(row); }
        catch(error) { const message=error.killed?'视频处理超时，可重试':error.status===507?'存储空间不足，请释放空间后重试':'视频处理失败，可重试';store.run("UPDATE recordings SET status='failed',processing_error=?,processing_started_at=NULL WHERE id=?",message,row.id); console.warn(`Video processing failed: ${row.id}`); }
        settle(row.tryon_id);
      }
    } finally { running = false; }
  }
  async function cleanup() {
    if(recovering)return;
    const now = store.now();
    store.pumpQueue();
    for(const row of store.all("SELECT id FROM tryons WHERE status IN ('saving','processing')"))settle(row.id);
    for (const session of store.all("SELECT * FROM tryons t WHERE created_at<? AND status NOT IN ('recording','connecting') AND NOT EXISTS (SELECT 1 FROM recordings r WHERE r.tryon_id=t.id AND r.status IN ('queued','processing'))",now-24*3600000)) {
      if (session.created_at < now - RETENTION_DAYS*86400000) { store.deleteTryon(session.id); continue; }
      if (session.reserved_bytes) {
        await rm(store.safeFile(path.join('temporary',session.id)),{recursive:true,force:true});
        store.run('DELETE FROM chunks WHERE recording_id IN (SELECT id FROM recordings WHERE tryon_id=?)',session.id);
        store.run("UPDATE recordings SET status='failed',processing_error='上传已过期' WHERE tryon_id=? AND status='uploading'",session.id);
        store.run("UPDATE tryons SET reserved_bytes=0,status='failed',error='上传未完成' WHERE id=?",session.id);
      }
    }
    store.run('DELETE FROM admins WHERE expires_at<?',now);
    store.run('DELETE FROM counters WHERE started_at<?',now-86400000);
    store.run('DELETE FROM usage WHERE day<?',new Date(now-90*86400000).toISOString().slice(0,10));
    store.run('DELETE FROM video_actions WHERE created_at<?',now-90*86400000);
    const incoming=store.safeFile('temporary/incoming');
    for(const entry of await readdir(incoming,{withFileTypes:true}).catch(()=>[]))if(entry.isFile()){
      const file=path.join(incoming,entry.name);if((await stat(file)).mtimeMs<now-24*3600000)await rm(file,{force:true});
    }
    for(const row of store.all("SELECT id FROM tryons WHERE status IN ('saving','processing')"))settle(row.id);
  }
  function start() {
    store.run("UPDATE tryons SET status='saving',interrupted=1,ended_at=? WHERE status IN ('connecting','recording')",store.now());
    store.run("UPDATE recordings SET status='queued' WHERE status='processing'");
    for(const row of store.all("SELECT id FROM recordings WHERE status='uploading' AND expected_chunks>0"))queueIfComplete(row.id);
    for(const row of store.all("SELECT id FROM tryons WHERE status IN ('saving','processing')"))settle(row.id);
    void cleanup(); void pump();
    timer = setInterval(() => { void cleanup().catch(() => console.warn('Cleanup deferred')); void pump(); },60000); timer.unref();
  }
  return { addGarment, uploadChunk, manifest, complete, describe, playable, recoverPartial, isRecovering:id=>recovering===id, retry, probe, settle, pump, cleanup, start, close: () => { closed=true; clearInterval(timer); }, idle: () => !running&&!recovering };
}
