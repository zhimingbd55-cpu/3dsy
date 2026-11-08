import {fail} from './config.mjs';
import {beijingDay} from './store.mjs';

export const ANALYTICS_TYPES=Object.freeze(['page_view','camera_request','camera_ready','camera_failed','garment_select','start_click','library_open','promotion_open','business_open','upload_open','upload_success','share_play','share_tryon_click']);
const homeTypes=new Set(ANALYTICS_TYPES.filter(type=>!type.startsWith('share_')));
const shareTypes=new Set(['page_view','share_play','share_tryon_click']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY=86400000,RETENTION=90*DAY,LIVE_WINDOW_SECONDS=120;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));

export function createAnalytics(store){
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY,value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS analytics_eligible (visitor_id TEXT PRIMARY KEY REFERENCES visitors(id) ON DELETE CASCADE,enabled_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS analytics_visits (id TEXT PRIMARY KEY,visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,page TEXT NOT NULL CHECK(page IN ('home','share')),created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS analytics_visits_time ON analytics_visits(created_at,page,visitor_id);
    CREATE INDEX IF NOT EXISTS analytics_visits_visitor ON analytics_visits(visitor_id,page,created_at);
    CREATE TABLE IF NOT EXISTS analytics_events (id TEXT PRIMARY KEY,visit_id TEXT NOT NULL REFERENCES analytics_visits(id) ON DELETE CASCADE,type TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS analytics_events_visit ON analytics_events(visit_id,created_at);
    CREATE INDEX IF NOT EXISTS analytics_events_time ON analytics_events(created_at,visit_id,type);
    CREATE UNIQUE INDEX IF NOT EXISTS analytics_single_pageview ON analytics_events(visit_id) WHERE type='page_view';
    CREATE TABLE IF NOT EXISTS analytics_presence (visit_id TEXT PRIMARY KEY REFERENCES analytics_visits(id) ON DELETE CASCADE,last_seen_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS analytics_presence_seen ON analytics_presence(last_seen_at,visit_id);
  `);
  store.run("INSERT OR IGNORE INTO analytics_meta(key,value) VALUES ('tracking_since',?)",store.now());
  const trackingSince=Number(store.get("SELECT value FROM analytics_meta WHERE key='tracking_since'").value);
  let nextCleanup=0;
  function cleanup(force=false){
    const now=store.now();if(!force&&now<nextCleanup)return;
    store.transaction(()=>{
      store.run('DELETE FROM analytics_visits WHERE created_at<?',now-RETENTION);
      store.run('DELETE FROM analytics_events WHERE created_at<?',now-RETENTION);
      store.run('DELETE FROM analytics_eligible WHERE enabled_at<? AND NOT EXISTS(SELECT 1 FROM analytics_visits v WHERE v.visitor_id=analytics_eligible.visitor_id)',now-RETENTION);
    });nextCleanup=now+3600000;
  }
  cleanup();
  const timer=setInterval(()=>{try{cleanup();}catch{clearInterval(timer);}},3600000);timer.unref?.();
  function enable(visitorId){
    cleanup();store.run('INSERT INTO analytics_eligible(visitor_id,enabled_at) VALUES (?,?) ON CONFLICT(visitor_id) DO UPDATE SET enabled_at=excluded.enabled_at',visitorId,store.now());
  }
  function receive(visitorId,body){
    cleanup();
    if(!store.get('SELECT 1 FROM analytics_eligible WHERE visitor_id=?',visitorId))throw fail(401,'请先打开试衣首页或有效分享页面。');
    if(!exact(body,['visitId','page','events'])||!uuid.test(body.visitId??'')||!['home','share'].includes(body.page)||!Array.isArray(body.events)||body.events.length<1||body.events.length>20)throw fail(400,'访问记录格式无效。');
    const allowed=body.page==='home'?homeTypes:shareTypes;
    for(const event of body.events)if(!exact(event,['id','type'])||!uuid.test(event.id??'')||typeof event.type!=='string'||!allowed.has(event.type))throw fail(400,'访问动作无效。');
    store.rate(`analytics:${visitorId}`,120,60000);
    return store.transaction(()=>{
      const visitId=body.visitId.toLowerCase(),visit=store.get('SELECT * FROM analytics_visits WHERE id=?',visitId),now=store.now();
      if(visit&&(visit.visitor_id!==visitorId||visit.page!==body.page))throw fail(409,'访问记录不匹配。');
      if(!visit){
        if(!body.events.some(event=>event.type==='page_view'))throw fail(409,'请先提交页面访问记录。');
        store.run('INSERT INTO analytics_visits(id,visitor_id,page,created_at) VALUES (?,?,?,?)',visitId,visitorId,body.page,now);
      }
      let accepted=0;
      for(const event of body.events){
        const id=event.id.toLowerCase(),existing=store.get('SELECT visit_id,type FROM analytics_events WHERE id=?',id);
        if(existing){if(existing.visit_id!==visitId||existing.type!==event.type)throw fail(409,'访问动作标识冲突。');continue;}
        // A page instance is one PV even if a buggy/retrying client gives its
        // page_view another UUID. Other event IDs remain individually idempotent.
        if(event.type==='page_view'&&store.get("SELECT 1 FROM analytics_events WHERE visit_id=? AND type='page_view'",visitId))continue;
        store.run('INSERT INTO analytics_events(id,visit_id,type,created_at) VALUES (?,?,?,?)',id,visitId,event.type,now);accepted++;
        if(event.type==='page_view')store.run('INSERT INTO analytics_presence(visit_id,last_seen_at) VALUES (?,?) ON CONFLICT(visit_id) DO NOTHING',visitId,now);
        else store.run('UPDATE analytics_presence SET last_seen_at=? WHERE visit_id=?',now,visitId);
      }
      return {accepted,duplicate:body.events.length-accepted};
    });
  }
  function presence(visitorId,body){
    cleanup();
    if(!exact(body,['visitId','page'])||!uuid.test(body.visitId??'')||!['home','share'].includes(body.page))throw fail(400,'页面活动记录格式无效。');
    const visitId=body.visitId.toLowerCase(),visit=store.get('SELECT visitor_id,page,created_at FROM analytics_visits WHERE id=?',visitId);
    if(!visit)throw fail(404,'页面访问记录不存在或已过期。');
    if(visit.visitor_id!==visitorId||visit.page!==body.page)throw fail(409,'页面访问记录不匹配。');
    const now=store.now();if(visit.created_at<now-RETENTION)throw fail(410,'页面访问记录已过期。');
    store.rate(`analytics-presence:${visitorId}`,120,60000);
    store.run('INSERT INTO analytics_presence(visit_id,last_seen_at) VALUES (?,?) ON CONFLICT(visit_id) DO UPDATE SET last_seen_at=excluded.last_seen_at',visitId,now);
    return {seenAt:now};
  }
  function report(query={}){
    cleanup();
    const integer=(value,fallback,min,max)=>{if(value===undefined)return fallback;if(typeof value!=='string'||!/^\d+$/.test(value))throw fail(400,'统计筛选无效。');const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw fail(400,'统计筛选无效。');return n;};
    const days=integer(query.days,1,1,30),offset=integer(query.offset,0,0,1000000),limit=integer(query.limit,50,1,100),segment=query.segment??'all';
    if(![1,7,30].includes(days)||!['all','opened_only','no_tryon','tried'].includes(segment))throw fail(400,'统计筛选无效。');
    const endAt=store.now(),endDay=beijingDay(endAt),dayStart=Date.parse(`${endDay}T00:00:00+08:00`),startAt=dayStart-(days-1)*DAY,from=Math.max(startAt,trackingSince),range={days,startAt,endAt,startDay:beijingDay(startAt),endDay};
    // Aggregate visits, actions and try-ons independently. Joining raw events
    // to raw recordings would multiply both PV and completed-session counts.
    const cte=`WITH scoped_visits AS (
      SELECT * FROM analytics_visits WHERE created_at>=? AND created_at<=?
    ), home AS (
      SELECT visitor_id,COUNT(*) visits,MIN(created_at) firstVisitAt,MAX(created_at) lastVisitAt FROM scoped_visits WHERE page='home' GROUP BY visitor_id
    ), actions AS (
      SELECT v.visitor_id,SUM(CASE WHEN e.type NOT IN ('page_view','camera_ready','camera_failed') THEN 1 ELSE 0 END) activeActions,
        SUM(CASE WHEN e.type='start_click' THEN 1 ELSE 0 END) startClicks
      FROM analytics_events e JOIN analytics_visits v ON v.id=e.visit_id WHERE v.page='home' AND e.created_at>=? AND e.created_at<=? GROUP BY v.visitor_id
    ), sessions AS (
      SELECT t.visitor_id,COUNT(*) tryonCount,
        SUM(CASE WHEN t.generation_started_at IS NOT NULL THEN 1 ELSE 0 END) generationCount,
        SUM(CASE WHEN t.recording_started_at IS NOT NULL AND t.ended_at IS NOT NULL THEN 1 ELSE 0 END) endedCount,
        SUM(CASE WHEN (SELECT COUNT(*) FROM recordings r WHERE r.tryon_id=t.id AND r.status='ready' AND r.final_path IS NOT NULL)=2 THEN 1 ELSE 0 END) savedPairCount
      FROM tryons t JOIN home h ON h.visitor_id=t.visitor_id
      WHERE t.created_at>=? AND t.created_at<=? GROUP BY t.visitor_id
    ), cohort AS (
      SELECT h.*,COALESCE(a.activeActions,0) activeActions,COALESCE(a.startClicks,0) startClicks,
        COALESCE(s.tryonCount,0) tryonCount,COALESCE(s.generationCount,0) generationCount,COALESCE(s.endedCount,0) endedCount,COALESCE(s.savedPairCount,0) savedPairCount,
        agent.name agentName
      FROM home h LEFT JOIN actions a ON a.visitor_id=h.visitor_id LEFT JOIN sessions s ON s.visitor_id=h.visitor_id
      LEFT JOIN visitors visitor ON visitor.id=h.visitor_id LEFT JOIN agents agent ON agent.id=visitor.agent_id
    )`;
    const params=[from,endAt,from,endAt,from,endAt];
    const aggregate=store.get(`${cte} SELECT COUNT(*) homeUV,COALESCE(SUM(visits),0) homePV,
      COALESCE(SUM(activeActions=0 AND tryonCount=0),0) openedOnlyUV,COALESCE(SUM(generationCount=0),0) noTryonUV,COALESCE(SUM(generationCount>0),0) triedUV,
      COALESCE(SUM(startClicks>0),0) startClickUV,COALESCE(SUM(startClicks),0) startClicks,
      COALESCE(SUM(tryonCount>0),0) sessionUV,COALESCE(SUM(tryonCount),0) sessions,
      COALESCE(SUM(generationCount>0),0) startedUV,COALESCE(SUM(generationCount),0) started,
      COALESCE(SUM(endedCount>0),0) endedUV,COALESCE(SUM(endedCount),0) ended,
      COALESCE(SUM(savedPairCount>0),0) savedUV,COALESCE(SUM(savedPairCount),0) saved FROM cohort`,...params);
    const shares=store.get("SELECT COUNT(*) sharePV,COUNT(DISTINCT visitor_id) shareUV FROM analytics_visits WHERE page='share' AND created_at>=? AND created_at<=?",from,endAt);
    const where={all:'1',opened_only:'activeActions=0 AND tryonCount=0',no_tryon:'generationCount=0',tried:'generationCount>0'}[segment];
    const total=store.get(`${cte} SELECT COUNT(*) n FROM cohort WHERE ${where}`,...params).n;
    const rows=store.all(`${cte} SELECT * FROM cohort WHERE ${where} ORDER BY lastVisitAt DESC,visitor_id LIMIT ? OFFSET ?`,...params,limit,offset);
    const items=rows.map(row=>({id:row.visitor_id,firstVisitAt:row.firstVisitAt,lastVisitAt:row.lastVisitAt,visits:row.visits,
      actions:Object.fromEntries(store.all("SELECT e.type,COUNT(*) n FROM analytics_events e JOIN analytics_visits v ON v.id=e.visit_id WHERE v.page='home' AND v.visitor_id=? AND e.created_at>=? AND e.created_at<=? GROUP BY e.type",row.visitor_id,from,endAt).map(value=>[value.type,value.n])),
      activeActions:row.activeActions,tryonCount:row.tryonCount,generationCount:row.generationCount,endedCount:row.endedCount,savedPairCount:row.savedPairCount,agentName:row.agentName??null,
      stage:row.savedPairCount?'pair_saved':row.endedCount?'recording_ended':row.generationCount?'generated':row.tryonCount?'session_created':row.startClicks?'start_clicked':row.activeActions?'interacted':'opened_only'}));
    const actionRows=store.all('SELECT e.type,COUNT(*) count,COUNT(DISTINCT v.visitor_id) visitors FROM analytics_events e JOIN analytics_visits v ON v.id=e.visit_id WHERE e.created_at>=? AND e.created_at<=? GROUP BY e.type',from,endAt);
    const actions=ANALYTICS_TYPES.map(type=>({type,visitors:actionRows.find(row=>row.type===type)?.visitors??0,count:actionRows.find(row=>row.type===type)?.count??0}));
    // Presence is recent receipt evidence, not an exact count of connected people.
    // Multiple tabs/pages share one browser identity; real try-ons remain a
    // separate server-derived count even without a tracked homepage visit.
    const recent=store.get(`SELECT COUNT(DISTINCT CASE WHEN v.page='home' THEN v.visitor_id END) homeActiveUV,
      COUNT(DISTINCT CASE WHEN v.page='share' THEN v.visitor_id END) shareActiveUV,
      COUNT(DISTINCT v.visitor_id) activeUV FROM analytics_presence p JOIN analytics_visits v ON v.id=p.visit_id
      WHERE p.last_seen_at>=? AND p.last_seen_at<=?`,endAt-LIVE_WINDOW_SECONDS*1000,endAt);
    const trying=store.get("SELECT COUNT(DISTINCT visitor_id) tryingUV,COUNT(*) tryingSessions FROM tryons WHERE status IN ('connecting','recording') AND ended_at IS NULL");
    const live={windowSeconds:LIVE_WINDOW_SECONDS,...recent,...trying,serverNow:endAt};
    return {trackingSince,timezone:'Asia/Shanghai',range,summary:{...aggregate,...shares},live,actionScope:'all_pages',visitScope:'page_opened_in_range',actions,items,total,offset,limit,segment};
  }
  return {enable,receive,presence,report,cleanup,trackingSince,close:()=>clearInterval(timer)};
}
