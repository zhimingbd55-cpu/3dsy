import test from 'node:test';
import assert from 'node:assert/strict';
import {initialDemo,recordingLimit,connectionLimit,deadlineRemaining,watchRotation} from '../src/tryon-flow.ts';

const stable={stabilityMode:'video-frame-callback',stableWindowMs:2001,stableFrames:40};
const snapshot=(seq,status='observing',extra={})=>({status:'recording',flowVersion:1,mode:'auto',serverNow:10000,rotation:{seq,status,garmentId:`g${seq}`,acknowledgedAt:status==='awaiting_ack'?null:10000,deadlineAt:15000,holdDurationSeconds:10,holdEndsAt:null,locked:false,...extra}});
const terminal=()=>({status:'saving',endReason:'flow_completed',rotation:{seq:6,status:'ended'}});
function harness(records,overrides={}){
  const calls=[],updates=[],failures=[];let index=0,ended=false;
  const watcher=watchRotation({signal:new AbortController().signal,initialSeq:1,
    read:async()=>records[Math.min(index++,records.length-1)],
    observe:async()=>{calls.push('observe');return stable;},
    commit:async(seq,value)=>{calls.push(['commit',seq,value]);return snapshot(seq,'holding');},
    updated:value=>updates.push(value),ended:()=>{ended=true;},failed:error=>failures.push(error),wait:async()=>{},...overrides});
  return{watcher,calls,updates,failures,get ended(){return ended;}};
}

test('default uses server demo order without mutating wardrobe or selecting arbitrary previous 3D',()=>{
  const items=[{id:'3d',assetType:'3d',published:true},{id:'fifth',demoOrder:5},{id:'first',demoOrder:1}];
  assert.equal(initialDemo(items).id,'first');assert.equal(items[0].id,'3d');
  assert.equal(initialDemo([{id:'old3d',assetType:'3d',published:true},{id:'2d',assetType:'2d',published:true}]).id,'2d');
  assert.equal(initialDemo([]),undefined);
});
test('new auto/fixed and legacy budgets respect server values and retain long locked recording',()=>{
  assert.equal(recordingLimit({flowVersion:1,mode:'auto'}),180);assert.equal(connectionLimit({flowVersion:1,mode:'auto'}),225);
  assert.equal(recordingLimit({flowVersion:1,mode:'fixed'}),30);assert.equal(connectionLimit({flowVersion:1,mode:'fixed'}),75);
  assert.equal(connectionLimit({}),45);assert.equal(recordingLimit({}),30);
  assert.equal(recordingLimit({...snapshot(2,'holding',{locked:true,holdDurationSeconds:30}),durationLimit:180}),180);
  assert.equal(connectionLimit({connectionBudgetSeconds:90}),90);
});
test('countdown follows receipt server clock instead of possibly skewed local wall clock',()=>{
  assert.equal(deadlineRemaining({serverNow:10000},20000,1250),8750);assert.equal(deadlineRemaining({serverNow:10000},11000,2000),0);
  assert.equal(deadlineRemaining({},20000),null);
});
test('ACK pending and already recorded initial seq never observe; each later seq gets a fresh window',async()=>{
  const h=harness([snapshot(1),snapshot(2,'awaiting_ack'),snapshot(2),snapshot(2),snapshot(3),terminal()]);await h.watcher.done;
  assert.deepEqual(h.calls,['observe',['commit',2,stable],'observe',['commit',3,stable]]);assert.equal(h.ended,true);assert.deepEqual(h.failures,[]);
});
test('locking a different garment does not commit old pending garment frames',async()=>{
  const h=harness([snapshot(2,'observing',{locked:true,lockedGarmentId:'g3'}),snapshot(3,'observing',{locked:true,lockedGarmentId:'g3'}),terminal()]);await h.watcher.done;
  assert.deepEqual(h.calls,['observe',['commit',3,stable]]);
});
test('a lock request in flight blocks stale poll observations until its outcome is known',async()=>{
  let reads=0;
  const h=harness([],{read:async()=>++reads===1?snapshot(2):reads===2?snapshot(3):terminal(),mayObserve:()=>reads!==1});await h.watcher.done;
  assert.deepEqual(h.calls,['observe',['commit',3,stable]]);
});
test('lock invalidates an in-flight observation and its late result cannot commit',async()=>{
  let ready,release;const observing=new Promise(resolve=>{ready=resolve;});const frameWindow=new Promise(resolve=>{release=resolve;});let attempts=0;
  const h=harness([snapshot(2),snapshot(3,'observing',{locked:true,lockedGarmentId:'g3'}),terminal()],{observe:async()=>{attempts++;if(attempts===1){ready();await frameWindow;}return stable;}});
  await observing;h.watcher.invalidate();release();await h.watcher.done;
  assert.deepEqual(h.calls,[['commit',3,stable]]);assert.deepEqual(h.failures,[]);
});
test('expired stable window ends instead of accepting earlier frames or retrying paid session',async()=>{
  const h=harness([snapshot(2,'observing',{deadlineAt:9999})]);await h.watcher.done;
  assert.equal(h.failures.length,1);assert.deepEqual(h.calls,[]);
});
test('stop cancels observation without a stable write or failure callback',async()=>{
  let ready;const observing=new Promise(resolve=>{ready=resolve;});
  const h=harness([snapshot(2)],{observe:signal=>new Promise((resolve,reject)=>{ready();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  await observing;h.watcher.stop();await h.watcher.done;assert.deepEqual(h.calls,[]);assert.deepEqual(h.failures,[]);
});
