import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir,writeFile,readdir,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {scryptSync} from 'node:crypto';
import QRCode from 'qrcode';
import sharp from 'sharp';
import {createApp} from '../server/app.mjs';

test('referral attribution is first-touch fixed, inherited by shares, and agent QR uploads are validated',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-business-'));
  const root=path.resolve('.');
  const context=createApp({dataDirectory:folder,minFreeBytes:0,origin:'http://127.0.0.1',root,dev:true,apiKey:'mock',adminUser:'admin',adminHash:'scrypt$test$'+scryptSync('test-password','test',64).toString('hex')});
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);
  const makePerson=()=>{let cookie='';return async(url,method='GET',body,contentType='application/json',redirect='follow')=>{const response=await fetch(origin+url,{method,redirect,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':contentType}:{})},body:body===undefined?undefined:contentType==='application/json'?JSON.stringify(body):body});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return response;};};
  const admin=makePerson(),owner=makePerson(),friend=makePerson(),newVisitor=makePerson();
  try{
    assert.equal((await admin('/api/admin/agents')).status,401);
    assert.equal((await admin('/api/admin/login','POST',{username:'admin',password:'test-password'})).status,200);
    const create=async(name,wechatId)=>admin('/api/admin/agents','POST',{name,wechatId}).then(response=>{assert.equal(response.status,201);return response.json();});
    const agentA=await create('代理 A','amen_a_wechat'),agentB=await create('代理 B','amen_b_wechat');
    const qr=await QRCode.toBuffer('https://weixin.qq.com/amen-agent-a',{type:'png',margin:0,width:320});
    assert.equal((await admin(`/api/admin/agents/${agentA.id}/qr`,'PUT',Buffer.from('not an image'),'image/png')).status,400);
    assert.equal((await admin(`/api/admin/agents/${agentA.id}/qr`,'PUT',qr,'image/png')).status,200);
    const savedQr=await admin(`/api/admin/agents/${agentA.id}/qr`);assert.equal(savedQr.status,200);
    const qrMeta=await sharp(Buffer.from(await savedQr.arrayBuffer())).metadata();assert.equal(qrMeta.format,'png');assert.ok(qrMeta.width>320);
    assert.equal((await admin('/api/admin/business-contact','PUT',{name:'官方商务',wechatId:'amen_official'})).status,200);
    const aVisit=await owner(`/api/me?ref=${agentA.code}`).then(response=>response.json());assert.equal(aVisit.available,true);
    const effective=await owner(`/api/business-contact?ref=${agentB.code}`).then(response=>response.json());assert.equal(effective.name,'代理 A');assert.equal(effective.wechatId,'amen_a_wechat');assert.equal(effective.referralPath,`/a/${agentA.code}`);assert.ok(effective.qrUrl);
    const mismatch=await owner(`/a/${agentB.code}`,'GET',undefined,undefined,'manual');assert.equal(mismatch.status,302);assert.equal(mismatch.headers.get('location'),`/?ref=${agentA.code}`);
    const bEntry=await newVisitor(`/a/${agentB.code}`,'GET',undefined,undefined,'manual');assert.equal(bEntry.status,302);assert.equal(bEntry.headers.get('location'),`/?ref=${agentB.code}`);

    await writeFile(context.store.safeFile('files/ref.webp'),Buffer.from('reference'));
    context.store.run("INSERT INTO garments(id,name,original_name,original_path,mime,image_path,published,created_at) VALUES ('g','Coat','ref.webp','files/ref.webp','image/webp','files/ref.webp',1,?)",Date.now());
    const tryon=await owner('/api/tryons','POST',{garmentId:'g',acceptRecording:true}).then(response=>response.json());
    assert.equal(context.store.get('SELECT agent_id FROM tryons WHERE id=?',tryon.id).agent_id,agentA.id);
    context.store.generation(tryon.id,30);context.store.run("UPDATE tryons SET status='saving',first_frame_at=?,ended_at=? WHERE id=?",Date.now()-30000,Date.now(),tryon.id);
    const result=context.store.get("SELECT * FROM recordings WHERE tryon_id=? AND kind='result'",tryon.id);
    await mkdir(context.store.safeFile(`sessions/${tryon.id}`),{recursive:true});
    await writeFile(context.store.safeFile(`sessions/${tryon.id}/result.mp4`),Buffer.from('fake mp4'));
    await writeFile(context.store.safeFile(`sessions/${tryon.id}/result.jpg`),Buffer.from('fake jpg'));
    context.store.run("UPDATE recordings SET status='ready',duration=30,final_path=?,poster_path=? WHERE id=?",`sessions/${tryon.id}/result.mp4`,`sessions/${tryon.id}/result.jpg`,result.id);
    const shared=await owner(`/api/tryons/${tryon.id}/share`,'POST',{}).then(response=>response.json()),token=new URL(shared.url).pathname.split('/').at(-1);
    assert.equal(context.store.get('SELECT agent_id FROM video_shares WHERE tryon_id=?',tryon.id).agent_id,agentA.id);
    assert.equal((await friend(`/s/${token}`)).status,200);
    const inherited=await friend('/api/business-contact').then(response=>response.json());assert.equal(inherited.wechatId,'amen_a_wechat');
    const adminList=await admin('/api/admin/agents').then(response=>response.json());const listed=adminList.items.find(agent=>agent.id===agentA.id);assert.equal(listed.browserCount,2);assert.equal(listed.tryonCount,1);assert.equal(listed.generationSeconds,30);

    assert.equal((await admin(`/api/admin/agents/${agentA.id}`,'PATCH',{active:false})).status,200);
    const fallback=await owner('/api/business-contact').then(response=>response.json());assert.equal(fallback.source,'official');assert.equal(fallback.name,'官方商务');
    const stopped=await makePerson()(`/a/${agentA.code}`,'GET',undefined,undefined,'manual');assert.equal(stopped.status,302);assert.equal(stopped.headers.get('location'),'/');
    const oldSharePage=await friend(`/s/${token}`);assert.equal(oldSharePage.status,200);
  }finally{context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
});

async function businessFixture(run){
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-business-admin-'));
  const now=Date.now(),context=createApp({dataDirectory:folder,minFreeBytes:0,origin:'http://127.0.0.1',root:path.resolve('.'),dev:true,apiKey:'mock',now:()=>now,adminUser:'admin',adminHash:'scrypt$test$'+scryptSync('test-password','test',64).toString('hex')});
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);
  const person=()=>{let cookie='';return async(url,method='GET',body,type='application/json')=>{
    const response=await fetch(origin+url,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':type}:{})},body:body===undefined?undefined:type==='application/json'?JSON.stringify(body):body});
    const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return response;
  };};
  const admin=person();assert.equal((await admin('/api/admin/login','POST',{username:'admin',password:'test-password'})).status,200);
  try{await run({context,admin,person,now});}finally{context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});}
}

test('agent create and save responses match persisted list rows with stable links and real update timestamps',()=>businessFixture(async({context,admin,now})=>{
  for(const active of ['false',0,null,{}])assert.equal((await admin('/api/admin/agents','POST',{name:'invalid',active})).status,400);
  assert.equal(context.store.get('SELECT COUNT(*) AS n FROM agents').n,0);
  const createdResponse=await admin('/api/admin/agents','POST',{name:' First Agent ',wechatId:' original '});assert.equal(createdResponse.status,201);
  const created=await createdResponse.json();assert.equal(created.name,'First Agent');assert.equal(created.wechatId,'original');assert.equal(created.updatedAt,now);
  const second=await admin('/api/admin/agents','POST',{name:'Second Agent',wechatId:'second'}).then(response=>response.json());
  const list=()=>admin('/api/admin/agents').then(response=>response.json());
  assert.deepEqual((await list()).items.find(row=>row.id===created.id),created);
  const changedResponse=await admin(`/api/admin/agents/${created.id}`,'PATCH',{name:'Updated Agent',wechatId:'updated'});assert.equal(changedResponse.status,200);
  const changed=await changedResponse.json();assert.ok(changed.updatedAt>created.updatedAt);assert.equal(changed.createdAt,created.createdAt);assert.equal(changed.referralUrl,created.referralUrl);
  assert.deepEqual((await list()).items.find(row=>row.id===created.id),changed);
  assert.deepEqual((await list()).items.find(row=>row.id===second.id),second);
  const disabled=await admin(`/api/admin/agents/${created.id}`,'PATCH',{active:false}).then(response=>response.json());assert.equal(disabled.name,'Updated Agent');assert.equal(disabled.wechatId,'updated');assert.equal(disabled.active,false);assert.ok(disabled.updatedAt>changed.updatedAt);
  assert.deepEqual((await list()).items.find(row=>row.id===created.id),disabled);
  const official=await admin('/api/admin/business-contact','PUT',{name:'Official',wechatId:'official'}).then(response=>response.json());
  assert.ok(official.updatedAt>0);assert.deepEqual((await list()).defaultContact,official);
  const officialAgain=await admin('/api/admin/business-contact','PUT',{name:'Official edited',wechatId:'official_edited'}).then(response=>response.json());
  assert.ok(officialAgain.updatedAt>official.updatedAt);assert.deepEqual((await list()).defaultContact,officialAgain);
}));

test('active agents with missing contact fields never borrow official identity or advertise a missing QR',()=>businessFixture(async({admin,person})=>{
  await admin('/api/admin/business-contact','PUT',{name:'Official',wechatId:'official_wechat'});
  const qr=await QRCode.toBuffer('https://example.test/official',{type:'png',width:160});
  const officialUpload=await admin('/api/admin/business-contact/qr','PUT',qr,'image/png');assert.equal(officialUpload.status,200);
  const officialQr=await officialUpload.json();assert.ok(officialQr.updatedAt>0);
  const listedOfficial=(await admin('/api/admin/agents').then(response=>response.json())).defaultContact;
  assert.equal(listedOfficial.updatedAt,officialQr.updatedAt);assert.equal(listedOfficial.qrUrl,officialQr.qrUrl);
  const agent=await admin('/api/admin/agents','POST',{name:'Own Agent',wechatId:''}).then(response=>response.json());
  const visitor=person(),contact=await visitor(`/api/business-contact?ref=${agent.code}`).then(response=>response.json());
  assert.equal(contact.source,'agent');assert.equal(contact.name,'Own Agent');assert.equal(contact.wechatId,'');assert.equal(contact.qrUrl,null);
  assert.equal((await visitor('/api/business-contact/qr')).status,404);
  await admin(`/api/admin/agents/${agent.id}`,'PATCH',{wechatId:'own_wechat'});
  const withWechat=await visitor('/api/business-contact').then(response=>response.json());assert.equal(withWechat.wechatId,'own_wechat');assert.equal(withWechat.qrUrl,null);
  await admin(`/api/admin/agents/${agent.id}`,'PATCH',{active:false});
  const fallback=await visitor('/api/business-contact').then(response=>response.json());assert.equal(fallback.source,'official');assert.equal(fallback.wechatId,'official_wechat');assert.ok(fallback.qrUrl);
  assert.equal((await visitor(fallback.qrUrl)).status,200);
}));

test('concurrent QR replacement leaves only the committed PNG and returns persisted timestamps',()=>businessFixture(async({context,admin})=>{
  const agent=await admin('/api/admin/agents','POST',{name:'QR Agent',wechatId:'qr_wechat'}).then(response=>response.json());
  for(const id of [agent.id,null]){
    const route=id?`/api/admin/agents/${id}/qr`:'/api/admin/business-contact/qr';
    const folder=id?path.join('files','agents',id):path.join('files','business-contact');
    const pngs=await Promise.all(['first','second','third'].map(text=>QRCode.toBuffer(`https://example.test/${text}`,{type:'png',width:160})));
    const responses=await Promise.all(pngs.map(png=>admin(route,'PUT',png,'image/png')));responses.forEach(response=>assert.equal(response.status,200));
    const uploads=await Promise.all(responses.map(response=>response.json()));assert.equal(new Set(uploads.map(item=>item.updatedAt)).size,3);
    const listed=await admin('/api/admin/agents').then(response=>response.json()),current=id?listed.items.find(row=>row.id===id):listed.defaultContact;
    assert.equal(current.updatedAt,Math.max(...uploads.map(item=>item.updatedAt)));assert.equal(current.qrUrl,uploads.find(item=>item.updatedAt===current.updatedAt).qrUrl);
    const files=await readdir(context.store.safeFile(folder));assert.equal(files.length,1);assert.ok(files[0].endsWith('.png'));
    const downloaded=await admin(route);assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),await readFile(context.store.safeFile(path.join(folder,files[0]))));
    const validPath=id?context.store.get('SELECT qr_path FROM agents WHERE id=?',id).qr_path:context.store.settings().businessQrPath;
    assert.equal(path.basename(validPath),files[0]);
  }
}));

