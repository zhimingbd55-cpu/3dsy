import { WebSocketServer, WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MODEL, HARD_LIMIT, DURATION, fail, publicError } from './config.mjs';
import { composeTryonPrompt, PROMPT_VERSION } from './tryon-prompt.mjs';
import { FLOW_VERSION, flowLimits, createTryonFlow } from './tryon-flow.mjs';
import { attachParallelProvider, PARALLEL_PROVIDER_PATH } from './parallel-provider.mjs';

export function attachRealtime(server, { store, auth, options, media, apiKeys }) {
  const parallelProvider=attachParallelProvider(server,{store,apiKeys,options});
  const wss = new WebSocketServer({ noServer:true, maxPayload:2*1024*1024 });
  const active = new Map();
  // A process restart cannot resume the provider socket or its unsequenced ACK.
  // Preserve both recordings and segment audits; the media worker can still
  // finish uploads/transcodes after this flow is irreversibly closed.
  store.transaction(()=>{
    for(const row of store.all("SELECT * FROM tryons WHERE flow_version=? AND flow_status<>'ended' AND status NOT IN ('queued','reserved')",FLOW_VERSION)){
      store.run("UPDATE tryons SET flow_status='ended',end_reason=COALESCE(end_reason,'service_restart_recovery'),ended_at=COALESCE(ended_at,?),interrupted=1,status=CASE WHEN status IN ('connecting','recording') THEN CASE WHEN first_frame_at IS NULL THEN 'failed' ELSE 'saving' END ELSE status END,reserved_bytes=CASE WHEN first_frame_at IS NULL THEN 0 ELSE reserved_bytes END WHERE id=?",store.now(),row.id);
      store.run("UPDATE tryon_segments SET status='ended',ended_at=COALESCE(ended_at,?),end_reason=COALESCE(end_reason,'service_restart_recovery'),deadline_at=NULL WHERE tryon_id=? AND ended_at IS NULL",store.now(),row.id);
    }
  });
  function finish(id, interrupted = true, endReason = 'session_ended') {
    const item = active.get(id);
    if (item) {
      if(item.finished)return;
      item.finished=true;
      item.flow?.stop(endReason);
      if(item.flow&&item.browser.readyState===WebSocket.OPEN)item.browser.send(JSON.stringify({type:'generation_ended',reason:endReason}));
      apiKeys.endUsage?.(id,endReason);
      const row=store.get('SELECT charged,first_frame_at,recording_started_at FROM tryons WHERE id=?',id);
      console.info(JSON.stringify({event:'tryon-connection-ended',id,keyId:item.keyId||null,elapsedMs:store.now()-item.began,charged:Boolean(row?.charged),firstFrame:Boolean(row?.first_frame_at),milestones:item.milestones}));
      active.delete(id);
      item.abort.abort();
      for (const timer of [item.hardTimer,item.startupTimer,item.recordTimer,item.heartbeat]) clearTimeout(timer);
      if (item.upstream) { try { item.upstream.close(1000,'Finished'); } catch {} }
      if (item.browser.readyState === WebSocket.OPEN) item.browser.close(1000,'Finished');
    }
    const session = store.get('SELECT * FROM tryons WHERE id=?',id);
    if (!session || !['queued','reserved','connecting','recording'].includes(session.status)) return;
    const recordingBegan=session.recording_started_at??session.first_frame_at;
    const completed = session.flow_version===FLOW_VERSION ? endReason==='flow_completed' : recordingBegan && store.now()-recordingBegan >= 29300;
    store.run("UPDATE tryons SET status=?,ended_at=?,interrupted=?,end_reason=COALESCE(end_reason,?) WHERE id=?",session.first_frame_at?'saving':'failed',store.now(),Number(!completed),endReason,id);
    if(session.flow_version===FLOW_VERSION){
      store.run("UPDATE tryons SET flow_status='ended' WHERE id=?",id);
      store.run("UPDATE tryon_segments SET status='ended',ended_at=COALESCE(ended_at,?),end_reason=COALESCE(end_reason,?),deadline_at=NULL WHERE tryon_id=? AND ended_at IS NULL",store.now(),endReason,id);
    }
    if (!session.first_frame_at) store.run('UPDATE tryons SET reserved_bytes=0 WHERE id=?',id);
    media.settle(id);
    store.pumpQueue();
  }
  function startRecording(id,stability) {
    const session = store.get('SELECT * FROM tryons WHERE id=?',id);
    const item = active.get(id);
    if (!item || !session || !session.charged || item.milestones.imageAccepted===undefined || item.milestones.generationStarted===undefined) throw fail(409,'参考图或云端生成尚未就绪。');
    if (session.first_frame_at) return;
    if(item.flow)item.flow.stable(stability,true);
    store.run("UPDATE tryons SET first_frame_at=?,status='recording' WHERE id=?",store.now(),id);
    item.milestones.firstFrame=store.now()-item.began;
  }
  function recordingStarted(id) {
    const item=active.get(id);
    if(!item||!store.get('SELECT first_frame_at FROM tryons WHERE id=?',id)?.first_frame_at)throw fail(409,'试穿画面尚未就绪。');
    const row=store.markRecordingStarted(id);
    item.milestones.recordingStarted=store.now()-item.began;
    if(!item.recordTimer){
      const seconds=flowLimits(row).recordingSeconds;
      store.run('UPDATE tryons SET recording_deadline_at=? WHERE id=?',row.recording_started_at+seconds*1000+350,id);
      item.recordTimer=setTimeout(()=>finish(id,false,item.flow?'recording_limit':'session_ended'),seconds*1000+350);item.recordTimer.unref();
    }
    clearTimeout(item.startupTimer);
    item.flow?.recordingStarted();
    return row;
  }
  server.on('upgrade',(req,socket,head) => {
    if(String(req.url||'').startsWith(PARALLEL_PROVIDER_PATH))return;
    const url = new URL(req.url || '/',options.origin);
    const match = /^\/api\/realtime\/([0-9a-f-]{36})\/v1\/stream$/.exec(url.pathname);
    try {
      if (!match || req.headers.origin !== options.origin || req.headers.host !== new URL(options.origin).host) throw fail(403,'Forbidden');
      const visitor = auth.visitor(req,null,false), id=match[1];
      const row = store.get('SELECT * FROM tryons WHERE id=? AND visitor_id=?',id,visitor.id);
      if (!row || row.status !== 'reserved' || !row.ready_at || store.now()-row.ready_at>45000 || store.now()-(row.admitted_at??row.created_at) > 45000) throw fail(409,'Expired');
      if (store.settings().paused) throw fail(503,'Paused');
      const garment = store.get('SELECT * FROM garments WHERE id=?',row.garment_id);
      if (!garment?.image_path) throw fail(404,'Garment unavailable');
      const changed = store.run("UPDATE tryons SET status='connecting',connection_started_at=?,hard_deadline_at=? WHERE id=? AND status='reserved' AND ready_at IS NOT NULL",store.now(),store.now()+flowLimits(row).connectionSeconds*1000,id).changes;
      if (!changed) throw fail(409,'Already used');
      const codec=['vp8','h264'].includes(url.searchParams.get('livekit_server_codec'))?url.searchParams.get('livekit_server_codec'):null;
      wss.handleUpgrade(req,socket,head,browser => { void connect(id,garment,browser,codec).catch(error => {if(!active.has(id))return;store.run('UPDATE tryons SET error=? WHERE id=?',publicError(error),id);if(browser.readyState===WebSocket.OPEN)browser.send(JSON.stringify({type:'error',error:publicError(error)}));finish(id,true);}); });
    } catch (error) { socket.write(`HTTP/1.1 ${error.status || 403} Rejected\r\nConnection: close\r\n\r\n`); socket.destroy(); }
  });
  async function connect(id,garment,browser,codec) {
    const item = { browser, upstream:null, pending:[], joined:false, lastPong:Date.now(), abort:new AbortController(),began:store.now(),milestones:{} };
    active.set(id,item);
    const mark=phase=>{if(item.milestones[phase]===undefined)item.milestones[phase]=store.now()-item.began;};
    function reject(message){
      if(active.get(id)!==item)return;
      store.run('UPDATE tryons SET error=? WHERE id=?',message,id);
      if(browser.readyState===WebSocket.OPEN)browser.send(JSON.stringify({type:'error',error:message}));
      finish(id,true);
    }
    item.retire=reason=>{
      if(active.get(id)!==item||item.finished)return;
      if(browser.readyState===WebSocket.OPEN)browser.send(JSON.stringify({type:'generation_ended',reason:'site_key_limit',seconds:store.get('SELECT generation_seconds FROM tryons WHERE id=?',id)?.generation_seconds||0}));
      finish(id,false,reason||'lifetime_limit');
    };
    const session=store.get('SELECT * FROM tryons WHERE id=?',id),limits=flowLimits(session);
    const startupTimeout=()=>{
      const row=store.get('SELECT first_frame_at,recording_started_at,error FROM tryons WHERE id=?',id);
      if(!row?.recording_started_at){
        const message=item.milestones.imageAccepted!==undefined&&item.milestones.roomReady!==undefined&&item.milestones.generationStarted===undefined?'云端未开始生成，请稍后重试。':'连接或生成超时，请重试。';
        reject(row?.error||message);return;
      }
    };
    item.startupTimer=setTimeout(startupTimeout,HARD_LIMIT*1000);item.startupTimer.unref();
    item.hardTimer=setTimeout(()=>finish(id,true,'connection_limit'),limits.connectionSeconds*1000);item.hardTimer.unref();
    item.heartbeat = setInterval(() => {
      if (Date.now()-item.lastPong > 15000) { finish(id,true); return; }
      if (browser.readyState === WebSocket.OPEN) browser.ping();
    },5000); item.heartbeat.unref();
    browser.on('pong',() => { item.lastPong=Date.now(); });
    browser.on('close',() => {if(active.get(id)===item&&!item.finished)finish(id,true);});
    browser.on('error',() => {if(active.get(id)===item&&!item.finished)finish(id,true);});
    async function sendReference(currentGarment,seq,isCurrent) {
      const prompt=composeTryonPrompt({garmentId:currentGarment.id,ownerId:currentGarment.owner_id??null,category:seq===1?(session.target||currentGarment.category):currentGarment.category,categoryKnown:currentGarment.category_known===1,details:currentGarment.details||''});
      const bytes=await readFile(store.safeFile(currentGarment.image_path));
      if(!isCurrent()||active.get(id)!==item||item.upstream?.readyState!==WebSocket.OPEN)return;
      const referenceHash=createHash('sha256').update(bytes).digest('hex');
      if(seq===1)store.run('UPDATE tryons SET prompt_version=?,reference_hash=?,prompt_snapshot=? WHERE id=?',PROMPT_VERSION,referenceHash,prompt,id);
      if(item.flow)store.run('UPDATE tryon_segments SET prompt_version=?,reference_hash=?,prompt_snapshot=?,sent_at=?,image_path=?,garment_name=?,category=? WHERE tryon_id=? AND seq=?',PROMPT_VERSION,referenceHash,prompt,store.now(),currentGarment.image_path,currentGarment.name,seq===1?(session.target||currentGarment.category):currentGarment.category,id,seq);
      item.upstream.send(JSON.stringify({type:'set_image',image_data:bytes.toString('base64'),prompt,enhance_prompt:false}));
      mark('imageSent');
    }
    if(session.flow_version===FLOW_VERSION)item.flow=createTryonFlow({store,id,sendReference,finish:(interrupted,reason)=>finish(id,interrupted,reason)});
    function firstImage() {
      if(!item.imageRequested||item.firstImageStarted||item.upstream?.readyState!==WebSocket.OPEN)return;
      item.firstImageStarted=true;
      if(item.flow){void item.flow.requestImage();return;}
      void sendReference(garment,1,()=>active.get(id)===item&&!item.finished).catch(()=>reject('服装参考图加载失败，请重新开始。'));
    }
    const handleBrowserMessage=raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'livekit_join') {
          if (item.joined) throw new Error('Duplicate join');
          item.joined = true;
          send({type:'livekit_join',passthrough:false,...(msg.client_capabilities ? {client_capabilities:{frame_timing:true}} : {})});
        } else if (msg.type === 'set_image') {
          if (item.imageRequested) throw new Error('Clothing fixed for this session');
          item.imageRequested = true;
          firstImage();
        } else throw new Error('Unsupported message');
      } catch { finish(id,true); }
    };
    browser.on('message',handleBrowserMessage);
    function send(message) {
      if (item.upstream?.readyState !== WebSocket.OPEN) { if (item.pending.length > 4) throw new Error('Queue exceeded'); item.pending.push(message); return; }
      item.upstream.send(JSON.stringify(message));
      mark(message.type==='set_image'?'imageSent':'joinSent');
    }
    const token = await apiKeys.token(MODEL,limits.connectionSeconds,options.origin,{signal:item.abort.signal,tryonId:id,onRetire:reason=>item.retire(reason)});
    if (!active.has(id) || browser.readyState !== WebSocket.OPEN) return;
    item.keyId=token.keyId;item.keySeconds=0;mark('tokenReady');
    // Provider reports correct the per-session wall clock; the key manager
    // charges the greater value once and enforces the aggregate key ceiling.
    const reportKeySeconds=seconds=>{const total=Math.max(0,Math.min(limits.generationSeconds,Number(seconds)||0));if(total>item.keySeconds)item.keySeconds=total;apiKeys.reportUsage(id,total);};
    const endpoint = new URL(options.upstreamUrl || 'wss://api3.decart.ai/v1/stream');
    endpoint.searchParams.set('api_key',token.apiKey); endpoint.searchParams.set('model',MODEL);
    if(codec)endpoint.searchParams.set('livekit_server_codec',codec);
    const upstream = new WebSocket(endpoint,{headers:{Origin:options.origin},maxPayload:2*1024*1024,handshakeTimeout:15000});
    item.upstream=upstream;
    upstream.on('open',() => { if(active.get(id)!==item)return;mark('signalReady');for (const message of item.pending.splice(0)) send(message);firstImage(); });
    upstream.on('message',raw => {
      if(active.get(id)!==item)return;
      try {
        const message=JSON.parse(raw.toString());
        const firstImageAck=!item.flow||store.get('SELECT flow_sequence FROM tryons WHERE id=?',id)?.flow_sequence===1;
        if(message.type==='livekit_room_info'){mark('roomReady');console.info(JSON.stringify({event:'video-room-ready',id}));}
        if(message.type==='set_image_ack'&&message.success===true){if(item.flow&&!item.flow.acknowledge())return;mark('imageAccepted');store.run('UPDATE tryons SET image_accepted_at=COALESCE(image_accepted_at,?) WHERE id=?',store.now(),id);}
        if (message.type==='generation_started'){mark('generationStarted');store.generation(id);apiKeys.beginUsage(id);item.flow?.generationStarted();}
        const insufficient=message.type==='generation_ended'&&message.reason==='insufficient_credits'||['error','set_image_ack'].includes(message.type)&&/insufficient[ _-]?(?:credits?|balance)|not enough credits?|credits? (?:exhausted|depleted)|out of credits?/i.test(JSON.stringify(message.error??''));
        if(insufficient){if(token.keyId)apiKeys.creditState?.(token.keyId,'insufficient');store.run("UPDATE tryons SET error='Decart 账户额度不足，请补充额度。' WHERE id=?",id);}
        // A negative acknowledgement may precede SDK event registration. End
        // it on the server, instead of waiting for the 45-second watchdog.
        if(message.type==='error'||message.type==='set_image_ack'&&message.success===false){
          const error=insufficient?'Decart 账户额度不足，请补充额度。':/session_limit|rate.?limit|concurrent|capacity/i.test(String(message.error||''))?'云端并发已满，请稍后重试。':message.type==='set_image_ack'?'服装参考图处理失败，请更换图片重试。':'云端试衣服务返回错误，请稍后重试。';
          reject(error);return;
        }
        if (message.type==='generation_tick'){mark('generationStarted');apiKeys.beginUsage(id);store.generation(id,message.seconds);item.flow?.generationStarted();reportKeySeconds(message.seconds);if(active.get(id)!==item)return;}
        if (message.type==='generation_ended' && Number(message.seconds)>0){store.generation(id,message.seconds);reportKeySeconds(message.seconds);if(active.get(id)!==item)return;}
        // Subsequent ACKs belong to the server's serialized rotation controller,
        // not to the SDK's single initial-image request state.
        if (browser.readyState===WebSocket.OPEN&&(message.type!=='set_image_ack'||firstImageAck)) browser.send(raw.toString());
        if (message.type==='generation_ended') finish(id,message.reason!=='disconnect',message.reason==='disconnect'?'provider_disconnect':'generation_ended');
      } catch { reject('云端响应无效，请稍后重试。'); }
    });
    upstream.on('close',(code) => {
      if(active.get(id)!==item)return;
      const row=store.get('SELECT first_frame_at,recording_started_at FROM tryons WHERE id=?',id);
      const recordingBegan=row?.recording_started_at??row?.first_frame_at;
      if(!item.flow&&recordingBegan&&store.now()-recordingBegan>=29300){finish(id,false);return;}
      reject(code===1013?'云端并发已满，请稍后重试。':'视频连接已断开，请重试。');
    });
    upstream.on('error',() => reject('试衣连接失败，请稍后重试。'));
  }
  const queueTimer=setInterval(()=>store.pumpQueue(),1000);queueTimer.unref();
  const flowFor=id=>{const flow=active.get(id)?.flow;if(!flow)throw fail(409,'本次试衣不支持服装轮换或已结束。');return flow;};
  return { active, finish, startRecording, recordingStarted, stable:(id,body)=>flowFor(id).stable(body),lock:(id,garmentId)=>flowFor(id).lock(garmentId),close: () => { parallelProvider.close();clearInterval(queueTimer);for (const id of [...active.keys()]) finish(id,true); wss.close(); } };
}
