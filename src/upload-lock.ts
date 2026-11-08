import {browserUuid} from './browser-uuid.ts';
// Separate coordination DB avoids upgrading existing recording databases.
const owner=browserUuid(),TTL=30000;
type Lease={name:string;owner:string;until:number};
let database:Promise<IDBDatabase>;
function db(){return database??=new Promise((resolve,reject)=>{const r=indexedDB.open('amen-upload-coordination',1);r.onupgradeneeded=()=>r.result.createObjectStore('leases',{keyPath:'name'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function edit(name:string,change:(row:Lease|undefined)=>Lease|null|undefined){
  const database=await db();return new Promise<boolean>((resolve,reject)=>{
    const tx=database.transaction('leases','readwrite'),store=tx.objectStore('leases'),r=store.get(name);let changed=false;
    r.onsuccess=()=>{const next=change(r.result);if(next===undefined)return;changed=true;if(next)store.put(next);else store.delete(name);};
    tx.oncomplete=()=>resolve(changed);tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
export type UploadLockRelease=(()=>void)&{valid:()=>Promise<boolean>};
export async function holdUploadLock(name:string):Promise<UploadLockRelease|null>{
  if(navigator.locks)return new Promise((resolve,reject)=>{
    void navigator.locks.request(`amen:${name}`,{ifAvailable:true},async lock=>{
      if(!lock){resolve(null);return;}
      let held=true;
      await new Promise<void>(done=>{
        const release=Object.assign(()=>{held=false;done();},{valid:async()=>held});
        resolve(release);
      });
    }).catch(reject);
  });
  const token=`${owner}:${browserUuid()}`;
  if(!await edit(name,row=>row&&row.until>Date.now()?undefined:{name,owner:token,until:Date.now()+TTL}))return null;
  let held=true,timer=0;
  const lose=()=>{held=false;clearInterval(timer);};
  // Validation also renews the lease atomically before a bounded operation.
  // An expired owner may renew only while its token is still present. Competing
  // acquisitions use the same transaction boundary, so only one owner wins.
  // Once replaced or unreadable, this holder must never revive itself.
  const valid=async()=>{
    if(!held)return false;
    try{
      const renewed=await edit(name,row=>held&&row?.owner===token?{...row,until:Date.now()+TTL}:undefined);
      if(!renewed)lose();
    }catch{lose();}
    return held;
  };
  timer=window.setInterval(()=>void valid(),5000);
  return Object.assign(()=>{lose();void edit(name,row=>row?.owner===token?null:undefined).catch(()=>{});},{valid});
}
let liveTimer=0,liveVersion=0;
export function markLiveSession(active:boolean){
  const name=`live:${owner}`,version=++liveVersion;clearInterval(liveTimer);
  if(!active){void edit(name,()=>null).catch(()=>{});return;}
  const heartbeat=()=>void edit(name,()=>version===liveVersion?{name,owner,until:Date.now()+TTL}:undefined).catch(()=>{});
  heartbeat();liveTimer=window.setInterval(heartbeat,5000);
}
export async function anotherLiveSession(){
  const database=await db();return new Promise<boolean>((resolve,reject)=>{
    const r=database.transaction('leases').objectStore('leases').getAll();
    r.onsuccess=()=>resolve((r.result as Lease[]).some(row=>row.name.startsWith('live:')&&row.owner!==owner&&row.until>Date.now()));r.onerror=()=>reject(r.error);
  });
}
