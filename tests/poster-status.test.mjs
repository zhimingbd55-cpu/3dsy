import test from 'node:test';
import assert from 'node:assert/strict';
import {posterMissingMessage} from '../src/poster-status.ts';
test('existing recording row retains true upload, processing, retry and failure state',()=>{
 assert.equal(posterMissingMessage('original','saving',{status:'uploading'}),'原视频正在保存');
 assert.equal(posterMissingMessage('original','saved',{status:'processing'}),'原视频正在处理');
 assert.equal(posterMissingMessage('original','saved',{status:'uploading',waitingForUpload:true}),'原视频待续传');
 assert.equal(posterMissingMessage('original','saved',{status:'uploading'},{state:'retry'}),'原视频待续传');
 assert.equal(posterMissingMessage('result','saved',{status:'failed'}),'试穿成片未能完整保存');
 assert.equal(posterMissingMessage('result','saved',{status:'ready'}),'试穿成片封面暂不可用');
 assert.equal(posterMissingMessage('original','saved'),'原视频尚未完成保存');
});
