import {WebSocket,WebSocketServer} from 'ws';
import {readFileSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';

export const PARALLEL_PROVIDER_PATH='/api/internal/parallel-provider/';
const safeCodes=new Set(['KEY_MISSING','KEY_UNAVAILABLE','KEY_RETIRED','INSUFFICIENT_CREDITS','RATE_LIMITED','INVALID_API_KEY','ACCESS_DENIED','INVALID_PARAMETERS','NETWORK_ERROR','PROVIDER_ERROR','INVALID_RESPONSE']);
function permitted(req,options){
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||['origin','cookie','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto'].some(key=>req.headers[key]!==undefined))return false;
  try{
    const token=(options.parallelAdminBridgeFile?readFileSync(options.parallelAdminBridgeFile,'utf8'):options.parallelAdminBridgeToken||'').trim();
    if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))return false;
    const received=Buffer.from(String(req.headers.authorization||'')),expected=Buffer.from(`Bearer ${token}`);
    return received.length===expected.length&&timingSafeEqual(received,expected);
  }catch{return false;}
}

/** The root provider key and token mint remain inside the existing key owner. */
export function attachParallelProvider(server,{store,apiKeys,options}){
  store.db.exec(`CREATE TABLE IF NOT EXISTS parallel_provider_sessions(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,deadline_at INTEGER NOT NULL,ended_at INTEGER,end_reason TEXT);`);
  store.run("UPDATE parallel_provider_sessions SET ended_at=?,end_reason='service_restart_recovery' WHERE ended_at IS NULL",store.now());
  const active=new Map(),wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024});
  function finish(item,reason,code){
    if(item.finished)return;item.finished=true;clearTimeout(item.timer);clearInterval(item.heartbeat);
    item.abort.abort();apiKeys.endUsage(item.leaseId,reason);
    store.run('UPDATE parallel_provider_sessions SET ended_at=COALESCE(ended_at,?),end_reason=COALESCE(end_reason,?) WHERE id=?',store.now(),reason,item.id);
    active.delete(item.id);
    try{if(item.client.readyState===WebSocket.OPEN){item.client.send(JSON.stringify(code?{type:'error',code:safeCodes.has(code)?code:'PROVIDER_ERROR'}:{type:'generation_ended',reason}));item.client.close(1000,'Ended');}}catch{}
    try{item.upstream?.close(1000,'Ended');}catch{}
  }
  async function connect(id,client,codec){
    const now=store.now(),item={id,leaseId:`parallel:${id}`,client,abort:new AbortController(),finished:false,upstream:null,joined:false,pending:[],deadline:now+105000,lastPong:Date.now()};
    store.run('INSERT INTO parallel_provider_sessions(id,created_at,deadline_at) VALUES (?,?,?)',id,now,item.deadline);active.set(id,item);
    item.timer=setTimeout(()=>finish(item,'connection_timeout'),105000);item.timer.unref();
    item.heartbeat=setInterval(()=>{if(Date.now()-item.lastPong>15000){finish(item,'broker_connection_lost');return;}if(client.readyState===WebSocket.OPEN)client.ping();},5000);item.heartbeat.unref();
    client.on('pong',()=>item.lastPong=Date.now());client.on('close',()=>finish(item,'client_disconnected'));client.on('error',()=>finish(item,'client_connection_error'));
    client.on('message',(raw,isBinary)=>{
      if(item.finished)return;
      try{
        if(isBinary)throw new Error('binary');const message=JSON.parse(raw.toString());
        if(message.type==='livekit_join'&&!item.joined)item.joined=true;
        else if(message.type!=='set_image'||!item.joined||typeof message.prompt!=='string'||message.prompt.length>700||typeof message.image_data!=='string'||!message.image_data.length)throw new Error('signal');
        if(item.upstream?.readyState===WebSocket.OPEN)item.upstream.send(raw.toString());
        else{if(item.pending.length>=3)throw new Error('queue');item.pending.push(raw.toString());}
      }catch{finish(item,'invalid_client_signal');}
    });
    try{
      const origin=new URL(options.parallelPublicOrigin);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('origin');
      const token=await apiKeys.token('lucy-2.5',105,origin.origin,{signal:item.abort.signal,tryonId:item.leaseId,usageSource:'parallel-self',usageLimitSeconds:105,usageDeadlineAt:item.deadline,onRetire:reason=>finish(item,reason)});
      if(item.finished||active.get(id)!==item||client.readyState!==WebSocket.OPEN)return;
      item.keyId=token.keyId;
      const endpoint=new URL(options.parallelUpstreamUrl||'wss://api3.decart.ai/v1/stream');endpoint.searchParams.set('api_key',token.apiKey);endpoint.searchParams.set('model','lucy-2.5');if(codec)endpoint.searchParams.set('livekit_server_codec',codec);
      const upstream=new WebSocket(endpoint,{headers:{Origin:origin.origin},maxPayload:2*1024*1024,handshakeTimeout:15000});item.upstream=upstream;
      upstream.on('open',()=>{if(item.finished){upstream.close();return;}for(const message of item.pending.splice(0))upstream.send(message);});
      upstream.on('message',raw=>{
        if(item.finished)return;
        try{
          const message=JSON.parse(raw.toString());
          if(message.type==='generation_started'||message.type==='generation_tick')apiKeys.beginUsage(item.leaseId);
          if(['generation_tick','generation_ended'].includes(message.type)&&Number.isFinite(Number(message.seconds))&&(message.type==='generation_tick'||Number(message.seconds)>0))apiKeys.reportUsage(item.leaseId,Number(message.seconds));
          if(item.finished)return;
          const insufficient=message.reason==='insufficient_credits'||/insufficient[ _-]?(credits?|balance)|out of credits?/i.test(String(message.error||''));
          if(insufficient){apiKeys.creditState(item.keyId,'insufficient');finish(item,'insufficient_credits','INSUFFICIENT_CREDITS');return;}
          if(message.type==='error'){finish(item,'provider_error',/rate.?limit|session_limit|concurrent/i.test(String(message.error||''))?'RATE_LIMITED':'PROVIDER_ERROR');return;}
          if(['livekit_room_info','set_image_ack','generation_started','generation_tick','generation_ended','queue_position'].includes(message.type)&&client.readyState===WebSocket.OPEN){
            if(message.type==='set_image_ack')client.send(JSON.stringify({type:'set_image_ack',success:message.success===true}));else client.send(raw.toString());
          }
          if(message.type==='generation_ended')finish(item,message.reason==='disconnect'?'provider_disconnect':'provider_ended');
          else if(message.type==='set_image_ack'&&message.success!==true)finish(item,'provider_reference_failed');
        }catch{finish(item,'invalid_provider_response');}
      });
      upstream.on('error',()=>finish(item,'provider_connection_error','NETWORK_ERROR'));upstream.on('close',()=>finish(item,'provider_disconnected'));
    }catch(error){if(!item.finished)finish(item,'provider_connection_failed',error?.code||'PROVIDER_ERROR');}
  }
  const upgrade=(req,socket,head)=>{
    if(!String(req.url||'').startsWith(PARALLEL_PROVIDER_PATH))return;
    try{
      if(!permitted(req,options))throw new Error('Forbidden');
      const url=new URL(req.url,'http://127.0.0.1'),match=/^\/api\/internal\/parallel-provider\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
      if(!match||[...url.searchParams.keys()].some(key=>key!=='livekit_server_codec')||active.size>=2||store.settings().paused||store.get('SELECT 1 FROM parallel_provider_sessions WHERE id=?',match[1]))throw new Error('Unavailable');
      const codec=url.searchParams.get('livekit_server_codec');if(codec&&!['vp8','h264'].includes(codec))throw new Error('Codec');
      wss.handleUpgrade(req,socket,head,client=>void connect(match[1],client,codec).catch(()=>{try{client.close(1000,'Ended');}catch{}}));
    }catch{socket.write('HTTP/1.1 403 Rejected\r\nConnection: close\r\n\r\n');socket.destroy();}
  };
  server.on('upgrade',upgrade);
  return {active,close(){server.off('upgrade',upgrade);for(const item of [...active.values()])finish(item,'service_shutdown');wss.close();}};
}
