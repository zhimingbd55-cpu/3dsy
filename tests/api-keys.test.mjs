import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {scryptSync} from 'node:crypto';
import {createStore} from '../server/store.mjs';
import {createApiKeys} from '../server/api-keys.mjs';
import {createApp} from '../server/app.mjs';

const keyA='dct_'+ 'A'.repeat(30)+'TESTA1',keyB='dct_'+ 'B'.repeat(30)+'TESTB2';
async function fixture(){const folder=await mkdtemp(path.join(os.tmpdir(),'amen-keys-'));assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));return folder;}

test('encrypted imports deduplicate and survive restart without reviving deleted environment keys',async()=>{
  const folder=await fixture();let store=createStore(folder,{minFreeBytes:0});
  const used=[],options={apiKey:keyA,fetcher:async(url,args)=>{used.push(args.headers['x-api-key']);return Response.json({apiKey:'ephemeral-test'});}};
  try{
    let keys=createApiKeys(store,options),initial=keys.list();assert.equal(initial.items.length,1);assert.ok(initial.activeId);
    assert.deepEqual(keys.importKeys(`${keyA}\r\n${keyB}\n${keyB}\nwrong\n`),{added:1,duplicates:2,invalid:[{line:4,message:'密钥格式无效'}]});
    assert.ok(!JSON.stringify(keys.list()).includes(keyA));assert.ok(!JSON.stringify(keys.list()).includes(keyB));
    assert.ok(!JSON.stringify(store.all('SELECT * FROM provider_keys')).includes(keyA));
    const second=keys.list().items.find(x=>!x.active);keys.activate(second.id);
    await keys.token('lucy-vton-3.6',45,'https://example.test');assert.deepEqual(used,[keyB]);
    assert.throws(()=>keys.remove(second.id),e=>e.status===409);
    keys.remove(initial.activeId);assert.equal(keys.list().items.length,1);
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');store.close();
    assert.ok(!(await readFile(path.join(folder,'amen.sqlite'))).includes(Buffer.from(keyB)));
    assert.equal((await readFile(path.join(folder,'.secrets/api-keys.key'))).length,32);
    store=createStore(folder,{minFreeBytes:0});keys=createApiKeys(store,options);
    assert.equal(keys.list().items.length,1);assert.equal(keys.list().activeId,second.id);
    keys.update(second.id,{enabled:false});assert.equal(keys.configured(),false);
    await assert.rejects(keys.token('lucy-vton-3.6',45,'https://example.test'),e=>e.code==='KEY_MISSING');
    keys.update(second.id,{enabled:true});assert.equal(keys.configured(),false);
    keys.activate(second.id);await keys.token('lucy-vton-3.6',45,'https://example.test');assert.equal(used.length,2);
  }finally{store.close();await rm(folder,{recursive:true,force:true});}
});

test('in-flight requests retain their key and insufficient credits never retry on another account',async()=>{
  const folder=await fixture(),store=createStore(folder,{minFreeBytes:0});let release,started,mode='pending';const used=[];
  const begun=new Promise(r=>{started=r;});
  try{
    const keys=createApiKeys(store,{apiKey:keyA,fetcher:async(url,args)=>{used.push(args.headers['x-api-key']);if(mode==='pending'){started();return new Promise(r=>{release=r;});}return new Response('',{status:402});}});
    keys.importKeys(keyB);const second=keys.list().items.find(x=>!x.active);
    const pending=keys.token('lucy-vton-3.6',45,'https://example.test');await begun;
    keys.activate(second.id);release(Response.json({apiKey:'ephemeral-test'}));await pending;assert.deepEqual(used,[keyA]);
    mode='fail';await assert.rejects(keys.token('lucy-vton-3.6',45,'https://example.test'),e=>e.code==='INSUFFICIENT_CREDITS');
    assert.deepEqual(used,[keyA,keyB]);assert.equal(keys.list().activeId,second.id);assert.equal(keys.list().items.find(x=>x.active).lastCode,'INSUFFICIENT_CREDITS');
  }finally{store.close();await rm(folder,{recursive:true,force:true});}
});

