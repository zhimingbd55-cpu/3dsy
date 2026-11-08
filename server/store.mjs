import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, statfsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { RESERVATION_BYTES, fail } from './config.mjs';
import { BUILTIN_GARMENT_DETAILS, BUILTIN_DETAILS_MIGRATION_VERSION } from './tryon-prompt.mjs';
import { FLOW_VERSION, DEMO_GARMENT_IDS, flowLimits } from './tryon-flow.mjs';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const beijingDay = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export function createStore(directory, { minFreeBytes = 10 * 1024 ** 3, now = Date.now, migrateBuiltinDetails = true } = {}) {
  let pendingWrites=0;
  mkdirSync(directory, { recursive: true });
  for (const name of ['files', 'sessions', 'temporary']) mkdirSync(path.join(directory, name), { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'amen.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, wechat_id TEXT NOT NULL DEFAULT '', qr_path TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, consent_at INTEGER, agent_id TEXT REFERENCES agents(id));
    CREATE TABLE IF NOT EXISTS admins (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS garments (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES visitors(id), name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'outfit', category_known INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '', original_name TEXT NOT NULL, original_path TEXT NOT NULL, mime TEXT NOT NULL, image_path TEXT, model_path TEXT, published INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS garment_prompt_history (garment_id TEXT NOT NULL, prompt_version INTEGER NOT NULL, previous_details TEXT NOT NULL, changed_at INTEGER NOT NULL, PRIMARY KEY(garment_id,prompt_version));
    CREATE TABLE IF NOT EXISTS tryons (id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES visitors(id), agent_id TEXT REFERENCES agents(id), garment_id TEXT, garment_name TEXT NOT NULL, created_at INTEGER NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'reserved', charged INTEGER NOT NULL DEFAULT 0, generation_started_at INTEGER, first_frame_at INTEGER, ended_at INTEGER, generation_seconds REAL NOT NULL DEFAULT 0, interrupted INTEGER NOT NULL DEFAULT 0, reserved_bytes INTEGER NOT NULL, error TEXT, prompt_snapshot TEXT);
    CREATE INDEX IF NOT EXISTS tryons_day ON tryons(day, visitor_id);
    CREATE TABLE IF NOT EXISTS video_shares (tryon_id TEXT PRIMARY KEY REFERENCES tryons(id) ON DELETE CASCADE, agent_id TEXT REFERENCES agents(id), token_hash TEXT UNIQUE NOT NULL, token_cipher TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS stream_metrics (tryon_id TEXT PRIMARY KEY REFERENCES tryons(id) ON DELETE CASCADE, captured_at INTEGER NOT NULL, summary TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage (visitor_id TEXT NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, seconds REAL NOT NULL DEFAULT 0, PRIMARY KEY(visitor_id,day));
    CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, tryon_id TEXT NOT NULL REFERENCES tryons(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('original','result')), mime TEXT, status TEXT NOT NULL DEFAULT 'uploading', expected_chunks INTEGER, bytes INTEGER NOT NULL DEFAULT 0, duration REAL, final_path TEXT, poster_path TEXT, UNIQUE(tryon_id,kind));
    CREATE TABLE IF NOT EXISTS chunks (recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE, seq INTEGER NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL, file_path TEXT NOT NULL, PRIMARY KEY(recording_id,seq));
    CREATE TABLE IF NOT EXISTS recording_recoveries (recording_id TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE, final_path TEXT NOT NULL, poster_path TEXT NOT NULL, duration REAL NOT NULL, chunk_count INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS video_actions (id INTEGER PRIMARY KEY, tryon_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, started_at INTEGER NOT NULL, count INTEGER NOT NULL);
  `);
  const defaults = { dailyUser: 3, dailySite: 300, concurrent: 2, storageBytes: 20 * 1024 ** 3, paused: false, businessName: '1➕衣商务', businessWechat: '', businessQrPath: '', businessUpdatedAt: 0 };
  for (const [key, value] of Object.entries(defaults)) db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run(key, JSON.stringify(value));
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  for(const column of ['queue_seen_at','queue_expires_at','admitted_at','user_hidden_at'])if(!all('PRAGMA table_info(tryons)').some(row=>row.name===column))db.exec(`ALTER TABLE tryons ADD COLUMN ${column} INTEGER`);
  for(const [table,column,type] of [['visitors','agent_id','TEXT REFERENCES agents(id)'],['garments','details',"TEXT NOT NULL DEFAULT ''"],['garments','category_known','INTEGER NOT NULL DEFAULT 0'],['tryons','agent_id','TEXT REFERENCES agents(id)']])if(!all(`PRAGMA table_info(${table})`).some(row=>row.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  for(const [column,type] of [['target','TEXT'],['preparation_ms','INTEGER'],['countdown_ms','INTEGER'],['countdown_version','INTEGER NOT NULL DEFAULT 1'],['ready_at','INTEGER'],['connection_started_at','INTEGER'],['image_accepted_at','INTEGER'],['recording_started_at','INTEGER'],['stable_video_at','INTEGER'],['stable_window_ms','INTEGER'],['stable_frames','INTEGER'],['stability_mode','TEXT'],['prompt_version','INTEGER'],['reference_hash','TEXT'],['prompt_snapshot','TEXT']])if(!all('PRAGMA table_info(tryons)').some(row=>row.name===column))db.exec(`ALTER TABLE tryons ADD COLUMN ${column} ${type}`);
  for(const [column,type] of [['flow_version','INTEGER NOT NULL DEFAULT 0'],['flow_mode','TEXT'],['flow_playlist','TEXT'],['flow_sequence','INTEGER NOT NULL DEFAULT 0'],['flow_status','TEXT'],['flow_locked_garment_id','TEXT'],['flow_locked_at','INTEGER'],['hard_deadline_at','INTEGER'],['recording_deadline_at','INTEGER'],['auto_deadline_at','INTEGER'],['expected_recording_seconds','REAL'],['end_reason','TEXT']])if(!all('PRAGMA table_info(tryons)').some(row=>row.name===column))db.exec(`ALTER TABLE tryons ADD COLUMN ${column} ${type}`);
  db.exec(`CREATE TABLE IF NOT EXISTS tryon_segments (
    tryon_id TEXT NOT NULL REFERENCES tryons(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
    garment_id TEXT NOT NULL, garment_name TEXT NOT NULL, category TEXT NOT NULL, image_path TEXT NOT NULL,
    prompt_snapshot TEXT, prompt_version INTEGER, reference_hash TEXT, requested_at INTEGER, sent_at INTEGER,
    acknowledged_at INTEGER, stable_at INTEGER, hold_seconds INTEGER NOT NULL, hold_ends_at INTEGER,
    deadline_at INTEGER, ended_at INTEGER, status TEXT NOT NULL DEFAULT 'awaiting_ack', end_reason TEXT,
    is_locked INTEGER NOT NULL DEFAULT 0, stable_window_ms INTEGER, stable_frames INTEGER, stability_mode TEXT,
    PRIMARY KEY(tryon_id,seq));`);
  if(!all('PRAGMA table_info(video_shares)').some(row=>row.name==='agent_id'))db.exec('ALTER TABLE video_shares ADD COLUMN agent_id TEXT REFERENCES agents(id)');
  run('UPDATE settings SET value=? WHERE key=? AND value=?',JSON.stringify('1➕衣商务'),'businessName',JSON.stringify('阿门试衣商务'));
  const settings = () => Object.fromEntries(all('SELECT * FROM settings').map(x => [x.key, JSON.parse(x.value)]));
  const transaction = operation => { db.exec('BEGIN IMMEDIATE'); try { const result = operation(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  if (migrateBuiltinDetails) for (const [id, details] of Object.entries(BUILTIN_GARMENT_DETAILS)) {
    const row = get('SELECT details FROM garments WHERE id=? AND owner_id IS NULL', id);
    if (!row) continue;
    transaction(() => {
      const migrated = get('SELECT 1 FROM garment_prompt_history WHERE garment_id=? AND prompt_version=?', id, BUILTIN_DETAILS_MIGRATION_VERSION);
      if (!migrated) {
        run('INSERT OR IGNORE INTO garment_prompt_history(garment_id,prompt_version,previous_details,changed_at) VALUES (?,?,?,?)', id, BUILTIN_DETAILS_MIGRATION_VERSION, row.details || '', now());
        run("UPDATE garments SET details=?,category='outfit',category_known=1 WHERE id=? AND owner_id IS NULL", details, id);
      }
    });
  }
  run("UPDATE tryons SET admitted_at=created_at WHERE admitted_at IS NULL AND status IN ('reserved','connecting','recording')");
  db.exec('CREATE INDEX IF NOT EXISTS tryons_status ON tryons(status)');
  for(const [column,type] of [['upload_updated_at','INTEGER'],['processing_started_at','INTEGER'],['processing_error','TEXT']])if(!all('PRAGMA table_info(recordings)').some(row=>row.name===column))db.exec(`ALTER TABLE recordings ADD COLUMN ${column} ${type}`);
  function directoryBytes(folder) {
    let bytes = 0;
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const file = path.join(folder, item.name);
      try { bytes += item.isDirectory() ? directoryBytes(file) : statSync(file).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return bytes;
  }
  function storage() {
    const fs = statfsSync(directory);
    return { used: directoryBytes(directory), reserved: pendingWrites+Number(get('SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM tryons').n), free: Number(fs.bavail) * Number(fs.bsize), limit: settings().storageBytes, minFree: minFreeBytes };
  }
  function canWrite(bytes = 0, reservationCredit = 0) {
    const info = storage();
    if (info.used + info.reserved - reservationCredit + bytes > info.limit || info.free - bytes < minFreeBytes) throw fail(507, '存储空间不足，暂时无法新增。');
    return info;
  }
  function quota(visitorId) {
    const day = beijingDay(now());
    const held = "charged=0 AND status IN ('queued','reserved','connecting','recording')";
    const userUsed = Number(get('SELECT COALESCE(SUM(used),0) AS n FROM usage WHERE day=? AND visitor_id=?', day, visitorId).n) + Number(get(`SELECT COUNT(*) AS n FROM tryons WHERE day=? AND visitor_id=? AND ${held}`, day, visitorId).n);
    const siteUsed = Number(get('SELECT COALESCE(SUM(used),0) AS n FROM usage WHERE day=?', day).n) + Number(get(`SELECT COUNT(*) AS n FROM tryons WHERE day=? AND ${held}`, day).n);
    return { userUsed, siteUsed, ...settings(), day };
  }
  function reserveWrite(bytes){canWrite(bytes);pendingWrites+=bytes;let released=false;return ()=>{if(!released){released=true;pendingWrites-=bytes;}};}
  function advanceQueue(){
    const time=now(),limits=settings();
    run("UPDATE tryons SET status='failed',ended_at=?,reserved_bytes=0,error='排队已结束，请重新开始。' WHERE status='queued' AND (queue_seen_at<? OR queue_expires_at<=? OR day<>?)",time,time-20000,time,beijingDay(time));
    run("UPDATE tryons SET status='failed',ended_at=?,reserved_bytes=0,error='连接超时，请重试。' WHERE status='reserved' AND COALESCE(admitted_at,created_at)<?",time,time-45000);
    if(limits.paused){run("UPDATE tryons SET status='failed',ended_at=?,reserved_bytes=0,error='试衣已暂停。' WHERE status IN ('queued','reserved')",time);return;}
    let free=Math.max(0,limits.concurrent-Number(get("SELECT COUNT(*) AS n FROM tryons WHERE status IN ('reserved','connecting','recording')").n));
    if(!free)return;
    for(const row of all("SELECT * FROM tryons WHERE status='queued' ORDER BY rowid LIMIT ?",free)){
      const garment=get('SELECT * FROM garments WHERE id=?',row.garment_id);
      if(!garment?.image_path||(garment.owner_id!==row.visitor_id&&(garment.owner_id!==null||!garment.published))){run("UPDATE tryons SET status='failed',ended_at=?,reserved_bytes=0,error='服装已不可用。' WHERE id=?",time,row.id);continue;}
      try{canWrite(0);}catch{run("UPDATE tryons SET status='failed',ended_at=?,reserved_bytes=0,error='存储空间不足。' WHERE id=?",time,row.id);continue;}
      run("UPDATE tryons SET status='reserved',admitted_at=?,ready_at=NULL WHERE id=? AND status='queued'",time,row.id);
    }
  }
  const pumpQueue=()=>transaction(advanceQueue);
  function queueInfo(id){
    const row=get('SELECT rowid AS sequence,status FROM tryons WHERE id=?',id);
    if(row?.status!=='queued')return null;
    return {ahead:Number(get("SELECT COUNT(*) AS n FROM tryons WHERE status='queued' AND rowid<?",row.sequence).n),waiting:Number(get("SELECT COUNT(*) AS n FROM tryons WHERE status='queued'").n),active:Number(get("SELECT COUNT(*) AS n FROM tryons WHERE status IN ('reserved','connecting','recording')").n),concurrent:settings().concurrent};
  }
  function heartbeatQueue(id){
    return transaction(()=>{
      // Expire before touching the lease, so an abandoned tab cannot reclaim a place.
      advanceQueue();
      run("UPDATE tryons SET queue_seen_at=? WHERE id=? AND status='queued'",now(),id);
      return get('SELECT * FROM tryons WHERE id=?',id);
    });
  }
  function reserve(visitor, garment, {acceptRecording=false,allowQueue=false,target=garment.category||'outfit',preparationMs=0,countdownMs=0,countdownVersion=1,flowVersion=0,mode='fixed'}={}) {
    return transaction(() => {
      advanceQueue();
      if (!visitor.consent_at && acceptRecording!==true) throw fail(403, '请先确认视频保存说明。');
      const limits = quota(visitor.id);
      if (limits.paused) throw fail(503, '试衣暂时关闭，请稍后再来。');
      if (limits.userUsed >= limits.dailyUser) throw fail(429, '今天的试衣次数已用完。');
      if (limits.siteUsed >= limits.dailySite) throw fail(429, '今日体验名额已用完。');
      const active = all("SELECT visitor_id,status FROM tryons WHERE status IN ('queued','reserved','connecting','recording')");
      if (active.some(x => x.visitor_id === visitor.id)) throw fail(409, '你已有一场试衣正在进行。');
      const waiting=active.filter(x=>x.status==='queued').length;
      const queued=waiting>0||active.length>=limits.concurrent;
      if(queued&&!allowQueue)throw fail(429,'试衣间正忙，请刷新页面后排队。');
      if(waiting>=50)throw fail(429,'排队人数较多，请稍后再来。');
      canWrite(RESERVATION_BYTES);
      const id = randomUUID(), time = now();
      // Only a deliberate Start action enables recording; visits never do.
      if(!visitor.consent_at)run('UPDATE visitors SET consent_at=? WHERE id=?',time,visitor.id);
      run('INSERT INTO tryons (id,visitor_id,agent_id,garment_id,garment_name,created_at,day,reserved_bytes,status,queue_seen_at,queue_expires_at,admitted_at,target,preparation_ms,countdown_ms,countdown_version,ready_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, visitor.id, visitor.agent_id||null, garment.id, garment.name, time, beijingDay(time), RESERVATION_BYTES,queued?'queued':'reserved',queued?time:null,queued?time+5*60000:null,queued?null:time,target,preparationMs,countdownMs,countdownVersion,queued?null:time);
      if(flowVersion===FLOW_VERSION){
        run("UPDATE tryons SET flow_version=?,flow_mode=?,flow_playlist=?,flow_sequence=1,flow_status='awaiting_ack' WHERE id=?",FLOW_VERSION,mode,JSON.stringify(mode==='auto'?DEMO_GARMENT_IDS:[garment.id]),id);
        run('INSERT INTO tryon_segments(tryon_id,seq,garment_id,garment_name,category,image_path,hold_seconds,is_locked) VALUES (?,1,?,?,?,?,?,?)',id,garment.id,garment.name,garment.category,garment.image_path,mode==='auto'?10:30,Number(mode==='fixed'));
      }
      for (const kind of ['original','result']) run('INSERT INTO recordings(id,tryon_id,kind) VALUES (?,?,?)', randomUUID(), id, kind);
      return get('SELECT * FROM tryons WHERE id=?', id);
    });
  }
  function markReady(id,visitorId,{preparationMs=0,countdownMs=0,countdownVersion=1}={}) {
    return transaction(()=>{
      const row=get('SELECT * FROM tryons WHERE id=? AND visitor_id=?',id,visitorId);
      if(!row)throw fail(404,'本次试衣不存在。');
      if(row.status!=='reserved')throw fail(409,'本次试衣名额已失效，请重新开始。');
      if(![1,2,3].includes(countdownVersion)||countdownVersion<(row.countdown_version??1))throw fail(400,'本次试衣的倒数版本无效或已降低。');
      if(row.ready_at!==null)return row;
      const time=now();
      if(time-(row.admitted_at??row.created_at)>45000)throw fail(409,'本次试衣名额已超时，请重新开始。');
      run('UPDATE tryons SET ready_at=?,preparation_ms=COALESCE(preparation_ms,0)+?,countdown_ms=COALESCE(countdown_ms,0)+?,countdown_version=MAX(COALESCE(countdown_version,1),?) WHERE id=? AND status=\'reserved\' AND ready_at IS NULL',time,preparationMs,countdownMs,countdownVersion,id);
      return get('SELECT * FROM tryons WHERE id=?',id);
    });
  }
  function markRecordingStarted(id) {
    const row=get('SELECT first_frame_at,recording_started_at FROM tryons WHERE id=?',id);
    if(!row?.first_frame_at)throw fail(409,'试穿画面尚未就绪。');
    if(row.recording_started_at===null)run('UPDATE tryons SET recording_started_at=? WHERE id=? AND first_frame_at IS NOT NULL',now(),id);
    return get('SELECT * FROM tryons WHERE id=?',id);
  }
  function rate(key, count, period) {
    const time = now();
    const row = get('SELECT * FROM counters WHERE key=?', key);
    if (!row || time - row.started_at >= period) { run('INSERT OR REPLACE INTO counters VALUES (?,?,1)', key, time); return; }
    if (row.count >= count) throw fail(429, '操作太频繁，请稍后重试。');
    run('UPDATE counters SET count=count+1 WHERE key=?', key);
  }
  function generation(id, seconds = 0) {
    transaction(() => {
      const row = get('SELECT * FROM tryons WHERE id=?', id);
      if (!row) return;
      const total = Math.max(row.generation_seconds, Math.min(flowLimits(row).generationSeconds, Number(seconds) || 0));
      run('INSERT OR IGNORE INTO usage(visitor_id,day) VALUES (?,?)', row.visitor_id, row.day);
      run('UPDATE usage SET used=used+?, seconds=seconds+? WHERE visitor_id=? AND day=?', row.charged ? 0 : 1, total-row.generation_seconds, row.visitor_id, row.day);
      run('UPDATE tryons SET charged=1, generation_started_at=COALESCE(generation_started_at,?), generation_seconds=? WHERE id=?', now(), total, id);
    });
  }
  function safeFile(relative) {
    const target = path.resolve(directory, relative);
    if (!target.startsWith(path.resolve(directory) + path.sep)) throw new Error('Storage boundary violation');
    return target;
  }
  function hideTryon(id,visitorId) {
    const row=get('SELECT * FROM tryons WHERE id=? AND visitor_id=?',id,visitorId);
    if(!row)throw fail(404,'视频不存在。');
    if(['queued','reserved','connecting','recording'].includes(row.status))throw fail(409,'请先结束本次试衣。');
    if(row.user_hidden_at!==null)return;
    transaction(()=>{
      run('UPDATE tryons SET user_hidden_at=? WHERE id=?',now(),id);
      run('INSERT INTO video_actions(tryon_id,action,actor,created_at) VALUES (?,?,?,?)',id,'hide','owner',now());
    });
  }
  function restoreTryon(id) {
    const row=get('SELECT * FROM tryons WHERE id=?',id);
    if(!row)throw fail(404,'视频不存在。');
    if(row.user_hidden_at===null)return;
    transaction(()=>{
      run('UPDATE tryons SET user_hidden_at=NULL WHERE id=?',id);
      run('INSERT INTO video_actions(tryon_id,action,actor,created_at) VALUES (?,?,?,?)',id,'restore','admin',now());
    });
  }
  function deleteTryon(id,actor='retention') {
    const row = get('SELECT * FROM tryons WHERE id=?', id);
    if (!row) return;
    if (['queued','reserved','connecting','recording','processing'].includes(row.status)) throw fail(409, '请先结束排队或等待视频处理。');
    for (const folder of ['sessions','temporary']) rmSync(safeFile(path.join(folder,id)), { recursive: true, force: true });
    transaction(()=>{
      run('INSERT INTO video_actions(tryon_id,action,actor,created_at) VALUES (?,?,?,?)',id,'delete',actor,now());
      run('DELETE FROM tryons WHERE id=?', id);
    });
  }
  return { db, directory, get, all, run, transaction, settings, storage, canWrite, reserveWrite, quota, reserve, markReady,markRecordingStarted,pumpQueue,queueInfo,heartbeatQueue,rate, generation, now, safeFile, hideTryon,restoreTryon,deleteTryon, close: () => db.close() };
}
