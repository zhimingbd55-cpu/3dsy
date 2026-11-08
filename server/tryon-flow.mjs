import { fail } from './config.mjs';

export const FLOW_VERSION = 1;
export const DEMO_GARMENT_IDS = Object.freeze(['cardigan-berry-2d','hoodie-navy-2d','sweater-sage-2d','coat-brick-2d','trench-sand-2d']);
export const ACK_TIMEOUT_MS = 10000;
export const STABILITY_TIMEOUT_MS = 5000;
export const AUTO_RECORDING_GUARD_MS = 115000;
export function flowLimits(row = {}) {
  if (Number(row.flow_version ?? row.flowVersion) !== FLOW_VERSION) return {recordingSeconds:30,connectionSeconds:45,generationSeconds:60};
  return (row.flow_mode ?? row.mode) === 'auto'
    ? {recordingSeconds:180,connectionSeconds:225,generationSeconds:225}
    : {recordingSeconds:30,connectionSeconds:75,generationSeconds:75};
}
export function flowJson(store,row) {
  const limits=flowLimits(row);
  if(Number(row.flow_version)!==FLOW_VERSION)return {flowVersion:0,mode:'fixed',durationLimit:30,connectionBudgetSeconds:45,rotation:null};
  const segment=store.get('SELECT * FROM tryon_segments WHERE tryon_id=? AND seq=?',row.id,row.flow_sequence);
  return {flowVersion:FLOW_VERSION,mode:row.flow_mode,durationLimit:limits.recordingSeconds,connectionBudgetSeconds:limits.connectionSeconds,
    rotation:segment?{seq:segment.seq,status:row.flow_status,garmentId:segment.garment_id,acknowledgedAt:segment.acknowledged_at??null,deadlineAt:segment.deadline_at??null,holdDurationSeconds:segment.hold_seconds,holdEndsAt:segment.hold_ends_at??null,locked:Boolean(row.flow_locked_at)||row.flow_mode==='fixed',lockedGarmentId:row.flow_locked_garment_id??null}:null};
}

