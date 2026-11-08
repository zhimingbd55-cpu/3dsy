import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.mjs';
import { BUILTIN_GARMENT_DETAILS, BUILTIN_DETAILS_MIGRATION_VERSION, PROMPT_VERSION } from '../server/tryon-prompt.mjs';

test('built-in prompt migration snapshots old descriptions once and preserves later admin edits', async () => {
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-prompt-migration-'));
  const now=Date.now();
  let store=createStore(folder,{minFreeBytes:0,now:()=>now});
  for(const id of Object.keys(BUILTIN_GARMENT_DETAILS))store.run("INSERT INTO garments(id,owner_id,name,category,details,original_name,original_path,mime,image_path,published,created_at) VALUES (?,NULL,?,'outfit',?,?,?,'image/webp',?,1,?)",id,id,`old ${id}`,`${id}.webp`,`files/${id}.webp`,`files/${id}.webp`,now);
  store.close();
  try {
    store=createStore(folder,{minFreeBytes:0,now:()=>now});
    for(const [id,details] of Object.entries(BUILTIN_GARMENT_DETAILS)){
      const row=store.get('SELECT details,category,category_known FROM garments WHERE id=?',id);
      assert.equal(row.details,details,id);
      assert.equal(row.category,'outfit',id);
      assert.equal(row.category_known,1,id);
      assert.equal(store.get('SELECT previous_details FROM garment_prompt_history WHERE garment_id=? AND prompt_version=?',id,BUILTIN_DETAILS_MIGRATION_VERSION).previous_details,`old ${id}`,id);
    }
    assert.equal(store.get('SELECT COUNT(*) AS n FROM garment_prompt_history WHERE prompt_version=?',BUILTIN_DETAILS_MIGRATION_VERSION).n,15);
    assert.ok(store.all('PRAGMA table_info(tryons)').some(column=>column.name==='prompt_snapshot'));
    store.run("UPDATE garments SET details='later admin revision',category='top',category_known=0 WHERE id='hanfu-ink'");
    store.close();
    store=createStore(folder,{minFreeBytes:0,now:()=>now});
    assert.deepEqual({...store.get("SELECT details,category,category_known FROM garments WHERE id='hanfu-ink'")},{details:'later admin revision',category:'top',category_known:0});
    assert.equal(store.get('SELECT COUNT(*) AS n FROM garment_prompt_history WHERE garment_id=? AND prompt_version=?','hanfu-ink',BUILTIN_DETAILS_MIGRATION_VERSION).n,1);
  } finally {
    store?.close();
    await rm(folder,{recursive:true,force:true});
  }
});

test('version 5 runtime preserves version 3 migrated catalog descriptions and categories',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'amen-prompt-v3-upgrade-'));
  let store=createStore(folder,{minFreeBytes:0,migrateBuiltinDetails:false});
  try{
    assert.equal(BUILTIN_DETAILS_MIGRATION_VERSION,3);
    assert.equal(PROMPT_VERSION,5);
    store.run("INSERT INTO garments(id,name,category,category_known,details,original_name,original_path,mime,image_path,published,created_at) VALUES ('hanfu-ink','Edited garment','top',1,'Administrator description','ink.webp','files/ink.webp','image/webp','files/ink.webp',1,1)");
    store.run("INSERT INTO garment_prompt_history VALUES ('hanfu-ink',3,'previous description',1)");
    const before={...store.get("SELECT * FROM garments WHERE id='hanfu-ink'")};
    const history=store.all('SELECT * FROM garment_prompt_history').map(row=>({...row}));
    store.close();
    store=createStore(folder,{minFreeBytes:0});
    assert.deepEqual({...store.get("SELECT * FROM garments WHERE id='hanfu-ink'")},before);
    assert.deepEqual(store.all('SELECT * FROM garment_prompt_history').map(row=>({...row})),history);
  }finally{store?.close();await rm(folder,{recursive:true,force:true});}
});
