import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraConstraints,cameraFrame,captureHasEnoughDetail,widestCameraView,tuneCameraCapture} from '../src/portrait.ts';

test('camera capture preserves native field of view instead of requesting a 9:16 crop',()=>{
  for(const facing of ['user','environment'])for(const portrait of [true,false]){
    const value=cameraConstraints(facing,portrait);
    assert.equal(value.facingMode.ideal,facing);assert.equal(value.aspectRatio,undefined);
    assert.equal(value.resizeMode.ideal,'none');assert.equal(value.frameRate.ideal,20);assert.equal(value.frameRate.max,20);
    assert.equal(value.width.ideal,portrait?480:640);assert.equal(value.height.ideal,portrait?640:480);
    assert.ok(portrait?value.height.ideal>value.width.ideal:value.width.ideal>value.height.ideal);
  }
});

test('camera tuning corrects an excessive native capture once and returns only safe actual settings',async()=>{
  let settings={width:960,height:1280,frameRate:30,deviceId:'private',groupId:'private'},calls=0;
  const track={getSettings:()=>settings,getConstraints:()=>({resizeMode:{ideal:'none'},advanced:[{zoom:.5}]}),applyConstraints:async constraints=>{
    calls++;assert.deepEqual(constraints.width,{ideal:480,min:270,max:480});assert.deepEqual(constraints.height,{ideal:640,min:480,max:640});
    assert.deepEqual(constraints.frameRate,{ideal:20,max:20});assert.equal(constraints.advanced[0].zoom,.5);assert.equal(constraints.resizeMode.ideal,'none');
    settings={...settings,width:480,height:640,frameRate:20};
  }};
  const [first,second]=await Promise.all([tuneCameraCapture(track),tuneCameraCapture(track)]);
  assert.equal(calls,1);assert.deepEqual(first,{width:480,height:640,frameRate:20,correction:'applied'});assert.deepEqual(second,first);
  await tuneCameraCapture(track);assert.equal(calls,1);
});

test('camera tuning respects native orientation and does not force an unnecessary 9:16 crop',async()=>{
  for(const settings of [{width:640,height:480,frameRate:20},{width:480,height:640,frameRate:20}]){
    const result=await tuneCameraCapture({getSettings:()=>settings,applyConstraints:async()=>assert.fail('already within budget')});
    assert.equal(result.correction,'not-needed');
  }
  let applied;
  await tuneCameraCapture({getSettings:()=>({width:1280,height:960,frameRate:30}),getConstraints:()=>({}),applyConstraints:async value=>{applied=value;}});
  assert.equal(applied.width.max,640);assert.equal(applied.height.max,480);assert.equal(applied.aspectRatio,undefined);
});

test('camera tuning failure preserves usable track and does not retry or invent actual settings',async()=>{
  let calls=0;
  const track={getSettings:()=>({width:1280,height:720,frameRate:30}),applyConstraints:async()=>{calls++;throw Error('unsupported');}};
  assert.deepEqual(await tuneCameraCapture(track),{width:1280,height:720,frameRate:30,correction:'failed'});
  await tuneCameraCapture(track);assert.equal(calls,1);
  assert.deepEqual(await tuneCameraCapture({}),{correction:'unavailable'});
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>({width:NaN,height:Infinity,frameRate:0})}),{correction:'unavailable'});
  let reads=0;
  const broken={getSettings:()=>({width:1280,height:720,frameRate:30}),get applyConstraints(){reads++;throw new Error('unsupported getter');}};
  assert.deepEqual(await tuneCameraCapture(broken),{width:1280,height:720,frameRate:30,correction:'failed'});
  await tuneCameraCapture(broken);assert.equal(reads,1);
});

test('fulfilled constraints never claim correction when the camera ignores them or hides actual settings',async()=>{
  const oversized={width:960,height:1280,frameRate:30};
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>oversized,applyConstraints:async()=>{}}),{...oversized,correction:'failed'});
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>oversized}),{...oversized,correction:'failed'});
  let applied=false;
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>applied?{}:oversized,applyConstraints:async()=>{applied=true;}}),{correction:'unavailable'});
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>({width:480,height:640})}),{width:480,height:640,correction:'unavailable'});
  applied=false;
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>applied?{width:480,height:640}:oversized,applyConstraints:async()=>{applied=true;}}),{width:480,height:640,correction:'unavailable'});
});

test('352x288 camera is corrected once using native landscape orientation and a real crop minimum',async()=>{
  let settings={width:352,height:288,frameRate:20},calls=0;
  const track={getSettings:()=>settings,getCapabilities:()=>({width:{min:160,max:1920},height:{min:120,max:1080}}),applyConstraints:async constraints=>{
    calls++;assert.deepEqual(constraints.width,{ideal:640,min:270,max:640});assert.deepEqual(constraints.height,{ideal:480,min:480,max:480});
    assert.equal(constraints.aspectRatio,undefined);assert.equal(constraints.frameRate.max,20);
    settings={width:640,height:480,frameRate:20};
  }};
  const result=await tuneCameraCapture(track,true);
  assert.deepEqual(result,{...settings,correction:'applied'});assert(captureHasEnoughDetail(result.width,result.height));
  await tuneCameraCapture(track);assert.equal(calls,1);
});

