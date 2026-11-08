import test from 'node:test';
import assert from 'node:assert/strict';

// Deterministic lease fault injection; real IndexedDB/cross-tab mutual exclusion
// is separately covered by scripts/qa-upload-durability.mjs.
async function fixture(t,{webLocks=false}={}){
  let now=1000,nextTimer=0,fail=false,lockDone=false;
  const rows=new Map(),timers=new Map(),restore=[];
  const database={transaction(){
    if(fail)throw new Error('IndexedDB unavailable');
    const tx={};
    tx.objectStore=()=>({
      get(name){const request={};queueMicrotask(()=>{request.result=structuredClone(rows.get(name));request.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());});return request;},
      put(value){rows.set(value.name,structuredClone(value));},delete(name){rows.delete(name);},
    });return tx;
  }};
  const replacements={
    indexedDB:{open(){const request={};queueMicrotask(()=>{request.result=database;request.onsuccess?.();});return request;}},
    navigator:{locks:webLocks?{request:async(_name,_options,run)=>{await run({name:'mock lock'});lockDone=true;}}:undefined},
    window:{setInterval:fn=>{const id=++nextTimer;timers.set(id,fn);return id;}},
    clearInterval:id=>timers.delete(id),
  };
  for(const [name,value]of Object.entries(replacements)){
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
    restore.push(()=>descriptor?Object.defineProperty(globalThis,name,descriptor):delete globalThis[name]);
  }
  t.mock.method(Date,'now',()=>now);
  t.after(()=>{for(const reset of restore)reset();});
  const mod=await import(`../src/upload-lock.ts?test=${crypto.randomUUID()}`);
  const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
  return {...mod,rows,timers,flush,advance:ms=>{now+=ms;},fail:value=>{fail=value;},lockDone:()=>lockDone};
}

test('fallback validates and atomically renews its own expired token when no competing owner acquired it',async t=>{
  const f=await fixture(t),release=await f.holdUploadLock('uploader');
  assert.equal(typeof release.valid,'function');assert.equal(await release.valid(),true);
  f.advance(31000);assert.equal(await release.valid(),true);
  assert.equal(f.rows.get('uploader').until,62000);
  assert.equal(await f.holdUploadLock('uploader'),null);
  release();await f.flush();assert.equal(await release.valid(),false);assert.equal(f.rows.has('uploader'),false);
});

test('fallback old holder stays fenced after expiry and competing acquisition; release never removes new owner',async t=>{
  const f=await fixture(t),old=await f.holdUploadLock('uploader');f.advance(31000);
  const next=await f.holdUploadLock('uploader');assert(next);
  const token=f.rows.get('uploader').owner;
  assert.equal(await old.valid(),false);old();await f.flush();
  assert.equal(f.rows.get('uploader').owner,token);assert.equal(await next.valid(),true);
  next();await f.flush();assert.equal(await old.valid(),false,'a lost holder cannot revive after the next owner releases');
});

test('heartbeat detects a replaced lease and stops silently renewing it',async t=>{
  const f=await fixture(t),release=await f.holdUploadLock('record:example');
  f.rows.set('record:example',{name:'record:example',owner:'new-tab',until:60000});
  for(const heartbeat of [...f.timers.values()])heartbeat();await f.flush();
  assert.equal(f.timers.size,0);assert.equal(await release.valid(),false);
  assert.equal(f.rows.get('record:example').owner,'new-tab');
});

test('an IndexedDB renewal error permanently fences that holder even after storage recovers',async t=>{
  const f=await fixture(t),release=await f.holdUploadLock('uploader');f.fail(true);
  assert.equal(await release.valid(),false);assert.equal(f.timers.size,0);
  f.fail(false);assert.equal(await release.valid(),false);release();await f.flush();
});

test('Web Locks holder reports validity only until release and releases once',async t=>{
  const f=await fixture(t,{webLocks:true}),release=await f.holdUploadLock('uploader');
  assert.equal(await release.valid(),true);assert.equal(f.lockDone(),false);
  release();release();await f.flush();assert.equal(await release.valid(),false);assert.equal(f.lockDone(),true);
});
