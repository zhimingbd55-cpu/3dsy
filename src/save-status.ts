import type {Recording,Tryon} from './api';

export function recordingSaveStatus(record:Recording){
  if(record.status==='ready')return '已保存';
  if(record.recovered)return '已恢复片段 · 上传未完整';
  if(record.status==='queued')return '等待转码';
  if(record.status==='processing')return '正在转码';
  if(record.status==='failed')return record.error||'处理失败';
  const count=record.expectedChunks===null?`已收到 ${record.receivedChunks} 段`:`${record.receivedChunks} / ${record.expectedChunks} 段`;
  return `${record.waitingForUpload?'等待手机续传':'上传中'} · ${count}`;
}
export function savedSummary(item:Tryon){
  const result=item.recordings.find(r=>r.kind==='result'),original=item.recordings.find(r=>r.kind==='original');
  if(result?.recovered)return '试穿片段已恢复 · 上传未完整';
  if(result?.status==='ready'){
    if(original?.status==='ready')return item.interrupted?'已保存中断片段':'已保存';
    return `成片已保存 · 原片${original?.recovered?'已恢复片段':original?.status==='uploading'?(original.waitingForUpload?'待续传':'上传中'):original?.status==='queued'?'等待转码':original?.status==='processing'?'转码中':'未完整保存'}`;
  }
  if(original?.recovered)return '原片片段已恢复 · 试穿视频未完整保存';
  if(item.recordings.some(r=>r.status==='processing'))return '正在转码';
  if(item.recordings.some(r=>r.status==='queued'))return '等待转码';
  if(item.recordings.some(r=>r.waitingForUpload))return '等待手机续传';
  if(item.status==='saving')return '上传中';
  return null;
}
