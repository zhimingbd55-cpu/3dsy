import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,randomBytes,createHash,scryptSync} from 'node:crypto';
import {createApp} from '../server/app.mjs';
import {createAnalytics,ANALYTICS_TYPES} from '../server/analytics.mjs';

const DAY=86400000;
async function fixture(t,initial=Date.parse('2026-10-12T02:00:00Z')){
  const directory=await mkdtemp(path.join(os.tmpdir(),'amen-analytics-'));let clock=initial;
  const c=createApp({dataDirectory:directory,minFreeBytes:0,now:()=>clock,apiKey:'mock-only',dev:true,origin:'http://127.0.0.1',adminHash:'scrypt$test$'+scryptSync('qa-password','test',64).toString('hex')});
  const server=http.createServer(c.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;c.setOrigin(origin);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));c.close();await rm(directory,{recursive:true,force:true});});
  const person=()=>{let cookie='';return {async call(url,method='GET',body,extra={}){
    const response=await fetch(origin+url,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
    const received=response.headers.get('set-cookie');if(received)cookie=received.split(';')[0];return response;
  },id(){const token=cookie.slice(cookie.indexOf('=')+1);return c.store.get('SELECT id FROM visitors WHERE token_hash=?',createHash('sha256').update(token).digest('hex'))?.id;}};};
  const admin=person();assert.equal((await admin.call('/api/admin/login','POST',{username:'admin',password:'qa-password'})).status,200);
  return {...c,origin,person,admin,now:()=>clock,set:time=>{clock=time;},advance:ms=>{clock+=ms;}};
}
const event=type=>({id:randomUUID(),type});
const visit=(page='home',types=[])=>({visitId:randomUUID(),page,events:[event('page_view'),...types.map(event)]});
async function enabled(f){const person=f.person();assert.equal((await person.call('/api/me')).status,200);return person;}
async function submit(person,body){const response=await person.call('/api/analytics/events','POST',body);assert.equal(response.status,200,await response.clone().text());return response.json();}
const report=(f,query='')=>f.admin.call('/api/admin/analytics'+query).then(response=>response.json());
function session(f,person,{createdAt=f.now(),generation=false,recorded=false,ended=false,saved=false,status='saving'}={}){
  const id=randomUUID();f.store.run('INSERT INTO tryons(id,visitor_id,garment_name,created_at,day,status,reserved_bytes,generation_started_at,recording_started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)',id,person.id(),'QA',createdAt,'2026-10-12',status,0,generation?createdAt:null,recorded?createdAt:null,ended?createdAt+1:null);
  for(const kind of ['original','result'])f.store.run('INSERT INTO recordings(id,tryon_id,kind,status,final_path) VALUES (?,?,?,?,?)',randomUUID(),id,kind,saved?'ready':'uploading',saved?`files/qa-${id}-${kind}.mp4`:null);
  return id;
}

test('analytics never creates identities or visits for anonymous posts, API polling, list reads or metadata requests',async t=>{
  const f=await fixture(t),anonymous=f.person();
  let response=await anonymous.call('/api/analytics/events','POST',visit());assert.equal(response.status,401);assert.equal(response.headers.get('set-cookie'),null);assert.equal(f.store.get('SELECT COUNT(*) n FROM visitors').n,0);
  await anonymous.call('/');assert.equal(f.store.get('SELECT COUNT(*) n FROM visitors').n,0);
  await anonymous.call('/api/garments');assert.equal(f.store.get('SELECT COUNT(*) n FROM visitors').n,1);
  response=await anonymous.call('/api/analytics/events','POST',visit());assert.equal(response.status,401,'a cookie from an asset/list path alone is not eligible');
  await anonymous.call('/api/me');await anonymous.call('/api/me');await anonymous.call('/api/tryons');
  assert.equal(f.store.get('SELECT COUNT(*) n FROM analytics_visits').n,0);assert.equal((await report(f)).summary.homeUV,0);
  await submit(anonymous,visit());assert.equal((await report(f)).summary.homeUV,1);
  assert.equal((await anonymous.call('/api/admin/analytics')).status,401);
});

