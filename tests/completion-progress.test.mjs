import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingComplete,recordingProgress,recordingVersion,pairSavePercent} from '../src/completion-progress.ts';
const record=(status='uploading',extra={})=>({status,receivedChunks:0,expectedChunks:9,url:null,...extra});
const task=(state='retry',extra={})=>({state,recordings:{original:{total:9,uploaded:2,remaining:7}},...extra});

test('server and local per-recording progress remain distinct and zero received never appears saved',()=>{
  const value=recordingProgress(record(),task(),'original');
  assert.equal(value.percent,0);assert.equal(value.complete,false);assert.equal(value.needsResume,true);
  assert.equal(value.label,'待续传');assert.match(value.details,/服务器已接收 0 \/ 9 段/);assert.match(value.details,/本机待上传 7 段/);
});
test('no final totals or unknown data does not fabricate a percentage',()=>{
  assert.equal(recordingProgress(record('uploading',{expectedChunks:null}),undefined,'original').percent,null);
  assert.equal(recordingProgress(record(),task('recording'),'original').percent,null);
  assert.equal(recordingProgress(record('uploading',{expectedChunks:0}),undefined,'original').percent,null);
});
test('100 percent received is processing rather than complete until playable full file is ready',()=>{
  const value=recordingProgress(record('processing',{receivedChunks:9}),undefined,'original');
  assert.equal(value.percent,100);assert.equal(value.complete,false);assert.equal(value.label,'正在处理');assert.match(value.details,/处理完成后/);
  assert.equal(recordingComplete(record('ready')),false);
  assert.equal(recordingComplete(record('ready',{url:'/video'})),true);
  assert.doesNotMatch(recordingProgress(record('ready',{url:'/video',receivedChunks:9}),task(),'original').details,/本机待上传/,'a durable full server file must not imply another upload is required while local cleanup catches up');
});
test('recovered video remains incomplete and pending until the full recording is published',()=>{
  const partial=record('uploading',{url:'/video',recovered:true,duration:8,receivedChunks:3});
  const value=recordingProgress(partial,task(),'original');assert.equal(value.complete,false);assert.equal(value.recovered,true);assert.match(value.label,/恢复片段可播放/);
  assert.notEqual(recordingVersion(partial),recordingVersion({...partial,status:'ready',recovered:false}));
  assert.equal(recordingVersion({...partial,bytes:100}),recordingVersion({...partial,bytes:999}),'new upload bytes alone do not reload the same recovered file');
});
test('active upload overrides stale waiting state, while failed progress preserves concrete errors',()=>{
  assert.equal(recordingProgress(record('uploading',{waitingForUpload:true}),task('uploading'),'original').label,'正在上传');
  const value=recordingProgress(record('failed',{error:'处理失败'}),task('retry',{error:'身份已改变，请回到原浏览器'}),'original');
  assert.equal(value.complete,false);assert.match(value.details,/处理失败/);assert.match(value.details,/身份已改变/);
});

const pair=(original={},result={})=>[record('uploading',{kind:'original',...original}),record('uploading',{kind:'result',...result})];
test('pair percentage weights the two files equally and reaches 100 only for two durable complete files',()=>{
  assert.equal(pairSavePercent(pair()),0);
  assert.equal(pairSavePercent(pair({}, {status:'ready',url:'/result'})),50);
  assert.equal(pairSavePercent(pair({status:'ready',url:'/original'},{status:'ready',url:'/result'})),100);
  assert.equal(pairSavePercent(pair({status:'ready',url:null},{status:'ready',url:'/result'})),50,'ready status without a playable URL is not complete');
  assert.equal(pairSavePercent(pair({status:'ready',url:'/original',recovered:true,receivedChunks:9},{status:'ready',url:'/result'})),99,'a recovered file remains incomplete');
});
test('received totals are averaged then floored without optimistic rounding or elapsed-time growth',()=>{
  const value=pair({expectedChunks:6,receivedChunks:1},{expectedChunks:6,receivedChunks:1});
  assert.equal(pairSavePercent(value),16);assert.equal(pairSavePercent(value),16);
  assert.equal(pairSavePercent(pair({expectedChunks:2,receivedChunks:1},{expectedChunks:8,receivedChunks:2})),37);
  assert.equal(pairSavePercent(pair({expectedChunks:2,receivedChunks:1},{expectedChunks:2,receivedChunks:0})),25);
});
test('all uploaded, processing, queued, failed and recovered pairs stay below 100 until both full files are ready',()=>{
  for(const status of ['uploading','processing','queued','failed'])assert.equal(pairSavePercent(pair({status,receivedChunks:9},{status,receivedChunks:9})),99);
  assert.equal(pairSavePercent(pair({recovered:true,url:'/partial',receivedChunks:3},{receivedChunks:0})),16);
  assert.equal(pairSavePercent(pair({receivedChunks:999},{receivedChunks:999})),99,'oversized counts cannot overflow the bar');
});
test('unknown or invalid totals contribute zero instead of guessed progress',()=>{
  assert.equal(pairSavePercent(undefined),0);assert.equal(pairSavePercent([]),0);
  assert.equal(pairSavePercent(pair({expectedChunks:null,receivedChunks:4},{status:'ready',url:'/result'})),50);
  for(const total of [0,-1,NaN,Infinity])assert.equal(pairSavePercent(pair({expectedChunks:total,receivedChunks:5},{})),0);
  assert.equal(pairSavePercent(pair({receivedChunks:-1},{receivedChunks:NaN})),0);
});
test('final local counts are a fallback, while server confirmation and durable completion take precedence',()=>{
  const local=task('retry',{recordings:{original:{total:4,uploaded:2,remaining:2},result:{total:2,uploaded:1,remaining:1}}});
  assert.equal(pairSavePercent(undefined,local),50);
  assert.equal(pairSavePercent(pair({expectedChunks:null,receivedChunks:null},{expectedChunks:null,receivedChunks:null}),local),50);
  assert.equal(pairSavePercent(pair(),local),0,'confirmed server zero is not overridden by old local uploaded counts');
  assert.equal(pairSavePercent(undefined,{...local,state:'recording'}),0,'counts are not final while the local recorder is active');
  assert.equal(pairSavePercent(pair({status:'ready',url:'/original'},{status:'ready',url:'/result'}),{...local,state:'recording'}),100);
});
