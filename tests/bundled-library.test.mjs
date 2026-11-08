import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.mjs';
import { validateGlb } from '../server/media.mjs';

const execute=promisify(execFile),project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=project;

function makeGlb({ positionCount=3, materials=0, animations=0, imageUri }={}){
  const gltf={asset:{version:'2.0'},buffers:[{byteLength:0}],bufferViews:[{buffer:0,byteLength:0}],accessors:[{bufferView:0,componentType:5126,count:positionCount,type:'VEC3'}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],materials:Array.from({length:materials},()=>({})),animations:Array.from({length:animations},()=>({})),images:imageUri?[{uri:imageUri}]:[]};
  const json=Buffer.from(JSON.stringify(gltf).padEnd(Math.ceil(Buffer.byteLength(JSON.stringify(gltf))/4)*4,' '));
  const jsonHeader=Buffer.alloc(8);jsonHeader.writeUInt32LE(json.length,0);jsonHeader.writeUInt32LE(0x4e4f534a,4);
  const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(0,0);binHeader.writeUInt32LE(0x004e4942,4);
  const header=Buffer.alloc(12);header.write('glTF',0,'ascii');header.writeUInt32LE(2,4);header.writeUInt32LE(12+8+json.length+8,8);
  return Buffer.concat([header,jsonHeader,json,binHeader]);
}

test('public wardrobe has five image-only garments with verified credits and checksums',async()=>{
  const manifest=JSON.parse(await readFile(path.join(root,'assets/garments/manifest.json'),'utf8'));
  assert.equal(manifest.length,5);
  const images=manifest.filter(item=>item.assetType==='2d');assert.equal(images.length,5);
  for(const item of images){
    assert.equal(item.creator,'阿门试衣项目（生成素材）');assert.equal(item.source,'为阿门试衣制作');assert.ok(item.license);assert.ok(item.modifications);
    for(const [name,digest] of Object.entries(item.sha256)){const bytes=await readFile(path.join(root,'assets/garments',item.id,name));assert.equal(createHash('sha256').update(bytes).digest('hex'),digest,`${item.id}/${name}`);}
  }
  assert.equal(manifest.some(item=>/knit-berry-3d|hoodie-navy-3d|knit-sage-stripe-3d|jacket-charcoal-3d|trench-sand-3d/.test(item.id)),false);
});

test('bundled importer stores 2D garments without a model and retains a separate normalized reference',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'amen-bundled-2d-'));
  try{
    await execute(process.execPath,[path.join(project,'scripts/seed-bundled-garment.mjs'),path.join(root,'assets/garments/manifest.json'),path.join(root,'assets/garments'),'cardigan-berry-2d','--only-item'],{cwd:project,env:{...process.env,FITTING_DATA_DIR:data},windowsHide:true});
    const store=createStore(data,{minFreeBytes:0});
    try{const garment=store.get('SELECT * FROM garments WHERE id=?','cardigan-berry-2d');assert.ok(garment);assert.equal(garment.model_path,null);assert.equal(garment.mime,'image/png');assert.ok(garment.image_path);assert.ok((await readFile(store.safeFile(garment.original_path))).length>1000);assert.equal((await readFile(store.safeFile(garment.image_path))).toString('ascii',0,4),'RIFF');}
    finally{store.close();}
  }finally{await rm(data,{recursive:true,force:true});}
});

test('single-item 2D import preserves existing garments and their migration history',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'amen-bundled-preserve-'));
  let store=createStore(data,{minFreeBytes:0,migrateBuiltinDetails:false});
  try{
    for(const id of ['hanfu-ink','hanfu-guofeng'])store.run("INSERT INTO garments(id,name,category,category_known,details,original_name,original_path,mime,image_path,published,position,created_at) VALUES (?,?,'top',1,?,?,?,'image/webp',?,1,91,1)",id,id,`Admin revision for ${id}`,`${id}.webp`,`files/${id}.webp`,`files/${id}.webp`);
    store.run("INSERT INTO garment_prompt_history VALUES ('hanfu-ink',3,'previous description',1)");
    const before=store.all('SELECT * FROM garments ORDER BY id').map(row=>({...row}));
    const history=store.all('SELECT * FROM garment_prompt_history').map(row=>({...row}));
    store.close();store=null;
    await execute(process.execPath,[path.join(project,'scripts/seed-bundled-garment.mjs'),path.join(root,'assets/garments/manifest.json'),path.join(root,'assets/garments'),'cardigan-berry-2d','--only-item'],{cwd:project,env:{...process.env,FITTING_DATA_DIR:data},windowsHide:true});
    store=createStore(data,{minFreeBytes:0,migrateBuiltinDetails:false});
    assert.deepEqual(store.all("SELECT * FROM garments WHERE id<>'cardigan-berry-2d' ORDER BY id").map(row=>({...row})),before);
    assert.deepEqual(store.all('SELECT * FROM garment_prompt_history').map(row=>({...row})),history);
    assert.ok(store.get("SELECT id FROM garments WHERE id='cardigan-berry-2d'"));
    store.close();store=createStore(data,{minFreeBytes:0});
    assert.deepEqual({...store.get("SELECT * FROM garments WHERE id='hanfu-ink'")},before.find(row=>row.id==='hanfu-ink'));
    assert.deepEqual({...store.get("SELECT * FROM garment_prompt_history WHERE garment_id='hanfu-ink'")},history[0]);
  }finally{store?.close();await rm(data,{recursive:true,force:true});}
});

test('strict uploaded GLB checks size, triangle count, materials, animations and embedded resources',()=>{
  assert.doesNotThrow(()=>validateGlb(makeGlb(),{maxBytes:1024,maxTriangles:1,maxMaterials:4,maxAnimations:0}));
  assert.throws(()=>validateGlb(makeGlb({positionCount:150003}),{maxTriangles:50000}),error=>error.status===400&&/50,000/.test(error.message));
  assert.throws(()=>validateGlb(makeGlb({materials:5}),{maxMaterials:4}),error=>error.status===400&&/材质/.test(error.message));
  assert.throws(()=>validateGlb(makeGlb({animations:1}),{maxAnimations:0}),error=>error.status===400&&/动画/.test(error.message));
  assert.throws(()=>validateGlb(makeGlb({imageUri:'https://example.test/texture.png'}),{maxBytes:1024}),error=>error.status===400);
  assert.throws(()=>validateGlb(makeGlb(),{maxBytes:16}),error=>error.status===413&&/20 MB/.test(error.message));
});