test('batches are strictly bounded, page-scoped, idempotent and atomic on owner/event conflicts',async t=>{
  const f=await fixture(t),a=await enabled(f),b=await enabled(f),body=visit('home',['camera_ready','garment_select']);
  assert.deepEqual(await submit(a,body),{accepted:3,duplicate:0});assert.deepEqual(await submit(a,body),{accepted:0,duplicate:3});
  assert.deepEqual(await submit(a,{...body,events:[event('page_view')]}),{accepted:0,duplicate:1});
  assert.equal((await b.call('/api/analytics/events','POST',body)).status,409);
  assert.equal((await a.call('/api/analytics/events','POST',{...body,page:'share',events:[body.events[0]]})).status,409);
  assert.equal((await a.call('/api/analytics/events','POST',{visitId:randomUUID(),page:'home',events:[event('start_click')]})).status,409);
  const conflicting=visit();conflicting.events.push({...body.events[1],type:'start_click'});
  assert.equal((await a.call('/api/analytics/events','POST',conflicting)).status,409);assert.equal(f.store.get('SELECT COUNT(*) n FROM analytics_visits').n,1,'conflict rolled back its newly created visit');
  for(const malformed of [
    {...visit(),events:Array.from({length:21},()=>event('page_view'))},{...visit(),events:[]},
    {...visit(),visitorId:b.id()},{...visit(),url:'https://private.example/s/token'},
    {...visit(),events:[{...event('page_view'),ip:'192.0.2.1'}]},
    visit('home',['generation_started']),visit('home',['share_play']),visit('share',['camera_request']),
    {...visit(),visitId:'not-a-uuid'},
  ])assert.equal((await a.call('/api/analytics/events','POST',malformed)).status,400);
  const counts=await report(f);assert.equal(counts.summary.homePV,1);assert.equal(counts.actions.find(row=>row.type==='garment_select').count,1);assert.equal(counts.summary.started,0);
  const columns=f.store.all('PRAGMA table_info(analytics_events)').map(row=>row.name);assert.deepEqual(columns,['id','visit_id','type','created_at']);
  assert.equal(f.store.get('SELECT COUNT(*) n FROM analytics_events').n,3);
});

test('valid public share page enables the existing cookie but neither page HTML nor media polling becomes a PV',async t=>{
  const f=await fixture(t),owner=await enabled(f),id=session(f,owner),token=randomBytes(32).toString('base64url');
  f.store.run('INSERT INTO video_shares(tryon_id,token_hash,token_cipher,created_at,expires_at) VALUES (?,?,?,?,?)',id,createHash('sha256').update(token).digest('hex'),'qa-unused-cipher',f.now(),f.now()+DAY);
  const viewer=f.person();assert.equal((await viewer.call('/s/'+token)).status,200);
  assert.equal(f.store.get('SELECT COUNT(*) n FROM analytics_visits').n,0);
  const payload=visit('share',['share_play','share_tryon_click']);await submit(viewer,payload);await submit(viewer,payload);
  const r=await report(f);assert.equal(r.summary.homeUV,0);assert.equal(r.summary.shareUV,1);assert.equal(r.summary.sharePV,1);assert.equal(r.total,0);assert.equal(r.actions.find(row=>row.type==='share_play').count,1);
  const unknown=f.person();assert.equal((await unknown.call('/s/not-valid')).status,404);assert.equal((await unknown.call('/api/analytics/events','POST',visit('share'))).status,401);
});

test('funnel uses independent aggregates and actual server phases; only opened excludes automatic camera events',async t=>{
  const f=await fixture(t),a=await enabled(f),b=await enabled(f),c=await enabled(f),d=await enabled(f),shareOnly=await enabled(f),legacy=await enabled(f);
  // An existing identity and even a server session do not manufacture visits.
  session(f,legacy,{generation:true,recorded:true,ended:true,saved:true});
  await submit(a,visit('home',['camera_ready','camera_failed']));await submit(a,visit());
  await submit(b,visit('home',['camera_request','start_click','start_click','garment_select','garment_select','promotion_open']));
  await submit(c,visit('home',['library_open']));await submit(d,visit());await submit(shareOnly,visit('share',['share_play']));
  session(f,b,{status:'reserved'});session(f,b,{generation:true,recorded:true,ended:true,saved:true,status:'interrupted'});session(f,d,{status:'reserved'});
  const agent=randomUUID();f.store.run('INSERT INTO agents(id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)',agent,'qa-agent','测试代理',f.now(),f.now());f.store.run('UPDATE visitors SET agent_id=? WHERE id=?',agent,b.id());
  const r=await report(f);assert.deepEqual(r.summary,{homeUV:4,homePV:5,openedOnlyUV:1,noTryonUV:3,triedUV:1,startClickUV:1,startClicks:2,sessionUV:2,sessions:3,startedUV:1,started:1,endedUV:1,ended:1,savedUV:1,saved:1,sharePV:1,shareUV:1});
  assert.equal(r.items.find(item=>item.id===a.id()).stage,'opened_only');assert.equal(r.items.find(item=>item.id===c.id()).stage,'interacted');assert.equal(r.items.find(item=>item.id===d.id()).stage,'session_created');
  const converted=r.items.find(item=>item.id===b.id());assert.equal(converted.stage,'pair_saved');assert.equal(converted.agentName,'测试代理');assert.equal(converted.tryonCount,2);assert.equal(converted.actions.garment_select,2);
  assert.equal(r.actions.length,ANALYTICS_TYPES.length);assert.equal(r.actions.find(item=>item.type==='page_view').count,6);assert.equal(r.actions.find(item=>item.type==='page_view').visitors,5);
  assert.equal((await report(f,'?segment=opened_only')).total,1);assert.equal((await report(f,'?segment=no_tryon')).total,3);assert.equal((await report(f,'?segment=tried')).total,1);
  const page1=await report(f,'?limit=2'),page2=await report(f,'?limit=2&offset=2');assert.equal(page1.total,4);assert.equal(page2.items.length,2);assert.equal(new Set([...page1.items,...page2.items].map(item=>item.id)).size,4);
});

