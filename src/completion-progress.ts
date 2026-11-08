import type {Recording} from './api';

export type LocalRecordingProgress={total:number;uploaded:number;remaining:number};
export type LocalSaveProgress={state:string;error?:string;recordings?:Partial<Record<'original'|'result',LocalRecordingProgress>>};
const count=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>=0?value:null;
export function recordingComplete(record:Recording|undefined){return Boolean(record?.status==='ready'&&!record.recovered&&record.url);}
export function recordingProgress(record:Recording|undefined,task:LocalSaveProgress|undefined,kind:'original'|'result'){
  const local=task?.recordings?.[kind],finalLocal=task?.state!=='recording';
  const serverTotal=count(record?.expectedChunks),serverReceived=count(record?.receivedChunks);
  const localTotal=finalLocal?count(local?.total):null,remaining=count(local?.remaining);
  const total=serverTotal??localTotal,uploaded=serverReceived??(finalLocal?count(local?.uploaded):null);
  const complete=recordingComplete(record),recovered=Boolean(record?.recovered&&record.url);
  const needsResume=!complete&&(record?.waitingForUpload||['retry','paused'].includes(task?.state||''))&&!(task?.state==='uploading'&&(remaining??0)>0);
  let label=complete?'完整保存':task?.state==='recording'?'正在整理录制片段':record?.status==='processing'?'正在处理':record?.status==='queued'?'等待处理':record?.status==='failed'?'保存未完成':needsResume?'待续传':!record?'等待上传':'正在上传';
  if(recovered)label=`恢复片段可播放 · ${label}`;
  const details:string[]=[];
  if(serverReceived!==null)details.push(serverTotal===null?`服务器已接收 ${serverReceived} 段`:`服务器已接收 ${serverReceived} / ${serverTotal} 段`);
  if(!complete&&local&&remaining!==null)details.push(finalLocal?`本机待上传 ${remaining} 段`:'本机正在保存录制片段');
  if(!complete&&['queued','processing'].includes(record?.status||''))details.push('上传完成，处理完成后才能确认完整保存');
  if(recovered)details.push('当前仅为恢复片段，仍需继续保存完整版');
  if(!complete&&record?.error)details.push(record.error);
  if(!complete&&task?.error)details.push(task.error);
  const percent=complete?100:finalLocal&&total!==null&&total>0&&uploaded!==null?Math.round(Math.min(total,uploaded)/total*100):null;
  return {label,details:details.join('；'),complete,recovered,needsResume:Boolean(needsResume),remaining,total,percent};
}

/** Stable cache marker: full data can replace a recovered file at the same route. */
export function recordingVersion(record:Recording|undefined){
  return record?.url?`${record.recovered?'partial':'complete'}-${record.duration??'unknown'}`:undefined;
}

/** Each recording contributes half; only two durable full files reach 100%. */
export function pairSavePercent(recordings:readonly Recording[]|undefined,task?:LocalSaveProgress):number{
  const values=(['original','result'] as const).map(kind=>{
    const record=recordings?.find(record=>record.kind===kind);
    const progress=recordingProgress(record,task,kind);
    if(progress.complete)return 100;
    const uploaded=count(record?.receivedChunks)??(task?.state!=='recording'?count(task?.recordings?.[kind]?.uploaded):null);
    // Unknown/finalizing totals have no confirmed ratio. Preserve the confirmed
    // lower bound; processing/recovery must never masquerade as fully saved.
    if(progress.percent===null||progress.total===null||progress.total<=0||uploaded===null)return 0;
    return Math.min(99,uploaded/progress.total*100);
  });
  // Floor only after averaging the original ratios, not rounded row percentages.
  return Math.floor((values[0]+values[1])/2);
}
