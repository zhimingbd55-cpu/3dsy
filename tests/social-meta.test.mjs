import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {once} from 'node:events';
import {createApp} from '../server/app.mjs';
import {socialMetadata,renderSocialMetadata} from '../server/social-meta.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('social preview URLs use only the configured origin and validated route paths',()=>{
  const data=socialMetadata('https://tryon.example.test','/a/demo_agent');
  assert.equal(data.url,'https://tryon.example.test/a/demo_agent');
  assert.equal(data.image,'https://tryon.example.test/brand/share-thumb.png');
  assert.match(data.title,/1➕衣/);
  for(const value of ['//evil.example','https://evil.example/','/?ref=unsafe','/a/x"/><script>','/s/short'])assert.throws(()=>socialMetadata('https://tryon.example.test',value));
  assert.throws(()=>socialMetadata('javascript:evil','/'));
});
test('marked and minified templates receive exactly one set of metadata without removing modules or viewport',()=>{
  for(const marked of [false,true]){
    const old='<title>old</title><meta name="description" content="old"><meta property="og:image" content="old"><meta itemprop="image" content="old"><link rel="canonical" href="old"><link rel="image_src" href="old">';
    const html='<html><head><meta name="viewport" content="width=device-width">'+(marked?'<!-- share-metadata:start -->'+old+'<!-- share-metadata:end -->':old)+'</head><body><script type="module" src="/assets/main.js"></script></body></html>';
    const once=renderSocialMetadata(html,'https://tryon.example.test','/a/demo'),twice=renderSocialMetadata(once,'https://tryon.example.test','/a/demo');
    assert.equal(twice,once);assert.equal((once.match(/property="og:image"/g)||[]).length,1);assert.equal((once.match(/<title>/g)||[]).length,1);assert(!once.includes('content="old"'));assert(once.includes('/assets/main.js'));assert(once.includes('name="viewport"'));assert(once.includes('content="512"'));assert(!once.includes('og:video'));
  }
});
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'oneplus-preview-'));
  const context=createApp({dataDirectory:directory,root,dev:true,minFreeBytes:0,apiKey:'mock-only',origin:'http://127.0.0.1'});
  const server=http.createServer(context.app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;context.setOrigin(origin);
  t.after(async()=>{context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  return {context,origin,read:(url,headers={})=>fetch(origin+url,{headers})};
}
test('anonymous homepage and index preview reads do not create identities or leak arbitrary referral parameters',async t=>{
  const f=await fixture(t);
  const before=f.context.store.get('SELECT COUNT(*) AS n FROM visitors').n;
  for(const route of ['/', '/index.html','/?ref=%22%3E%3Cscript%3Ebad%3C/script%3E']){
    const response=await f.read(route),html=await response.text();assert.equal(response.status,200);assert(!response.headers.get('set-cookie'));assert.match(response.headers.get('cache-control'),/no-store/);assert.match(response.headers.get('content-security-policy')||'',/^$/);assert(html.includes(`property="og:url" content="${f.origin}/"`));assert(html.includes(`property="og:image" content="${f.origin}/brand/share-thumb.png"`));assert(!html.includes('<script>bad'));assert.equal(f.context.store.get('SELECT COUNT(*) AS n FROM visitors').n,before);
  }
});
test('agent metadata respects fixed first ownership, ignores inactive agents, and never writes a new binding',async t=>{
  const f=await fixture(t),store=f.context.store;
  for(const id of ['A','B'])store.run('INSERT INTO agents(id,code,name,active,created_at,updated_at) VALUES (?,?,?,1,?,?)',id,`agent-${id}`,id,store.now(),store.now());
  const before=store.get('SELECT COUNT(*) AS n FROM visitors').n;
  const guest=await f.read('/?ref=agent-B').then(r=>r.text());assert(guest.includes(`property="og:url" content="${f.origin}/a/agent-B"`));assert.equal(store.get('SELECT COUNT(*) AS n FROM visitors').n,before);
  const visitor=await f.read('/api/me'),cookie=visitor.headers.get('set-cookie').split(';')[0];const row=store.get('SELECT * FROM visitors ORDER BY created_at DESC LIMIT 1');store.run('UPDATE visitors SET agent_id=? WHERE id=?','A',row.id);
  const html=await f.read('/?ref=agent-B',{Cookie:cookie}).then(r=>r.text());assert(html.includes(`property="og:url" content="${f.origin}/a/agent-A"`));assert.equal(store.get('SELECT agent_id FROM visitors WHERE id=?',row.id).agent_id,'A');
  store.run('UPDATE agents SET active=0 WHERE id=?','A');const inactive=await f.read('/?ref=agent-B',{Cookie:cookie}).then(r=>r.text());assert(inactive.includes(`property="og:url" content="${f.origin}/"`));assert.equal(store.get('SELECT agent_id FROM visitors WHERE id=?',row.id).agent_id,'A');
});
