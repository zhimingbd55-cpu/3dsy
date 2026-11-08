import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {buildAssetFallback} from '../server/build-assets.mjs';

test('cached HTML can fetch exact prior JS/CSS bytes without exposing private files or replacing current assets',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'amen-build-'));
  const archive=path.join(root,'archive'),current=path.join(root,'current');await mkdir(archive);await mkdir(current);
  await writeFile(path.join(archive,'main-UVNJ_iCD.js'),'export const version="previous";');
  await writeFile(path.join(archive,'style-abcd1234.css'),'.old{display:block}');
  await writeFile(path.join(archive,'main-current1.js'),'wrong-old-content');
  await writeFile(path.join(current,'main-current1.js'),'current-content');
  await writeFile(path.join(archive,'.env'),'private');await writeFile(path.join(archive,'secret.sqlite'),'private');
  await writeFile(path.join(root,'private-12345678.js'),'private');
  const app=express();app.use('/assets',express.static(current));app.use('/assets',buildAssetFallback(archive));app.use((req,res)=>res.status(404).send('missing'));
  const server=http.createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  let response=await fetch(origin+'/assets/main-UVNJ_iCD.js');assert.equal(response.status,200);assert.equal(await response.text(),'export const version="previous";');assert.match(response.headers.get('Cache-Control'),/immutable/);assert.match(response.headers.get('Content-Type'),/javascript/);
  response=await fetch(origin+'/assets/style-abcd1234.css',{method:'HEAD'});assert.equal(response.status,200);assert.equal(await response.text(),'');
  assert.equal(await(await fetch(origin+'/assets/main-current1.js')).text(),'current-content');
  for(const route of ['/assets/.env','/assets/secret.sqlite','/assets/../private-12345678.js','/assets/%2e%2e%2fprivate-12345678.js','/assets/nested/main-UVNJ_iCD.js','/assets/no-file-12345678.js','/assets/main-UVNJ_iCD.js.map'])assert.equal((await fetch(origin+route)).status,404,route);
  assert.equal((await fetch(origin+'/assets/main-UVNJ_iCD.js',{method:'POST'})).status,404);
});
