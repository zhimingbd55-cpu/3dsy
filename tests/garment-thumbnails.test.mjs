import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm,utimes} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {createGarmentThumbnails} from '../server/garment-thumbnails.mjs';
import {createApp} from '../server/app.mjs';

const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const sample=(width,height,color)=>sharp({create:{width,height,channels:3,background:color}}).webp().toBuffer();

test('thumbnails preserve aspect ratio and original bytes, reuse concurrent work, and invalidate on source replacement',async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-thumb-unit-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const filename=path.join(folder,'reference.webp'),original=await sample(1086,1448,'#739082');await writeFile(filename,original);
  const thumbnails=createGarmentThumbnails(),results=await Promise.all(Array.from({length:8},()=>thumbnails.get(filename)));
  for(const result of results)assert.equal(result,results[0]);
  const meta=await sharp(results[0].buffer).metadata();assert.equal(meta.width,240);assert.equal(meta.height,320);assert.equal(meta.format,'webp');
  assert.equal(hash(await readFile(filename)),hash(original));assert.equal((await thumbnails.get(filename)),results[0]);
  const replacement=await sample(1086,1448,'#714851');await writeFile(filename,replacement);const future=new Date(Date.now()+2000);await utimes(filename,future,future);
  const replaced=await thumbnails.get(filename);assert.notEqual(replaced,results[0]);assert.notEqual(replaced.etag,results[0].etag);assert.equal(hash(await readFile(filename)),hash(replacement));
  const small=path.join(folder,'small.webp');await writeFile(small,await sample(40,60,'#ccc'));const smallMeta=await sharp((await thumbnails.get(small)).buffer).metadata();assert.equal(smallMeta.width,40);assert.equal(smallMeta.height,60);
});

test('encoded thumbnail cache obeys the memory budget and keeps only the most recent entries',async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-thumb-lru-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const a=path.join(folder,'a.webp'),b=path.join(folder,'b.webp');await writeFile(a,await sample(800,1000,'#793'));await writeFile(b,await sample(800,1000,'#347'));
  const measured=createGarmentThumbnails(),sizeA=(await measured.get(a)).buffer.length,sizeB=(await measured.get(b)).buffer.length;
  const thumbnails=createGarmentThumbnails({maxBytes:sizeA+sizeB-1}),first=await thumbnails.get(a),second=await thumbnails.get(b);assert.equal(await thumbnails.get(b),second);assert.notEqual(await thumbnails.get(a),first);
  const disabled=createGarmentThumbnails({maxBytes:1});assert.notEqual(await disabled.get(a),await disabled.get(a));
  const entries=createGarmentThumbnails({maxEntries:1}),entryA=await entries.get(a);await entries.get(b);assert.notEqual(await entries.get(a),entryA);
});

test('thumbnail HTTP cache never bypasses ownership, unpublish or deletion; original reference URLs and bytes stay intact',async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-thumb-api-'));
  const context=createApp({dataDirectory:folder,minFreeBytes:0,apiKey:'mock-only',origin:'http://127.0.0.1'});
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));context.close();await rm(folder,{recursive:true,force:true});});
  const person=()=>{let cookie='';return async(url,options={})=>{const response=await fetch(origin+url,{...options,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...options.headers}});const next=response.headers.get('set-cookie');if(next)cookie=next.split(';')[0];return response;};};
  const owner=person(),other=person();await owner('/api/me');await other('/api/me');
  const body=new FormData();body.append('file',new Blob([await sample(1086,1448,'#456')],{type:'image/webp'}),'reference.webp');
  const uploaded=await owner('/api/garments',{method:'POST',body});assert.equal(uploaded.status,201);const item=await uploaded.json();
  assert.equal(item.thumbnailUrl,`/api/garments/${item.id}/thumbnail`);assert.equal(item.imageUrl,`/api/garments/${item.id}/image`);assert.equal(item.modelUrl,null);
  const original=Buffer.from(await (await owner(item.imageUrl)).arrayBuffer()),first=await owner(item.thumbnailUrl);assert.equal(first.status,200);assert.match(first.headers.get('cache-control'),/private.*must-revalidate/);const etag=first.headers.get('etag');assert.ok(etag);
  const meta=await sharp(Buffer.from(await first.arrayBuffer())).metadata();assert.equal(meta.width,240);assert.equal(meta.height,320);
  const conditional={headers:{'If-None-Match':etag,'Cache-Control':'max-age=0'}};assert.equal((await owner(item.thumbnailUrl,conditional)).status,304);assert.equal((await other(item.thumbnailUrl,conditional)).status,404);
  assert.equal(hash(Buffer.from(await (await owner(item.imageUrl)).arrayBuffer())),hash(original));
  assert.equal((await owner(`/api/garments/${item.id}`,{method:'DELETE'})).status,204);assert.equal((await owner(item.thumbnailUrl,conditional)).status,404);
  const relative='public-reference.webp';await writeFile(context.store.safeFile(relative),await sample(800,1000,'#967'));
  context.store.run("INSERT INTO garments(id,name,category,original_name,original_path,mime,image_path,model_path,published,created_at) VALUES ('public-shirt','Shirt','top','reference.webp',?,'image/webp',?,'shirt.glb',1,?)",relative,relative,Date.now());
  const listing=await other('/api/garments').then(r=>r.json()),publicItem=listing.find(x=>x.id==='public-shirt');assert.equal(publicItem.imageUrl,'/api/garments/public-shirt/image');assert.equal(publicItem.modelUrl,'/api/garments/public-shirt/model');
  const publicResponse=await other(publicItem.thumbnailUrl);assert.equal(publicResponse.status,200);const publicEtag=publicResponse.headers.get('etag');await publicResponse.arrayBuffer();
  context.store.run("UPDATE garments SET published=0 WHERE id='public-shirt'");assert.equal((await other(publicItem.thumbnailUrl,{headers:{'If-None-Match':publicEtag,'Cache-Control':'max-age=0'}})).status,404);
  context.store.run("UPDATE garments SET published=1 WHERE id='public-shirt'");assert.equal((await other(publicItem.thumbnailUrl,{headers:{'If-None-Match':publicEtag,'Cache-Control':'max-age=0'}})).status,304);
});
