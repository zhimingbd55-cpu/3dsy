export type TryonMode='auto'|'fixed';
export type RotationState={seq:number;status:'awaiting_ack'|'observing'|'holding'|'ended';garmentId:string;acknowledgedAt:number|null;deadlineAt?:number|null;holdDurationSeconds:number;holdEndsAt:number|null;locked:boolean;lockedGarmentId?:string|null};
export type FlowFields={flowVersion?:number;mode?:TryonMode;serverNow?:number;durationLimit?:number;connectionBudgetSeconds?:number;hardDeadlineAt?:number|null;recordingDeadlineAt?:number|null;autoDeadlineAt?:number|null;endReason?:string|null;rotation?:RotationState|null};
export type FlowSnapshot=FlowFields&{status:string;error?:string|null};
export type StableWindow={stabilityMode:'video-frame-callback'|'decoded-frame-counter'|'weak-playback';stableWindowMs:number;stableFrames:number|null};

/** Server demo ordering is authoritative. No browser selection cache participates. */
export function initialDemo<T extends {published?:boolean;assetType?:string;demoOrder?:number|null}>(items:T[]):T|undefined{
  const marked=items.filter(item=>typeof item.demoOrder==='number'&&Number.isFinite(item.demoOrder));
  return marked.sort((a,b)=>a.demoOrder!-b.demoOrder!)[0]||items.find(item=>item.published&&item.assetType==='2d')||items[0];
}

export function recordingLimit(record:FlowFields):number{
  return positive(record.durationLimit,record.flowVersion===1&&record.mode==='auto'?180:30);
}
export function connectionLimit(record:FlowFields):number{
  return positive(record.connectionBudgetSeconds,record.flowVersion===1?(record.mode==='auto'?225:75):45);
}
function positive(value:number|undefined,fallback:number){return typeof value==='number'&&Number.isFinite(value)&&value>0?value:fallback;}
export function deadlineRemaining(record:FlowFields,deadline:number|null|undefined,elapsedSinceReceipt=0):number|null{
  if(typeof deadline!=='number'||!Number.isFinite(deadline)||typeof record.serverNow!=='number')return null;
  return Math.max(0,deadline-record.serverNow-elapsedSinceReceipt);
}
export function isFlowTerminal(record:FlowSnapshot){return record.rotation?.status==='ended'||!['queued','reserved','connecting','recording'].includes(record.status);}
export function isNormalFlowEnd(record:FlowSnapshot){return ['flow_completed','lifetime_limit','recording_limit','auto_guard','connection_limit'].includes(record.endReason||'')&&!record.error;}

/** Serial ACK -> fresh frame window -> stable acknowledgement. Invalidating a
 * window on a user lock cannot commit frames observed for the previous intent. */
export function watchRotation<T extends FlowSnapshot>(options:{
  signal:AbortSignal;read:(signal:AbortSignal)=>Promise<T>;observe:(signal:AbortSignal)=>Promise<StableWindow>;
  commit:(seq:number,stable:StableWindow,signal:AbortSignal)=>Promise<T>;updated:(value:T)=>void;
  ended:(value:T)=>void;failed:(error:unknown)=>void;wait:(ms:number,signal:AbortSignal)=>Promise<void>;
  initialSeq:number;mayObserve?:()=>boolean;
}){
  const stopController=new AbortController(),signal=AbortSignal.any([options.signal,stopController.signal]);
  let revision=0,windowController:AbortController|null=null,committedSeq=options.initialSeq;
  const invalidate=()=>{revision++;windowController?.abort();windowController=null;};
  const done=(async()=>{
    while(!signal.aborted){
      const value=await options.read(signal);signal.throwIfAborted();options.updated(value);
      if(isFlowTerminal(value)){options.ended(value);return;}
      const rotation=value.rotation;
      if((options.mayObserve?.()??true)&&rotation?.status==='observing'&&rotation.acknowledgedAt!=null&&rotation.seq>committedSeq&&(!rotation.lockedGarmentId||rotation.garmentId===rotation.lockedGarmentId)){
        const startedRevision=revision,seq=rotation.seq;
        const budget=deadlineRemaining(value,rotation.deadlineAt)??5000;
        if(budget<=0)throw new Error('换衣画面未能在规定时间内稳定，本次片段已保留。');
        windowController=new AbortController();const windowSignal=AbortSignal.any([signal,windowController.signal,AbortSignal.timeout(Math.max(1,Math.ceil(budget)))]);
        try{
          const stable=await options.observe(windowSignal);windowSignal.throwIfAborted();
          if(startedRevision!==revision)continue;
          const accepted=await options.commit(seq,stable,windowSignal);windowSignal.throwIfAborted();
          if(startedRevision!==revision)continue;
          committedSeq=seq;options.updated(accepted);
          if(isFlowTerminal(accepted)){options.ended(accepted);return;}
        }catch(error){if(signal.aborted)throw error;if(startedRevision===revision)throw error;}
        finally{windowController=null;}
      }
      await options.wait(250,signal);
    }
  })().catch(error=>{if(!signal.aborted)options.failed(error);});
  return {invalidate,stop(){invalidate();stopController.abort();},done};
}