test('max-only regression cannot label a fulfilled 352x288 fallback as applied',async()=>{
  let settings={width:1280,height:720,frameRate:30},calls=0;
  const track={getSettings:()=>settings,applyConstraints:async constraints=>{
    calls++;assert.equal(constraints.height.min,480);settings={width:352,height:288,frameRate:20};
  }};
  assert.deepEqual(await tuneCameraCapture(track),{width:352,height:288,frameRate:20,correction:'failed'});
  await tuneCameraCapture(track);assert.equal(calls,1);
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>settings,applyConstraints:async()=>{}}),{...settings,correction:'failed'});
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>settings,applyConstraints:async()=>{throw Error('unsupported');}}),{...settings,correction:'failed'});
});

test('camera capability bounds avoid impossible low modes and keep device-specific larger native capture',async()=>{
  for(const [width,height] of [[1280,720],[720,1280]]){
    const settings={width,height,frameRate:20};
    assert.deepEqual(await tuneCameraCapture({getSettings:()=>settings,getCapabilities:()=>({width:{min:width,max:1920},height:{min:height,max:1920}}),applyConstraints:async()=>assert.fail('no smaller mode is advertised')}),{...settings,correction:'not-needed'});
  }
  let settings={width:1920,height:1080,frameRate:20};
  const result=await tuneCameraCapture({getSettings:()=>settings,getCapabilities:()=>({width:{min:1280,max:1920},height:{min:720,max:1080}}),applyConstraints:async constraints=>{
    assert.deepEqual(constraints.width,{ideal:1280,min:1280,max:1280});assert.deepEqual(constraints.height,{ideal:720,min:720,max:720});settings={width:1280,height:720,frameRate:20};
  }});
  assert.deepEqual(result,{...settings,correction:'applied'});
  const low={width:352,height:288,frameRate:20};
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>low,getCapabilities:()=>({width:{min:160,max:352},height:{min:120,max:288}}),applyConstraints:async()=>assert.fail('cannot satisfy crop minimum')}),{...low,correction:'failed'});
});

test('missing capabilities remain compatible and missing actual capture data remains unknown',async()=>{
  let settings={width:352,height:288,frameRate:20};
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>settings,getCapabilities:()=>{throw Error('unavailable');},applyConstraints:async()=>{settings={width:480,height:640,frameRate:20};}}),{width:480,height:640,frameRate:20,correction:'applied'});
  let applied=false;
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>applied?{}:{width:352,height:288,frameRate:20},applyConstraints:async()=>{applied=true;}}),{correction:'unavailable'});
  assert.deepEqual(await tuneCameraCapture({getSettings:()=>({width:352,frameRate:20}),applyConstraints:async()=>assert.fail('actual crop is unknown')}),{width:352,frameRate:20,correction:'unavailable'});
});

test('capture detail checks the real centered crop and keeps existing landscape and portrait targets usable',()=>{
  for(const [width,height] of [[640,480],[480,640],[360,640],[270,480],[1280,720]])assert.equal(captureHasEnoughDetail(width,height),true);
  for(const [width,height] of [[352,288],[640,360],[269,640],[640,479],[0,640],[-1,480],[NaN,640],[640,Infinity]])assert.equal(captureHasEnoughDetail(width,height),false);
  assert.deepEqual(cameraFrame(352,288),{x:95,y:0,width:162,height:288});
});

test('original portrait framing fills the output without stretching across camera orientations',()=>{
  for(const [w,h] of [[1280,720],[1280,960],[960,1280],[720,1280],[640,1280],[1920,1080]]){
    const rect=cameraFrame(w,h);
    assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=w+1e-6&&rect.y+rect.height<=h+1e-6);
    assert.ok(Math.abs(rect.width/rect.height-9/16)<1e-9,'portrait source crop matches output proportions');
    assert.ok(Math.abs(rect.width-w)<1e-6||Math.abs(rect.height-h)<1e-6,'largest possible portrait region, without extra digital zoom');
    assert.equal(rect.x+rect.width/2,w/2);assert.equal(rect.y+rect.height/2,h/2);
  }
});

test('portrait crop retains the complete native height and rejects invalid frames',()=>{
  const rect=cameraFrame(960,1280);
  assert.deepEqual(rect,{x:120,y:0,width:720,height:1280});
  assert.deepEqual(cameraFrame(720,1280),{x:0,y:0,width:720,height:1280});
  for(const [w,h] of [[0,720],[720,0],[-1,1280],[1280,NaN]])assert.throws(()=>cameraFrame(w,h),RangeError);
});

test('hardware zoom starts at its advertised minimum including a sub-1x wide lens',async()=>{
  for(const min of [.5,1]){
    let applied;
    await widestCameraView({getCapabilities:()=>({zoom:{min,max:5}}),getConstraints:()=>({facingMode:'user',resizeMode:'none'}),applyConstraints:async value=>{applied=value;}});
    assert.equal(applied.advanced[0].zoom,min);assert.equal(applied.facingMode,'user');assert.equal(applied.resizeMode,'none');
  }
});

test('unsupported or malformed hardware zoom never blocks camera preview',async()=>{
  await widestCameraView({getCapabilities:()=>({})});
  await widestCameraView({getCapabilities:()=>{throw Error('unsupported');}});
  for(const min of [NaN,Infinity,0,-1])await widestCameraView({getCapabilities:()=>({zoom:{min,max:5}}),applyConstraints:async()=>{assert.fail('invalid zoom');}});
  await widestCameraView({getCapabilities:()=>({zoom:{min:1,max:5}}),getConstraints:()=>({}),applyConstraints:async()=>{throw Error('unsupported');}});
});
