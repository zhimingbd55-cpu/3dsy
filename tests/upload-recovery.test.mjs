import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingStillActive} from '../src/upload-recovery.ts';

test('an ongoing long session is never finalized based on local recording age',()=>{
  for(const status of ['queued','reserved','connecting','recording'])assert.equal(recordingStillActive(status),true);
  for(const status of ['saving','complete','failed','cancelled','ready'])assert.equal(recordingStillActive(status),false);
});
