import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisitAnalytics} from '../src/visit-analytics.ts';
const settled=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const uuidFactory=()=>{let n=0;return()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;};

test('analytics starts only after identity is ready and keeps one page ID across retries',async()=>{
  const requests=[];
  const visits=createVisitAnalytics('home',{listen:false,hidden:()=>false,uuid:uuidFactory(),fetcher:async(url,init)=>{requests.push({url,...init});return new Response(null,{status:204});}});
  try{
    visits.track('camera_ready');assert.equal(requests.length,0);
    visits.start();visits.start();await settled();
    assert.equal(requests.length,1);assert.equal(requests[0].credentials,'same-origin');
    const first=JSON.parse(requests[0].body);assert.deepEqual(first.events.map(x=>x.type),['page_view','camera_ready']);
    visits.track('start_click');await visits.flush();
    const second=JSON.parse(requests[1].body);
    assert.equal(second.visitId,first.visitId);assert.equal(second.events[0].id,first.events[0].id);
    assert.deepEqual(Object.keys(second).sort(),['events','page','visitId']);
    assert.equal(second.events.filter(x=>x.type==='start_click').length,1);
  }finally{visits.dispose();}
});

test('live streaming pauses analytics and resumes its bounded batch without losing actions',async()=>{
  const requests=[];
  const visits=createVisitAnalytics('home',{listen:false,hidden:()=>false,uuid:uuidFactory(),fetcher:async(_,init)=>{requests.push(JSON.parse(init.body));return new Response(null,{status:204});}});
  try{
    visits.start();await settled();visits.setPaused(true);visits.track('garment_select');
    await visits.flush();assert.equal(requests.length,1);
    visits.setPaused(false);await visits.flush();assert.equal(requests.length,2);
    assert.deepEqual(requests[1].events.map(x=>x.type),['page_view','garment_select']);
  }finally{visits.dispose();}
});

test('lost responses resend identical event IDs and failures never escape to the user flow',async()=>{
  const requests=[];let fail=true;
  const visits=createVisitAnalytics('home',{listen:false,hidden:()=>false,uuid:uuidFactory(),fetcher:async(_,init)=>{requests.push(init);if(fail)throw Error('offline');return new Response(null,{status:204});}});
  try{
    visits.track('library_open');visits.start();await settled();fail=false;await visits.flush();
    assert.equal(requests[1].body,requests[0].body);
    await visits.flush();assert.equal(requests.length,2);
  }finally{visits.dispose();}
});

test('background flush uses keepalive, excludes private payloads and bounds queued work',async()=>{
  const requests=[];let hidden=false;
  const visits=createVisitAnalytics('share',{listen:false,hidden:()=>hidden,uuid:uuidFactory(),fetcher:async(_,init)=>{requests.push(init);return new Response(null,{status:204});}});
  try{
    visits.setPaused(true);visits.start();hidden=true;for(let i=0;i<1000;i++)visits.track('share_play');
    assert.equal(requests.length,0);
    for(let i=0;i<10;i++)await visits.flush(true);
    assert(requests.length<=6);assert(requests.length>0);
    const ids=new Set();for(const req of requests){const body=JSON.parse(req.body);assert.equal(req.keepalive,true);assert(body.events.length<=20);assert(req.body.length<2500);assert.equal(body.page,'share');for(const event of body.events){assert.deepEqual(Object.keys(event).sort(),['id','type']);ids.add(event.id);}}
    assert.equal(ids.size,100);
  }finally{visits.dispose();}
});

test('a never-visible background page is not counted and visible presence never inflates PV or actions',async()=>{
  let hidden=true;const requests=[];
  const visits=createVisitAnalytics('home',{listen:false,hidden:()=>hidden,uuid:uuidFactory(),fetcher:async(url,init)=>{requests.push({url,...init});return new Response(null,{status:204});}});
  try{
    visits.start();await visits.flush(true);await visits.pulse();assert.equal(requests.length,0);
    hidden=false;await visits.pulse();assert.equal(requests.length,0,'presence requires acknowledged page view');
    await visits.flush();assert.equal(requests.length,1);visits.setPaused(true);
    await visits.pulse();assert.equal(requests[1].url,'/api/analytics/presence');
    assert.deepEqual(Object.keys(JSON.parse(requests[1].body)).sort(),['page','visitId']);assert(requests[1].body.length<100);
    hidden=true;await visits.pulse();assert.equal(requests.length,2);
    hidden=false;visits.dispose();await visits.pulse();assert.equal(requests.length,2);
  }finally{visits.dispose();}
});

test('four transient failures resume with low-frequency retry without another user action',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let requests=0;
  const visits=createVisitAnalytics('home',{listen:false,hidden:()=>false,uuid:uuidFactory(),fetcher:async()=>{requests++;return new Response(null,{status:requests<=4?503:204});}});
  try{
    visits.start();await settled();for(let i=0;i<3;i++){await visits.flush();}assert.equal(requests,4);
    t.mock.timers.tick(59000);await settled();assert.equal(requests,4);
    t.mock.timers.tick(1000);await settled();assert.equal(requests,5);
    t.mock.timers.tick(120000);await settled();assert.equal(requests,5,'successful queue stays empty');
  }finally{visits.dispose();}
});

test('unavailable UUID capability disables only analytics',async()=>{
  const visits=createVisitAnalytics('home',{listen:false,uuid:()=>{throw Error('blocked');},fetcher:async()=>{throw Error('must not call');}});
  visits.start();visits.track('start_click');visits.setPaused(true);await visits.flush();visits.dispose();
});

test('navigation resends pending IDs with the last click and stale responses cannot clear a newer request',async()=>{
  const requests=[];
  const visits=createVisitAnalytics('share',{listen:false,hidden:()=>false,uuid:uuidFactory(),fetcher:(_,init)=>new Promise(resolve=>requests.push({init,resolve}))});
  try{
    visits.start();visits.track('share_tryon_click');const leaving=visits.flush(true);
    assert.equal(requests.length,2);assert.equal(requests[0].init.signal.aborted,true);
    const first=JSON.parse(requests[0].init.body),last=JSON.parse(requests[1].init.body);
    assert.equal(requests[1].init.keepalive,true);assert.equal(last.events[0].id,first.events[0].id);
    assert.deepEqual(last.events.map(e=>e.type),['page_view','share_tryon_click']);
    // Some transports deliver a success after cancellation. It may acknowledge
    // its own IDs, but it must not mark the replacement request idle.
    requests[0].resolve(new Response(null,{status:204}));await settled();
    visits.track('share_play');await visits.flush();assert.equal(requests.length,2);
    requests[1].resolve(new Response(null,{status:204}));await leaving;
    const next=visits.flush();assert.equal(requests.length,3);
    assert.deepEqual(JSON.parse(requests[2].init.body).events.map(e=>e.type),['page_view','share_play']);
    requests[2].resolve(new Response(null,{status:204}));await next;
  }finally{visits.dispose();}
});
