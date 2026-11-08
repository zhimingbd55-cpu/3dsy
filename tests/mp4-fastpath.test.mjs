import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createStore} from '../server/store.mjs';
import {createMedia} from '../server/media.mjs';
import {config} from '../server/config.mjs';
const execute=promisify(execFile);
test('compatible H.264 MP4 is remuxed without changing video packets and loses audio',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-mp4-')),store=createStore(folder,{minFreeBytes:0}),media=createMedia(store,config);
  try{
    const now=Date.now();store.run('INSERT INTO visitors(id,token_hash,created_at,consent_at) VALUES (?,?,?,?)','a','a',now,now);
    const session=store.reserve(store.get('SELECT * FROM visitors WHERE id=?','a'),{id:'shirt',name:'shirt'});
    store.generation(session.id,2);store.run("UPDATE tryons SET status='saving',first_frame_at=?,ended_at=? WHERE id=?",now-2000,now,session.id);
    const input=path.join(folder,'input.mp4');
    await execute(config.ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=160x240:rate=24','-f','lavfi','-i','sine=frequency=440','-t','2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',input],{windowsHide:true});
    const bytes=await readFile(input),rec=store.get("SELECT * FROM recordings WHERE tryon_id=? AND kind='result'",session.id);
    await media.uploadChunk(rec,0,bytes,'video/mp4');await media.complete(rec,1);
    for(let i=0;i<400&&!media.idle();i++)await new Promise(resolve=>setTimeout(resolve,25));
    const saved=store.get('SELECT * FROM recordings WHERE id=?',rec.id);assert.equal(saved.status,'ready');
    const output=store.safeFile(saved.final_path),info=await media.probe(output);assert.equal(info.streams.length,1);assert.equal(info.streams[0].codec_name,'h264');
    const packetHash=async file=>(await execute(config.ffmpeg,['-v','error','-i',file,'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','-'],{windowsHide:true})).stdout.trim();
    assert.equal(await packetHash(output),await packetHash(input),'stream copy must preserve compressed video packets');
    // The next paid session can be reserved while the prior original is pending.
    assert.ok(store.reserve(store.get('SELECT * FROM visitors WHERE id=?','a'),{id:'shirt',name:'shirt'}).id);
  }finally{media.close();store.close();await rm(folder,{recursive:true,force:true});}
});
