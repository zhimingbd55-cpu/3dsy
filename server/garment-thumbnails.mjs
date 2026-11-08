import path from 'node:path';
import {stat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';

// The caller must check garment visibility on every request, including cache hits.
export function createGarmentThumbnails({maxBytes=8*1024*1024,maxEntries=256}={}) {
  const cache=new Map(),pending=new Map();let bytes=0;
  async function get(filename) {
    const source=path.resolve(filename),info=await stat(source,{bigint:true});
    const key=JSON.stringify([source,String(info.size),String(info.mtimeNs),String(info.ctimeNs)]);
    const cached=cache.get(key);
    if(cached){cache.delete(key);cache.set(key,cached);return cached;}
    if(pending.has(key))return pending.get(key);
    const task=(async()=>{
      // Buffer input avoids libvips retaining a file handle after generation (notably on Windows).
      const original=await readFile(source);
      const buffer=await sharp(original,{limitInputPixels:16000000,animated:false,failOn:'error'})
        .rotate().resize({width:256,height:320,fit:'inside',withoutEnlargement:true}).webp({quality:78}).toBuffer();
      const result={buffer,etag:'"'+createHash('sha256').update(buffer).digest('hex')+'"'};
      if(buffer.length<=maxBytes&&maxEntries>0){
        // Retire an old version of this file immediately instead of retaining duplicates.
        for(const [oldKey,item] of cache)if(item.source===source){cache.delete(oldKey);bytes-=item.result.buffer.length;}
        while(cache.size&&(bytes+buffer.length>maxBytes||cache.size>=maxEntries)){
          const oldest=cache.keys().next().value;bytes-=cache.get(oldest).result.buffer.length;cache.delete(oldest);
        }
        cache.set(key,{source,result});bytes+=buffer.length;
      }
      return {source,result};
    })();
    pending.set(key,task);
    try{return await task;}finally{pending.delete(key);}
  }
  return {get:async filename=>(await get(filename)).result};
}
