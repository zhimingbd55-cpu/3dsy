import path from 'node:path';
import {lstat} from 'node:fs/promises';

// Only reviewed, fingerprinted build files are archived here. Never use the
// general data directory as an express.static root: it contains private media.
export function buildAssetFallback(directory){
  const root=path.resolve(directory);
  return async function(req,res,next){
    if(!['GET','HEAD'].includes(req.method)||!/^\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(req.path))return next();
    const file=path.join(root,req.path.slice(1));
    try{
      const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())return next();
      res.sendFile(file,{dotfiles:'deny',maxAge:31536000000,immutable:true},error=>{
        if(error){if(error.status===404||error.code==='ENOENT')next();else next(error);}
      });
    }catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return next();next(error);}
  };
}