// One reference can be in flight because the provider's ACK has no request ID.
// Never retry a timed-out command or reuse an ended controller for another scene.
export function createTryonFlow({store,id,sendReference,finish,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let closed=false,phaseTimer=null,autoTimer=null,inFlight=false,requestSerial=0;
  const row=()=>store.get('SELECT * FROM tryons WHERE id=?',id);
  const segment=()=>{const current=row();return current?store.get('SELECT * FROM tryon_segments WHERE tryon_id=? AND seq=?',id,current.flow_sequence):null;};
  const cancelPhase=()=>{if(phaseTimer!==null)clearTimer(phaseTimer);phaseTimer=null;};
  const later=(ms,fn)=>{const timer=setTimer(fn,Math.max(0,ms));timer?.unref?.();return timer;};
  const end=(reason,message)=>{
    if(closed)return;
    if(message)store.run('UPDATE tryons SET error=COALESCE(error,?) WHERE id=?',message,id);
    finish(reason==='flow_completed'?false:true,reason);
  };
  const active=()=>!closed&&['connecting','recording'].includes(row()?.status);
  function setPhase(status,deadline=null) {
    store.run('UPDATE tryons SET flow_status=? WHERE id=?',status,id);
    store.run('UPDATE tryon_segments SET status=?,deadline_at=? WHERE tryon_id=? AND seq=?',status,deadline,id,row().flow_sequence);
  }
  function observable() {
    const current=row(),part=segment();
    if(!active()||!part?.acknowledged_at||part.stable_at||part.deadline_at!==null)return;
    // Initial cloud generation can begin seconds after its image ACK. That
    // startup remains bounded by the independent 45-second connect watchdog.
    if(part.seq===1&&!current.generation_started_at)return;
    const deadline=store.now()+STABILITY_TIMEOUT_MS;
    setPhase('observing',deadline);cancelPhase();
    phaseTimer=later(STABILITY_TIMEOUT_MS,()=>end('flow_stability_timeout','试穿画面未能稳定，请重新开始。'));
  }
  async function requestImage() {
    if(!active()||inFlight)return;
    const current=row(),part=segment();
    if(!part||part.sent_at!==null||part.requested_at!==null)return;
    const serial=++requestSerial,deadline=store.now()+ACK_TIMEOUT_MS;
    inFlight=true;setPhase('awaiting_ack',deadline);
    store.run('UPDATE tryon_segments SET requested_at=? WHERE tryon_id=? AND seq=?',store.now(),id,part.seq);
    cancelPhase();phaseTimer=later(ACK_TIMEOUT_MS,()=>end('flow_ack_timeout','服装切换超时，请重新开始。'));
    try {
      const garment=store.get('SELECT * FROM garments WHERE id=?',part.garment_id);
      if(!garment?.image_path||(garment.owner_id!==current.visitor_id&&(garment.owner_id!==null||!garment.published)))throw fail(404,'服装已不可用。');
      // The caller loads and sends image+prompt as one atomic provider command.
      // It must recheck the guard after file I/O and before touching the socket.
      await sendReference(garment,part.seq,()=>active()&&requestSerial===serial&&inFlight&&row().flow_sequence===part.seq&&store.now()<deadline);
    } catch(error) {
      if(active()&&requestSerial===serial)end('flow_reference_failed',error?.status?error.message:'服装参考图加载失败，请重新开始。');
    }
  }
  function next(garmentId,isLocked=false) {
    if(!active()||inFlight)return;
    const current=row(),garment=store.get('SELECT * FROM garments WHERE id=?',garmentId);
    if(!garment?.image_path||(garment.owner_id!==current.visitor_id&&(garment.owner_id!==null||!garment.published))){end('flow_reference_failed','服装已不可用。');return;}
    cancelPhase();
    store.transaction(()=>{
      store.run("UPDATE tryon_segments SET ended_at=COALESCE(ended_at,?),end_reason=COALESCE(end_reason,'superseded'),status='ended',deadline_at=NULL WHERE tryon_id=? AND seq=?",store.now(),id,current.flow_sequence);
      const seq=current.flow_sequence+1;
      store.run('INSERT INTO tryon_segments(tryon_id,seq,garment_id,garment_name,category,image_path,hold_seconds,is_locked) VALUES (?,?,?,?,?,?,?,?)',id,seq,garment.id,garment.name,garment.category,garment.image_path,isLocked?30:10,Number(isLocked));
      store.run("UPDATE tryons SET flow_sequence=?,flow_status='awaiting_ack',garment_id=?,garment_name=?,target=? WHERE id=?",seq,garment.id,garment.name,garment.category,id);
    });
    void requestImage();
  }
  function acknowledge() {
    if(!active()||!inFlight)return false;
    const current=row(),part=segment();
    if(!part?.sent_at)return false;
    // Deadline checks make timers robust even when a busy event loop runs late.
    if(store.now()>=part.deadline_at){end('flow_ack_timeout','服装切换超时，请重新开始。');return false;}
    inFlight=false;cancelPhase();
    store.run("UPDATE tryon_segments SET acknowledged_at=?,status='observing',deadline_at=NULL WHERE tryon_id=? AND seq=?",store.now(),id,part.seq);
    store.run("UPDATE tryons SET flow_status='observing' WHERE id=?",id);
    if(current.flow_locked_at&&!part.is_locked){next(current.flow_locked_garment_id,true);return true;}
    observable();return true;
  }
  function stable(body,initial=false) {
    if(!active())throw fail(409,'本次试衣已结束。');
    validateStable(body);
    if(!Number.isInteger(body.seq))throw fail(400,'服装切换序号无效。');
    const current=row(),part=segment();
    if(body.seq!==part.seq)throw fail(409,'服装已经切换，请重新观察当前画面。');
    if(part.stable_at!==null)return;
    const from=Math.max(part.acknowledged_at||0,part.seq===1?(current.generation_started_at||0):0);
    if(!part.acknowledged_at||!current.generation_started_at||current.flow_status!=='observing'||store.now()-from<2000)throw fail(409,'请等待当前服装画面连续稳定。');
    if(!part.deadline_at||store.now()>part.deadline_at){end('flow_stability_timeout','试穿画面未能稳定，请重新开始。');throw fail(409,'稳定画面观测已超时。');}
    if(initial&&current.recording_started_at!==null)throw fail(409,'录像已经开始。');
    if(!initial&&current.recording_started_at===null)throw fail(409,'请先开始录像。');
    cancelPhase();
    store.run('UPDATE tryon_segments SET stable_at=?,stable_window_ms=?,stable_frames=?,stability_mode=?,deadline_at=NULL WHERE tryon_id=? AND seq=?',store.now(),body.stableWindowMs,body.stableFrames,body.stabilityMode,id,part.seq);
    if(!initial)hold();
  }
  function hold() {
    const current=row(),part=segment();
    if(!active()||!current.recording_started_at||!part?.stable_at)throw fail(409,'当前试穿画面尚未稳定。');
    if(part.hold_ends_at!==null)return;
    const ends=store.now()+part.hold_seconds*1000;
    setPhase('holding');
    store.run('UPDATE tryon_segments SET hold_ends_at=? WHERE tryon_id=? AND seq=?',ends,id,part.seq);
    if(current.flow_mode==='fixed'||part.is_locked||part.seq===DEMO_GARMENT_IDS.length)store.run('UPDATE tryons SET expected_recording_seconds=? WHERE id=?',(ends-current.recording_started_at)/1000,id);
    cancelPhase();phaseTimer=later(part.hold_seconds*1000,()=>{
      if(!active())return;
      store.run("UPDATE tryon_segments SET status='ended',ended_at=?,end_reason='hold_complete' WHERE tryon_id=? AND seq=?",store.now(),id,part.seq);
      const latest=row();
      if(latest.flow_mode==='fixed'||part.is_locked||latest.flow_locked_at||part.seq>=DEMO_GARMENT_IDS.length){end('flow_completed');return;}
      next(DEMO_GARMENT_IDS[part.seq]);
    });
  }
  function recordingStarted() {
    const current=row();
    if(!current.recording_started_at)throw fail(409,'录像尚未开始。');
    if(current.flow_mode==='auto'&&current.auto_deadline_at===null){
      const deadline=current.recording_started_at+AUTO_RECORDING_GUARD_MS;
      store.run('UPDATE tryons SET auto_deadline_at=? WHERE id=?',deadline,id);
      autoTimer=later(deadline-store.now(),()=>{if(!row()?.flow_locked_at)end('auto_guard','自动试衣已达到本场时限。');});
    }
    hold();
  }
  function lock(garmentId) {
    if(!active())throw fail(409,'本次试衣已结束。');
    const current=row();
    if(current.flow_mode!=='auto'||current.status!=='recording'||current.recording_started_at===null)throw fail(409,'当前状态无法锁定服装。');
    if(current.flow_locked_at){if(current.flow_locked_garment_id!==garmentId)throw fail(409,'本场已固定服装，请下一场再更换。');return;}
    if(current.auto_deadline_at!==null&&store.now()>=current.auto_deadline_at)throw fail(409,'本场自动试衣即将结束，请下一场再更换。');
    const part=segment(),pendingBudget=inFlight?Math.max(0,(part?.deadline_at??store.now())-store.now()):0;
    const remaining=Math.min(current.recording_deadline_at??Infinity,current.hard_deadline_at??Infinity)-store.now();
    if(remaining<pendingBudget+ACK_TIMEOUT_MS+STABILITY_TIMEOUT_MS+30000)throw fail(409,'本场剩余时间不足，请下一场再更换。');
    const garment=store.get('SELECT * FROM garments WHERE id=?',garmentId);
    if(!garment?.image_path||(garment.owner_id!==current.visitor_id&&(garment.owner_id!==null||!garment.published)))throw fail(404,'请选择一件可试穿的衣服。');
    store.run('UPDATE tryons SET flow_locked_at=?,flow_locked_garment_id=? WHERE id=? AND flow_locked_at IS NULL',store.now(),garmentId,id);
    if(autoTimer!==null)clearTimer(autoTimer);autoTimer=null;
    if(!inFlight)next(garmentId,true);
  }
  function stop(reason='session_ended') {
    if(closed)return;
    closed=true;requestSerial++;cancelPhase();if(autoTimer!==null)clearTimer(autoTimer);autoTimer=null;
    store.run("UPDATE tryons SET flow_status='ended' WHERE id=?",id);
    store.run("UPDATE tryon_segments SET status='ended',ended_at=COALESCE(ended_at,?),end_reason=COALESCE(end_reason,?),deadline_at=NULL WHERE tryon_id=? AND ended_at IS NULL",store.now(),reason,id);
  }
  return {requestImage,acknowledge,generationStarted:observable,stable,recordingStarted,lock,stop};
}
export function validateStable(body) {
  const {stableWindowMs,stableFrames,stabilityMode}=body||{};
  if(!['video-frame-callback','decoded-frame-counter','weak-playback'].includes(stabilityMode)||!Number.isInteger(stableWindowMs)||stableWindowMs<2000||stableWindowMs>30000||(stabilityMode!=='weak-playback'&&(!Number.isInteger(stableFrames)||stableFrames<3||stableFrames>10000))||(stabilityMode==='weak-playback'&&stableFrames!==null))throw fail(400,'稳定画面观测数据无效。');
}