test('failed QR persistence removes the new image, preserves the old image, and permits a later upload',()=>businessFixture(async({context,admin})=>{
  const agent=await admin('/api/admin/agents','POST',{name:'Failure Agent'}).then(response=>response.json()),route=`/api/admin/agents/${agent.id}/qr`,folder=path.join('files','agents',agent.id);
  const qr=await QRCode.toBuffer('https://example.test/agent',{type:'png',width:160});assert.equal((await admin(route,'PUT',qr,'image/png')).status,200);
  const before=context.store.get('SELECT qr_path,updated_at FROM agents WHERE id=?',agent.id),run=context.store.run;
  context.store.run=(sql,...values)=>{if(sql.startsWith('UPDATE agents SET qr_path='))throw Object.assign(new Error('Injected write failure'),{status:503});return run(sql,...values);};
  try{assert.equal((await admin(route,'PUT',qr,'image/png')).status,503);}finally{context.store.run=run;}
  assert.deepEqual(context.store.get('SELECT qr_path,updated_at FROM agents WHERE id=?',agent.id),before);
  assert.deepEqual(await readdir(context.store.safeFile(folder)),[path.basename(before.qr_path)]);
  assert.equal((await admin(route)).status,200);
  assert.equal((await admin(route,'PUT',qr,'image/png')).status,200);
  assert.equal((await readdir(context.store.safeFile(folder))).length,1);
}));