test('generation, recording end and paired save remain distinct and ignore sessions before tracking was enabled',async t=>{
  const f=await fixture(t),person=await enabled(f);f.advance(10000);
  session(f,person,{createdAt:f.analytics.trackingSince-1000,generation:true,recorded:true,ended:true,saved:true});
  await submit(person,visit());session(f,person,{generation:true,ended:true,status:'failed'});
  const readyStatus=session(f,person,{status:'ready'});const partial=session(f,person,{generation:true,recorded:true,ended:true,status:'saving'});
  f.store.run("UPDATE recordings SET status='ready',final_path='files/qa.mp4' WHERE tryon_id=? AND kind='result'",partial);
  f.store.run("UPDATE recordings SET status='ready',final_path=NULL WHERE tryon_id=?",readyStatus);
  const r=await report(f);assert.equal(r.summary.sessions,3);assert.equal(r.summary.started,2);assert.equal(r.summary.ended,1);assert.equal(r.summary.saved,0,'tryons.ready and a recovered/single video never imply paired save');
});

test('Beijing day boundaries, days filters and server receipt timestamps are explicit',async t=>{
  const f=await fixture(t,Date.parse('2026-10-11T15:59:59Z')),person=await enabled(f);await submit(person,visit());
  const before=await report(f);assert.equal(before.range.endDay,'2026-10-11');assert.equal(before.summary.homePV,1);
  f.advance(2000);await submit(person,visit('home',['start_click']));session(f,person,{generation:true});
  const today=await report(f);assert.equal(today.range.startDay,'2026-10-12');assert.equal(today.range.startAt,Date.parse('2026-10-11T16:00:00Z'));assert.equal(today.summary.homePV,1);assert.equal(today.summary.started,1);
  const week=await report(f,'?days=7');assert.equal(week.summary.homePV,2);assert.equal(week.summary.homeUV,1);assert.equal(week.trackingSince,before.trackingSince);
  const timestamps=f.store.all('SELECT DISTINCT created_at FROM analytics_events ORDER BY created_at');assert.deepEqual(timestamps.map(row=>row.created_at),[Date.parse('2026-10-11T15:59:59Z'),Date.parse('2026-10-11T16:00:01Z')]);
  for(const query of ['?days=2','?days=x','?segment=unknown','?limit=0','?limit=101','?offset=-1','?days=1&days=7'])assert.equal((await f.admin.call('/api/admin/analytics'+query)).status,400);
});

test('90-day cleanup removes analytics only and tracking start survives service recreation',async t=>{
  const f=await fixture(t),person=await enabled(f);await submit(person,visit('home',['start_click']));const id=session(f,person,{generation:true,saved:true});
  const since=f.analytics.trackingSince;f.advance(90*DAY+1);f.analytics.cleanup(true);
  assert.equal(f.store.get('SELECT COUNT(*) n FROM analytics_visits').n,0);assert.equal(f.store.get('SELECT COUNT(*) n FROM analytics_events').n,0);
  assert(f.store.get('SELECT id FROM visitors WHERE id=?',person.id()));assert(f.store.get('SELECT id FROM tryons WHERE id=?',id));assert.equal(f.store.get('SELECT COUNT(*) n FROM recordings WHERE tryon_id=?',id).n,2);
  f.analytics.close();const reopened=createAnalytics(f.store);try{assert.equal(reopened.trackingSince,since);assert.equal(reopened.report().summary.homeUV,0);}finally{reopened.close();}
});

