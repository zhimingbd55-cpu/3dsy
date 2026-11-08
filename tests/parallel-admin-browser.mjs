import express from 'express';
import http from 'node:http';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const playwright=process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
  : await import('playwright');
const output=path.resolve('artifacts/parallel-admin-qa');await mkdir(output,{recursive:true});
let paused=false,ended=false,loggedIn=true;
const summary=()=>({projectId:'parallel-self-poc-v1',providerMode:'disabled',liveReady:false,paused,publicOrigin:'https://mirror.example.test',activeSessions:ended?0:1,maxConcurrent:2,totalBudgetSeconds:900,usedSeconds:32,remainingSeconds:763,dailyBudgetSeconds:900,dailyUsedSeconds:32,dailyRemainingSeconds:763,reservedSeconds:105,sessionCount:1});
const app=express();app.use(express.json());
app.use('/api',(req,res,next)=>{if(!loggedIn&&req.path.startsWith('/admin'))return res.status(401).json({message:'请登录管理后台。'});next();});
app.get('/api/admin/overview',(req,res)=>res.json({settings:{dailyUser:10,dailySite:100,concurrent:2,paused:false},storage:{used:0,reserved:0,limit:20e9,free:30e9,minFree:10e9},today:{count:0,seconds:0},active:0,waiting:0,day:'2026-10-13'}));
app.get('/api/admin/tryons',(req,res)=>res.json({items:[],total:0}));
app.get('/api/admin/parallel-self/overview',(req,res)=>res.json(summary()));
app.get('/api/admin/parallel-self/works',(req,res)=>res.json({works:[]}));
app.get('/api/admin/parallel-self/sessions',(req,res)=>res.json({sessions:[{id:'preview-session-id',status:ended?'ended':'active',providerMode:'mock',createdAt:Date.now(),readyAt:Date.now(),endedAt:ended?Date.now():null,endReason:ended?'admin_end':null,usageSeconds:32,look:{direction:'feminine',hair:'bob',beauty:'refined',garment:'cream-knit'}}]}));
app.patch('/api/admin/parallel-self/settings',(req,res)=>{paused=req.body.paused;res.json(summary());});
app.post('/api/admin/parallel-self/sessions/:id/end',(req,res)=>{ended=true;res.json({ok:true});});
app.post('/api/admin/logout',(req,res)=>{loggedIn=false;res.status(204).end();});
app.use(express.static(path.resolve('dist')));app.get('/admin',(req,res)=>res.sendFile(path.resolve('dist/index.html')));
const server=http.createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
const executablePath=process.env.QA_CHROMIUM;
const browser=await playwright.chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
try{
  await page.goto(origin+'/admin');await page.getByRole('button',{name:'平行的我',exact:true}).click();await page.getByRole('heading',{name:'平行的我',exact:true}).waitFor();
  await page.getByText('服务已连接',{exact:false}).waitFor();assert.equal(await page.locator('#metrics').isVisible(),false);
  await page.screenshot({path:path.join(output,'desktop-1280.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'mobile-390.png'),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  await page.getByRole('button',{name:'暂停新体验',exact:true}).click();await page.getByRole('button',{name:'恢复新体验',exact:true}).waitFor();assert.equal(paused,true);
  await page.getByRole('button',{name:'恢复新体验',exact:true}).click();await page.getByRole('button',{name:'暂停新体验',exact:true}).waitFor();assert.equal(paused,false);
  await page.getByRole('button',{name:'结束本场',exact:true}).click();await page.getByText('已结束',{exact:true}).waitFor();assert.equal(ended,true);
  await page.getByRole('button',{name:'退出',exact:true}).click();await page.getByRole('button',{name:'登录',exact:true}).waitFor();assert.deepEqual(errors,[]);
  const report={mode:'mock-api-browser-layout',passed:['desktop-1280','mobile-390-no-horizontal-overflow','old-metrics-hidden-for-new-project','pause-resume','end-session','logout-removes-panel','no-page-errors'],notExercised:['production-server','real-cloud-generation']};
  await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