test('missing or tampered encryption data fails closed',async()=>{
  const folder=await fixture(),store=createStore(folder,{minFreeBytes:0});
  try{
    const keys=createApiKeys(store,{apiKey:keyA,fetcher:async()=>{throw Error('Must not send corrupt keys');}});
    const id=keys.list().activeId,encrypted=store.get('SELECT encrypted FROM provider_keys WHERE id=?',id).encrypted;
    const bytes=Buffer.from(encrypted,'base64');bytes[20]^=1;store.run('UPDATE provider_keys SET encrypted=? WHERE id=?',bytes.toString('base64'),id);
    await assert.rejects(keys.token('lucy-vton-3.6',45,'https://example.test'));
    await rm(path.join(folder,'.secrets/api-keys.key'));
    assert.throws(()=>createApiKeys(store,{apiKey:keyA}),/encryption file missing/);
  }finally{store.close();await rm(folder,{recursive:true,force:true});}
});

test('HTTP management requires admin and same origin; metadata is masked and switching is immediate',async()=>{
  const folder=await fixture();
  const context=createApp({dataDirectory:folder,minFreeBytes:0,apiKey:'',origin:'http://127.0.0.1',adminHash:'scrypt$test$'+scryptSync('test-password','test',64).toString('hex')});
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);let cookie='';
  const request=(url,method='GET',body)=>fetch(origin+url,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try{
    for(const method of ['GET','POST','PATCH','DELETE'])assert.equal((await request('/api/admin/api-keys',method,method==='POST'?{keys:keyA}:undefined)).status,401);
    const login=await request('/api/admin/login','POST',{username:'admin',password:'test-password'});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(origin+'/api/admin/api-keys',{method:'POST',headers:{Cookie:cookie,Origin:'https://other.test','Content-Type':'application/json'},body:JSON.stringify({keys:keyA})})).status,403);
    assert.deepEqual(await request('/api/admin/api-keys','POST',{keys:`${keyA}\n${keyB}\n${keyA}\ninvalid`}).then(r=>r.json()),{added:2,duplicates:1,invalid:[{line:4,message:'密钥格式无效'}]});
    const listResponse=await request('/api/admin/api-keys');assert.equal(listResponse.headers.get('cache-control'),'no-store');
    const listText=await listResponse.text();assert.ok(!listText.includes(keyA)&&!listText.includes(keyB));const list=JSON.parse(listText);assert.equal(list.activeId,null);
    const id=list.items[0].id;context.apiKeys.creditState(id,'insufficient');context.apiKeys.recordUsage(id,123);
    assert.equal((await fetch(origin+`/api/admin/api-keys/${id}/restore-credit`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,401);
    const restored=await request(`/api/admin/api-keys/${id}/restore-credit`,'POST',{});assert.equal(restored.status,200);
    const restoredItem=(await restored.json()).items.find(item=>item.id===id);assert.equal(restoredItem.creditState,'unknown');assert.equal(restoredItem.usedSeconds,123);
    assert.equal((await request('/api/me').then(r=>r.json())).available,false);
    assert.equal((await request(`/api/admin/api-keys/${id}/activate`,'POST',{})).status,200);
    assert.equal((await request('/api/me').then(r=>r.json())).available,true);
    assert.equal((await request(`/api/admin/api-keys/${id}`,'DELETE')).status,409);
    assert.equal((await request(`/api/admin/api-keys/${id}`,'PATCH',{enabled:'false'})).status,400);
    assert.equal((await request(`/api/admin/api-keys/${id}`,'PATCH',{enabled:false})).status,200);
    assert.equal((await request('/api/me').then(r=>r.json())).available,false);
    assert.equal((await request(`/api/admin/api-keys/${id}/activate`,'POST',{})).status,409);
    assert.equal((await request(`/api/admin/api-keys/${id}`,'DELETE')).status,204);
    assert.equal((await request('/api/admin/api-keys','POST',{keys:Array(101).fill(keyA).join('\n')})).status,400);
    assert.equal((await request('/api/admin/api-keys','POST',{keys:keyA,label:keyB})).status,400);
  }finally{context.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(folder,{recursive:true,force:true});}
});