test('a delayed first pageview still links real in-range sessions without fabricating earlier history',async t=>{
  const f=await fixture(t),person=await enabled(f);f.advance(1000);session(f,person,{generation:true,recorded:true,ended:true,saved:true});
  assert.equal((await report(f)).summary.sessions,0,'no event means no analytics cohort yet');
  f.advance(60000);await submit(person,visit());const r=await report(f);assert.equal(r.summary.homeUV,1);assert.equal(r.summary.sessions,1);assert.equal(r.summary.started,1);assert.equal(r.summary.saved,1);assert.equal(r.summary.openedOnlyUV,0);
});

test('share actions do not classify passive homepage visitors as active; all-page action totals are explicitly separate',async t=>{
  const f=await fixture(t),person=await enabled(f);await submit(person,visit('home',['camera_ready']));await submit(person,visit('share',['share_play','share_tryon_click']));
  const r=await report(f);assert.equal(r.summary.openedOnlyUV,1);assert.equal(r.items[0].activeActions,0);assert.equal(r.items[0].actions.share_play,undefined);
  assert.equal(r.actions.find(row=>row.type==='share_play').count,1);assert.equal(r.actionScope,'all_pages');assert.equal(r.visitScope,'page_opened_in_range');
});

test('cross-midnight actions count in action totals without inventing a new opened-page UV',async t=>{
  const f=await fixture(t,Date.parse('2026-10-11T15:59:59Z')),person=await enabled(f),body=visit();await submit(person,body);f.advance(2000);
  await submit(person,{...body,events:[body.events[0],event('start_click')]});const r=await report(f);
  assert.equal(r.summary.homeUV,0);assert.equal(r.summary.homePV,0);assert.equal(r.items.length,0);assert.equal(r.actions.find(row=>row.type==='start_click').count,1);assert.equal(r.actions.find(row=>row.type==='page_view').count,0);
});

test('optional analytics failure never prevents api/me or a valid share page from serving',async t=>{
  const f=await fixture(t),owner=await enabled(f),id=session(f,owner),token=randomBytes(32).toString('base64url');
  f.store.run('INSERT INTO video_shares(tryon_id,token_hash,token_cipher,created_at,expires_at) VALUES (?,?,?,?,?)',id,createHash('sha256').update(token).digest('hex'),'qa-unused-cipher',f.now(),f.now()+DAY);
  f.analytics.enable=()=>{throw new Error('Simulated optional analytics storage failure');};
  assert.equal((await f.person().call('/api/me')).status,200);assert.equal((await f.person().call('/s/'+token)).status,200);
});

test('presence requires a real existing page owned by the cookie and cannot create identities, visits or actions',async t=>{
  const f=await fixture(t),anonymous=f.person(),body={visitId:randomUUID(),page:'home'};
  let response=await anonymous.call('/api/analytics/presence','POST',body);assert.equal(response.status,401);assert.equal(response.headers.get('set-cookie'),null);assert.equal(f.store.get('SELECT COUNT(*) n FROM visitors').n,0);
  const a=await enabled(f),b=await enabled(f);assert.equal((await a.call('/api/analytics/presence','POST',body)).status,404);
  const registered=visit();await submit(a,registered);const valid={visitId:registered.visitId,page:registered.page};
  assert.equal((await b.call('/api/analytics/presence','POST',valid)).status,409);
  assert.equal((await a.call('/api/analytics/presence','POST',{...valid,page:'share'})).status,409);
  assert.equal((await a.call('/api/analytics/presence','POST',valid,{Origin:'https://untrusted.example'})).status,403);
  for(const invalid of [{...valid,visitorId:b.id()},{...valid,seenAt:f.now()},{...valid,url:'/s/private'},{...valid,page:'admin'},{visitId:valid.visitId},{...valid,visitId:'invalid'}])assert.equal((await a.call('/api/analytics/presence','POST',invalid)).status,400);
  assert.equal(f.store.get('SELECT COUNT(*) n FROM analytics_visits').n,1);assert.equal(f.store.get('SELECT COUNT(*) n FROM analytics_events').n,1);
});

