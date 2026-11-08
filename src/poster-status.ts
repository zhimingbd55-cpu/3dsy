export function posterMissingMessage(kind:'original'|'result',tryonStatus:string,recording?:{status:string;waitingForUpload?:boolean},pending?:{state:string}){
  const label=kind==='original'?'原视频':'试穿成片';
  if(recording?.status==='ready')return `${label}封面暂不可用`;
  if(recording?.status==='failed')return `${label}未能完整保存`;
  if(recording?.waitingForUpload||pending?.state==='retry'||pending?.state==='paused')return `${label}待续传`;
  if(recording?.status==='processing'||recording?.status==='queued'||tryonStatus==='processing')return `${label}正在处理`;
  if(recording?.status==='uploading'||pending?.state==='uploading'||pending?.state==='queued'||tryonStatus==='saving')return `${label}正在保存`;
  return `${label}尚未完成保存`;
}
