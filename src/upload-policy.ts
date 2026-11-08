type Sample={outboundVideo?:{framesPerSecond?:number|null;qualityLimitationReason?:string;bitrate?:number;avgPacketSendDelayMs?:number|null}|null;connection?:{availableOutgoingBitrate?:number|null};remoteInbound?:{fractionLost?:number|null}|null};
/** Missing or stale capacity evidence never grants background upload bandwidth. */
export function healthyUploadSample(sample:Sample){
  const out=sample.outboundVideo,capacity=sample.connection?.availableOutgoingBitrate;
  return !!out&&out.qualityLimitationReason==='none'&&Number.isFinite(out.framesPerSecond)&&(out.framesPerSecond??0)>=18
    &&Number.isFinite(out.bitrate)&&Number.isFinite(capacity)&&(capacity??0)-(out.bitrate??0)>=600000
    &&Number.isFinite(out.avgPacketSendDelayMs)&&(out.avgPacketSendDelayMs??Infinity)<=50
    &&(sample.remoteInbound?.fractionLost==null||sample.remoteInbound.fractionLost<=.02);
}
