import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import config from '../vite.config.ts';
import {applyFluidPublishProfile,readPublishProfile} from '../src/adaptive-fluid.ts';

test('build-time Decart adapter publishes two smooth layers with the 688 kbps start estimate',async()=>{
  const root=resolve('node_modules/@decartai/sdk/dist/realtime');
  const media=await readFile(resolve(root,'media-channel.js'),'utf8');
  const mediaResult=config.plugins[0].transform(media,`${root}/media-channel.js`);
  assert.match(mediaResult.code,/maxFramerate: REALTIME_CONFIG\.livekit\.defaultPublishFps/);
  assert.match(mediaResult.code,/videoSimulcastLayers: \[\{width:180,height:320,encoding:\{maxBitrate:150000,maxFramerate:15\}\}\]/);
  const settings=await readFile(resolve(root,'config-realtime.js'),'utf8');
  const settingsResult=config.plugins[0].transform(settings,`${root}/config-realtime.js`);
  assert.match(settingsResult.code,/const MIN_VIDEO_BITRATE_BPS = 400000/);
  assert.match(settingsResult.code,/const MAX_VIDEO_BITRATE_BPS = 700000/);
  assert.match(settingsResult.code,/const SIMULCAST_LOWER_LAYERS_BPS = 150000/);
  assert.match(settingsResult.code,/defaultPublishFps: 20/);
  assert.equal(Math.round((400000+150000)/.8/1000),688);
});

test('adaptive downgrade applies absolute encoding values and leaves the recorder track intact',async()=>{
  let parameters={encodings:[{rid:'q',scaleResolutionDownBy:2,maxFramerate:15,maxBitrate:150000},{rid:'f',scaleResolutionDownBy:1,maxFramerate:20,maxBitrate:700000}]};
  const track={kind:'video',getSettings:()=>({width:360,height:640})};
  let setCalls=0;
  const sender={track,getParameters:()=>structuredClone(parameters),setParameters:async next=>{setCalls++;parameters=structuredClone(next);}};
  globalThis.__amenRtcRoom={engine:{pcManager:{publisher:{getSenders:()=>[sender]}}}};
  assert.deepEqual(readPublishProfile(),{width:360,height:640,layers:2,targetBitrateBps:850000});
  const applied=await applyFluidPublishProfile();assert.equal(applied,true);assert.equal(setCalls,1);
  assert.equal(sender.track,track);assert.deepEqual(parameters.encodings.map(x=>x.rid),['q','f']);
  assert.deepEqual(parameters.encodings.map(x=>[x.scaleResolutionDownBy,x.maxFramerate,x.maxBitrate]),[[2,15,100000],[1,15,500000]]);
  assert.deepEqual(readPublishProfile(),{width:360,height:640,layers:2,targetBitrateBps:600000});
  delete globalThis.__amenRtcRoom;
});

test('sender without mutable encoding parameters safely falls back',async()=>{
  globalThis.__amenRtcRoom={engine:{pcManager:{publisher:{getSenders:()=>[{track:{kind:'video'},getParameters:()=>({encodings:[{}]})}]}}}};
  assert.equal(await applyFluidPublishProfile(),false);
  delete globalThis.__amenRtcRoom;
});
