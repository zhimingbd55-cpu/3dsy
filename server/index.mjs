import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { existsSync } from 'node:fs';
import { config,loadApiKey } from './config.mjs';
import { createApp } from './app.mjs';
import { attachRealtime } from './realtime.mjs';
import {buildAssetFallback} from './build-assets.mjs';
const dev=process.argv.includes('--dev');
const context=createApp({...config,apiKey:loadApiKey(),dev});
const {app}=context,server=http.createServer(app);
const realtime=attachRealtime(server,context); context.attach(realtime);
if (dev) {
  const {createServer}=await import('vite');
  const vite=await createServer({root:config.root,server:{middlewareMode:true},appType:'spa'}); app.use(vite.middlewares);
} else {
  const dist=path.join(config.root,'dist');
  if (!existsSync(path.join(dist,'index.html'))) throw new Error('Build the frontend first.');
  app.use(express.static(dist,{dotfiles:'deny',index:'index.html',setHeaders:(res,file)=>{res.setHeader('Cache-Control',file.includes(`${path.sep}assets${path.sep}`)?'public, max-age=31536000, immutable':'no-store');}}));
  app.use('/assets',buildAssetFallback(path.join(config.dataDirectory,'build-assets')));
  for (const route of ['/admin','/admin/','/privacy','/credits']) app.get(route,(req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(path.join(dist,'index.html'));});
  app.use((req,res)=>res.status(404).send('页面不存在'));
}
app.use(context.errors);
context.media.start();
server.listen(config.port,'127.0.0.1',()=>console.log(`阿门试衣 ready: ${config.origin}`));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;realtime.close();context.media.close();context.apiKeys.close();server.close();const deadline=Date.now()+125000;while(!context.media.idle()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,200));context.store.close();process.exit(0);}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void stop());
