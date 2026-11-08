import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {scryptSync} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../server/app.mjs';

const token='bridge-test-only-'.repeat(3);
const overview={projectId:'parallel-self-poc-v1',providerMode:'disabled',liveReady:false,paused:false,activeSessions:0,maxConcurrent:2,totalBudgetSeconds:900,usedSeconds:32,remainingSeconds:868,dailyBudgetSeconds:900,dailyUsedSeconds:32,dailyRemainingSeconds:868,reservedSeconds:0,sessionCount:1};
const session={id:'12345678-abcd-1234-abcd-123456789abc',status:'active',providerMode:'decart',createdAt:1720000000000,readyAt:null,endedAt:null,endReason:null,usageSeconds:32,revision:1,acknowledgedRevision:1,look:{direction:'feminine',hair:'bob',beauty:'refined',garment:'cream-knit'}};

async function fixture(run,overrides={}) {
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-parallel-admin-'));
  const bridgeFile=path.join(folder,'bridge-token');await writeFile(bridgeFile,token);
  const requests=[];let responder=(req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.includes('/sessions?')?{sessions:[session]}:req.url.endsWith('/end')?{...session,status:'ended',endReason:'admin_end'}:overview));};
  const upstream=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push({url:req.url,method:req.method,headers:req.headers,body});responder(req,res);});});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const context=createApp({dataDirectory:path.join(folder,'old-project'),minFreeBytes:0,origin:'http://127.0.0.1',root:path.resolve('.'),dev:true,apiKey:'mock',adminUser:'admin',adminHash:'scrypt$test$'+scryptSync('test-password','test',64).toString('hex'),parallelAdminOrigin:`http://127.0.0.1:${upstream.address().port}`,parallelAdminBridgeFile:bridgeFile,parallelPublicOrigin:'https://mirror.example.test',...overrides});
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);
  let cookie='';
  const request=async(url,method='GET',body,extra={})=>{
    const response=await fetch(origin+url,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
    const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return response;
  };
  const login=()=>request('/api/admin/login','POST',{username:'admin',password:'test-password'});
  try{await run({context,request,login,requests,bridgeFile,setResponder(fn){responder=fn;}});}
  finally{context.close();server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);await rm(folder,{recursive:true,force:true});}
}

test('parallel project bridge requires the existing admin login and rejects immediately after logout',()=>fixture(async({request,login,requests})=>{
  for(const [route,method,body] of [['/overview','GET'],['/sessions','GET'],['/settings','PATCH',{paused:true}],[`/sessions/${session.id}/end`,'POST',{}]])assert.equal((await request('/api/admin/parallel-self'+route,method,body)).status,401);
  assert.equal(requests.length,0);
  assert.equal((await login()).status,200);
  const response=await request('/api/admin/parallel-self/overview');assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.publicOrigin,'https://mirror.example.test');assert.equal(data.usedSeconds,32);
  await request('/api/admin/logout','POST',{});
  assert.equal((await request('/api/admin/parallel-self/overview')).status,401);
  assert.equal(requests.length,1);
}));

test('bridge uses fixed operations, file token, and no browser cookies or origin forwarding',()=>fixture(async({request,login,requests})=>{
  await login();
  assert.equal((await request('/api/admin/parallel-self/sessions?limit=20','GET',undefined,{'X-Forwarded-For':'203.0.113.20',Forwarded:'for=203.0.113.20'})).status,200);
  assert.equal((await request('/api/admin/parallel-self/settings','PATCH',{paused:true})).status,200);
  assert.equal((await request(`/api/admin/parallel-self/sessions/${session.id}/end`,'POST',{})).status,200);
  assert.equal(requests[0].url,'/api/internal/admin/sessions?limit=20');
  for(const req of requests){assert.equal(req.headers.authorization,`Bearer ${token}`);for(const key of ['origin','cookie','forwarded','x-forwarded-for','x-forwarded-host'])assert.equal(req.headers[key],undefined);}
  assert.equal(requests[1].body,'{"paused":true}');
  const before=requests.length;
  for(const [url,method,body] of [['/sessions?url=http://example.org','GET'],['/sessions?limit=1000','GET'],['/settings','PATCH',{paused:true,apiKey:'bad'}],['/settings','PATCH',{paused:'false'}],[`/sessions/${session.id}/end`,'POST',{reason:'reset_budget'}],['/proxy','POST',{url:'https://example.org'}]])assert.ok((await request('/api/admin/parallel-self'+url,method,body)).status>=400);
  assert.equal(requests.length,before);
}));