test('only first page_view or a new action refreshes presence; heartbeat uses server time without adding PV or actions',async t=>{
  const f=await fixture(t),person=await enabled(f),body=visit(),started=f.now();await submit(person,body);
  const seen=()=>f.store.get('SELECT last_seen_at FROM analytics_presence WHERE visit_id=?',body.visitId).last_seen_at;
  assert.equal(seen(),started);f.advance(60000);await submit(person,body);await submit(person,{...body,events:[event('page_view')]});assert.equal(seen(),started,'duplicate pageviews cannot renew presence');
  const click=event('library_open');await submit(person,{...body,events:[click]});assert.equal(seen(),f.now());
  f.advance(60000);await submit(person,{...body,events:[click]});assert.equal(seen(),started+60000,'replayed actions do not appear as new activity');
  f.advance(60001);assert.equal((await report(f)).live.activeUV,0,'recent activity expires after 120 seconds');
  const counts=f.store.get('SELECT COUNT(*) n FROM analytics_events').n;
  for(let i=0;i<3;i++){f.advance(1000);const response=await person.call('/api/analytics/presence','POST',{visitId:body.visitId,page:'home'});assert.equal(response.status,200);assert.deepEqual(await response.json(),{seenAt:f.now()});}
  const r=await report(f);assert.equal(r.live.homeActiveUV,1);assert.equal(r.live.activeUV,1);assert.equal(r.live.serverNow,f.now());assert.equal(r.summary.homePV,1);assert.equal(r.actions.find(x=>x.type==='page_view').count,1);assert.equal(f.store.get('SELECT COUNT(*) n FROM analytics_events').n,counts);
});

test('live browsers deduplicate multiple tabs and home/share overlap independently of report date or visitor filter',async t=>{
  const f=await fixture(t),a=await enabled(f),b=await enabled(f);
  await submit(a,visit());await submit(a,visit());await submit(a,visit('share'));await submit(b,visit('share'));
  const expected={windowSeconds:120,homeActiveUV:1,shareActiveUV:2,activeUV:2,tryingUV:0,tryingSessions:0,serverNow:f.now()};
  assert.deepEqual((await report(f)).live,expected);assert.deepEqual((await report(f,'?days=30&segment=tried')).live,expected);
  assert.equal((await report(f)).summary.homePV,2);assert.equal((await report(f)).summary.sharePV,2);
  f.advance(120001);const expired=(await report(f)).live;assert.equal(expired.activeUV,0);assert.equal(expired.homeActiveUV,0);assert.equal(expired.shareActiveUV,0);
});

test('trying counts come from live server sessions without requiring homepage events or accepting client claims',async t=>{
  const f=await fixture(t),person=await enabled(f),other=await enabled(f);
  session(f,person,{status:'connecting'});const active=session(f,person,{status:'recording',generation:true,recorded:true});
  session(f,other,{status:'recording',ended:true});session(f,other,{status:'reserved'});session(f,other,{status:'saving'});
  const r=await report(f);assert.equal(r.summary.homeUV,0);assert.equal(r.summary.sessions,0);assert.equal(r.live.activeUV,0);assert.equal(r.live.tryingUV,1);assert.equal(r.live.tryingSessions,2);
  f.store.run('UPDATE tryons SET ended_at=? WHERE id=?',f.now(),active);assert.equal((await report(f)).live.tryingSessions,1);
  assert.equal((await person.call('/api/analytics/events','POST',visit('home',['trying']))).status,400);assert.equal((await report(f)).live.tryingSessions,1);
});

test('presence migration does not backfill activity and allows a known old page to heartbeat without changing history',async t=>{
  const f=await fixture(t),person=await enabled(f),body=visit();await submit(person,body);
  f.store.run('DELETE FROM analytics_presence');f.advance(DAY);f.analytics.close();const reopened=createAnalytics(f.store);
  try{
    assert.equal(reopened.report().live.activeUV,0);assert.equal(reopened.report({days:'7'}).summary.homePV,1);
    assert.deepEqual(reopened.presence(person.id(),{visitId:body.visitId,page:'home'}),{seenAt:f.now()});
    assert.equal(reopened.report().live.activeUV,1);assert.equal(reopened.report().summary.homePV,0,'an old page becoming active does not become a new daily PV');
    assert.equal(reopened.report({days:'7'}).summary.homePV,1);
  }finally{reopened.close();}
});

test('presence is rate-limited separately and retention expiry cannot revive a deleted page',async t=>{
  const f=await fixture(t),person=await enabled(f),body=visit();await submit(person,body);const payload={visitId:body.visitId,page:'home'};
  for(let i=0;i<120;i++)assert.equal((await person.call('/api/analytics/presence','POST',payload)).status,200);
  assert.equal((await person.call('/api/analytics/presence','POST',payload)).status,429);
  assert.equal((await report(f)).summary.homePV,1);assert.equal(f.store.get('SELECT COUNT(*) n FROM analytics_events').n,1);
  f.advance(90*DAY+1);f.analytics.cleanup(true);assert.equal(f.store.get('SELECT COUNT(*) n FROM analytics_presence').n,0);
  assert.equal((await person.call('/api/analytics/presence','POST',payload)).status,404);assert.equal(f.analytics.report().live.activeUV,0);assert.equal(f.store.get('SELECT COUNT(*) n FROM visitors').n,1);
});
