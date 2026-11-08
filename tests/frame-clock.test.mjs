import test from 'node:test';
import assert from 'node:assert/strict';
import {frameClock} from '../src/frame-clock.ts';

test('24 fps pacing stays at 24 rather than rounding down on 60/120 Hz screens',()=>{
  for(const refresh of [24,30,60,120]){
    const due=frameClock(24);let count=0;
    for(let i=0;i<refresh*10;i++)if(due(i*1000/refresh))count++;
    assert.ok(Math.abs(count-240)<=1,`${refresh} Hz produced ${count} frames in 10 s`);
  }
});
test('a stalled video resumes with the latest frame without a burst of catch-up work',()=>{
  const due=frameClock(24);assert.equal(due(0),true);assert.equal(due(10),false);
  assert.equal(due(10000),true);assert.equal(due(10000),false);assert.equal(due(10010),false);
  assert.equal(due(10042),true);assert.equal(due(NaN),false);
});