test('bridge strips upstream secrets, paths, identities and converts upstream error bodies to safe messages',()=>fixture(async({request,login,setResponder})=>{
  await login();
  setResponder((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.includes('/sessions?')?{sessions:[{...session,ownerId:'secret-owner',apiKey:'secret-key',token:'secret-token',look:{...session.look,extra:'secret-prompt'}}]}:{...overview,apiKey:'secret-key',token:'secret-token',dataDirectory:'/srv/private',ownerIds:['secret-owner']}));});
  for(const route of ['/overview','/sessions']){const response=await request('/api/admin/parallel-self'+route);assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/secret-|\/srv\/private|ownerIds|ownerId/);}
  setResponder((req,res)=>{res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({message:`invalid ${token} /srv/private`}));});
  const denied=await request('/api/admin/parallel-self/overview');assert.equal(denied.status,503);const message=await denied.text();assert.match(message,/认证失败/);assert.doesNotMatch(message,/bridge-test|\/srv/);
  setResponder((req,res)=>{res.writeHead(302,{Location:'https://example.org'});res.end();});
  assert.equal((await request('/api/admin/parallel-self/overview')).status,503);
}));

test('bridge refuses remote targets and missing bridge credentials without exposing config',()=>fixture(async({request,login,requests})=>{
  await login();const response=await request('/api/admin/parallel-self/overview');assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/example\.org|credentials/);assert.equal(requests.length,0);
},{parallelAdminOrigin:'http://example.org:8776'}));

test('bridge credential file overrides the fallback environment token and supports rotation',()=>fixture(async({request,login,bridgeFile,requests})=>{
  await login();await request('/api/admin/parallel-self/overview');assert.equal(requests[0].headers.authorization,`Bearer ${token}`);
  await writeFile(bridgeFile,'new-bridge-token-'.repeat(3));await request('/api/admin/parallel-self/overview');assert.equal(requests[1].headers.authorization,'Bearer '+'new-bridge-token-'.repeat(3));
  await writeFile(bridgeFile,'short');const response=await request('/api/admin/parallel-self/overview');assert.equal(response.status,503);assert.equal(requests.length,2);
},{parallelAdminBridgeToken:'fallback-token-that-must-not-be-used'}));

test('bridge rejects a different project and bounds a stalled service to its three second timeout',()=>fixture(async({request,login,setResponder})=>{
  await login();setResponder((req,res)=>res.end(JSON.stringify({...overview,projectId:'other-project'})));
  assert.equal((await request('/api/admin/parallel-self/overview')).status,502);
  setResponder(()=>{});const started=performance.now();
  const response=await request('/api/admin/parallel-self/overview');assert.equal(response.status,503);
  const elapsed=performance.now()-started;assert.ok(elapsed>=2800&&elapsed<5000,`timeout ${elapsed}`);
}));

test('work management maps only private admin media URLs, streams Range, downloads and sanitizes mutation responses',()=>fixture(async({request,login,setResponder,requests})=>{
  const base=`/api/admin/parallel-self/works/${session.id}`;
  assert.equal((await request(base+'/original/video')).status,401);await login();
  const clip={state:'ready',receivedChunks:3,totalChunks:3,videoUrl:'http://127.0.0.1:8776/private',posterUrl:'/api/internal/private',durationMs:1234,complete:true,token:'secret-token'};
  const work={id:session.id,createdAt:1720000000000,expiresAt:1730000000000,status:'ready',shareActive:true,original:clip,result:clip,ownerId:'private-owner'};
  setResponder((req,res)=>{
    if(req.url.includes('/original/video')){assert.equal(req.headers.range,'bytes=0-3');res.writeHead(206,{'Content-Type':'video/mp4','Content-Length':'4','Content-Range':'bytes 0-3/8','Accept-Ranges':'bytes','X-Secret':'must-not-forward'});res.end('test');return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.method==='DELETE'?{deleted:true,token:'secret-token'}:req.method==='POST'?{revoked:true,token:'secret-token'}:req.url.includes('?')?{works:[work]}:work));
  });
  const list=await request('/api/admin/parallel-self/works?limit=20');assert.equal(list.status,200);const data=await list.json();assert.equal(data.works[0].original.videoUrl,base+'/original/video');assert.doesNotMatch(JSON.stringify(data),/127\.0\.0\.1|internal|secret-token|private-owner/);
  const media=await request(base+'/original/video?download=1','GET',undefined,{Range:'bytes=0-3'});assert.equal(media.status,206);assert.equal(media.headers.get('content-range'),'bytes 0-3/8');assert.match(media.headers.get('content-disposition'),/^attachment/);assert.equal(media.headers.get('x-secret'),null);assert.equal(await media.text(),'test');
  assert.deepEqual(await(await request(base+'/share/revoke','POST',{})).json(),{revoked:true});assert.deepEqual(await(await request(base,'DELETE',{})).json(),{deleted:true});
  assert.equal((await request(base+'/original/video','GET',undefined,{Range:'bytes=0-3,5-6'})).status,416);
  assert.equal((await request(base+'/private/video')).status,404);
  for(const item of requests)assert.equal(item.headers.cookie,undefined);
}));
