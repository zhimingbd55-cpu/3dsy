import {syntheticStream} from './qa-camera';
export const noopLogger={};export const models={realtime:(id:string)=>({id})};
export function createDecartClient(config?:{realtimeBaseUrl?:string}){return {realtime:{connect:async(_camera:MediaStream,options:any)=>{
  const id=config?.realtimeBaseUrl?.split('/').pop();
  const connected=await fetch(`/qa/provider/${id}/connected`,{method:'POST'});if(!connected.ok)throw new Error('Synthetic connection rejected');
  if(new URLSearchParams(location.search).get('qaFailure')==='silent'){
    const id=config?.realtimeBaseUrl?.split('/').pop();
    options.onConnectionChange?.('connected');
    const timer=setTimeout(()=>void fetch(`/qa/silent-failure/${id}`,{method:'POST'}),1200);
    return {disconnect(){clearTimeout(timer);},on(){return this;}};
  }
  if(new URLSearchParams(location.search).get('qaFailure')==='credits'){
    const id=config?.realtimeBaseUrl?.split('/').pop();
    await fetch(`/qa/credit-failure/${id}`,{method:'POST'});
    options.onConnectionChange?.('disconnected');
    throw new Error('Connection closed before the error event');
  }
  const stream=syntheticStream('试穿视频 · 模拟流','#b993a0');options.onConnectionChange?.('connected');
  const imageTimer=setTimeout(()=>void fetch(`/qa/provider/${id}/image`,{method:'POST'}),100);
  const generationTimer=setTimeout(()=>void fetch(`/qa/provider/${id}/generation`,{method:'POST'}),200);
  const timer=setTimeout(()=>options.onRemoteStream(stream),Number(new URLSearchParams(location.search).get('qaDelay'))||400);return {disconnect(){clearTimeout(timer);clearTimeout(imageTimer);clearTimeout(generationTimer);stream.getTracks().forEach(x=>x.stop());},on(){return this;}};
}}};}
