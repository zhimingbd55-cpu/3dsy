import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {createStore} from '../server/store.mjs';
import {validateGlb} from '../server/media.mjs';
import {composeTryonPrompt,COMMON_TRYON_RULES,REPLACE_OUTFIT_RULE} from '../server/tryon-prompt.mjs';

const project=fileURLToPath(new URL('..',import.meta.url));
const privateAssetRoot=process.env.TRYON_PRIVATE_ASSET_DIR;
const assetRoot=privateAssetRoot ? path.resolve(privateAssetRoot) : '';
const manifestPath=path.join(assetRoot,'manifest.json');
const optionalAssetTest={skip:!privateAssetRoot && 'Requires the separately licensed GLB fixture'};
const run=promisify(execFile);
const hash=data=>createHash('sha256').update(data).digest('hex');

test('maid asset is self-contained and prompt replaces the clothing without duplicating common rules',optionalAssetTest,async()=>{
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const item=manifest.find(row=>row.id==='maid-lolita');
  assert.ok(item);
  assert.equal(manifest[0].id,'maid-lolita');
  assert.equal(manifest[1].id,'fantasy-outfit-07');
  assert.equal(item.category,'outfit');
  const [model,reference]=await Promise.all(['original.glb','reference.webp'].map(name=>readFile(path.join(assetRoot,item.id,name))));
  assert.equal(hash(model),item.sha256['original.glb']);
  assert.equal(hash(reference),item.sha256['reference.webp']);
  const gltf=validateGlb(model);
  assert.ok(gltf.meshes.length);
  assert.ok(gltf.images?.length,'supplied garment textures should be embedded');
  const image=await sharp(reference).metadata();
  assert.equal(image.format,'webp');
  assert.ok(image.height>=768&&image.width>=768);
  const prompt=composeTryonPrompt({garmentId:item.id,category:'outfit',categoryKnown:true,details:item.details});
  assert.match(prompt,/maid/i);
  assert.match(prompt,/apron/i);
  assert.ok(prompt.length<=700);
  assert.equal(prompt.split(COMMON_TRYON_RULES).length-1,1);
  assert.equal(prompt.split(REPLACE_OUTFIT_RULE).length-1,1);
});

test('single-item garment import persists assets and description, is repeatable and preserves existing order',optionalAssetTest,async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-maid-import-'));
  let store=createStore(folder,{minFreeBytes:0});
  store.run("INSERT INTO garments(id,name,category,details,original_name,original_path,mime,position,created_at) VALUES ('fantasy-outfit-07','existing','outfit','existing description','model.glb','files/existing.glb','model/gltf-binary',73,1)");
  store.close();store=null;
  try{
    const args=['scripts/seed-bundled-garment.mjs',manifestPath,assetRoot,'maid-lolita','--only-item'];
    for(let i=0;i<2;i++)await run(process.execPath,args,{cwd:project,env:{...process.env,FITTING_DATA_DIR:folder},windowsHide:true});
    store=createStore(folder,{minFreeBytes:0});
    assert.equal(store.get("SELECT position FROM garments WHERE id='fantasy-outfit-07'").position,73);
    assert.equal(store.get("SELECT COUNT(*) AS n FROM garments WHERE id='maid-lolita'").n,1);
    const row=store.get("SELECT * FROM garments WHERE id='maid-lolita'");
    const item=JSON.parse(await readFile(manifestPath,'utf8')).find(row=>row.id==='maid-lolita');
    assert.equal(row.details,item.details);
    assert.equal(row.published,1);
    assert.equal(row.category_known,1);
    assert.equal(hash(await readFile(store.safeFile(row.model_path))),item.sha256['original.glb']);
    assert.equal(hash(await readFile(store.safeFile(row.image_path))),item.sha256['reference.webp']);
  }finally{store?.close();await rm(folder,{recursive:true,force:true});}
});
