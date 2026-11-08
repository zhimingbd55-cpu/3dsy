import {waitBriefly} from './live-wait.ts';

// Some SDK errors arrive before connect() returns its event emitter. The
// authenticated session is authoritative even when the callback is missed.
export async function watchConnection(
  read:()=>Promise<{status:string;error?:string|null}>,
  active:()=>boolean,
  failed:(message:string)=>void,
  signal:AbortSignal,
  interval=2000,
){
  while(active()&&!signal.aborted){
    try{await waitBriefly(interval,signal);}catch{return;}
    if(!active()||signal.aborted)return;
    let saved;
    try{saved=await read();}catch{continue;}
    if(!active()||signal.aborted)return;
    if(saved.status==='failed'){
      failed(saved.error||'试衣连接已结束，请重试。');
      return;
    }
  }
}
