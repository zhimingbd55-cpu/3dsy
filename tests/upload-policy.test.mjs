import test from 'node:test';
import assert from 'node:assert/strict';
import {healthyUploadSample} from '../src/upload-policy.ts';
const healthy=()=>({outboundVideo:{framesPerSecond:20,qualityLimitationReason:'none',bitrate:800000,avgPacketSendDelayMs:20},connection:{availableOutgoingBitrate:1800000},remoteInbound:{fractionLost:0}});
test('early upload requires measured spare capacity, healthy sender and low queue pressure',()=>{
  assert.equal(healthyUploadSample(healthy()),true);
  for(const field of ['framesPerSecond','bitrate','avgPacketSendDelayMs','qualityLimitationReason']){const s=healthy();delete s.outboundVideo[field];assert.equal(healthyUploadSample(s),false,field);}
  for(const value of [undefined,null,NaN,1000000]){const s=healthy();s.connection.availableOutgoingBitrate=value;assert.equal(healthyUploadSample(s),false);}
  for(const [field,value] of [['framesPerSecond',15],['avgPacketSendDelayMs',100],['qualityLimitationReason','cpu'],['qualityLimitationReason','bandwidth']]){const s=healthy();s.outboundVideo[field]=value;assert.equal(healthyUploadSample(s),false);}
  const loss=healthy();loss.remoteInbound.fractionLost=.1;assert.equal(healthyUploadSample(loss),false);
});
