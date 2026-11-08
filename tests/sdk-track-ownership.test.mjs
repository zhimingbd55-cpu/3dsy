import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import {pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url);
const dataUrl=code=>`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
// The production staging checkout intentionally has no Vite dev dependency.
// Execute its actual config, replacing only Vite's identity defineConfig helper
// and resolving the original module context. Every plugin transform stays intact.
const configUrl=new URL('../vite.config.ts',import.meta.url);
let configSource=await readFile(configUrl,'utf8');
const configReplacements=[
  ["import { defineConfig } from 'vite';",'const defineConfig=value=>value;'],
  ["'./src/video-profile.ts'",JSON.stringify(new URL('../src/video-profile.ts',import.meta.url).href)],
  ['import.meta.url',JSON.stringify(configUrl.href)],
];
for(const [marker,replacement] of configReplacements){
  assert.equal(configSource.split(marker).length,2,`Review changed Vite config loader marker: ${marker}`);
  configSource=configSource.replace(marker,replacement);
}
const {default:config}=await import(dataUrl(stripTypeScriptTypes(configSource)));
const adapters=config.plugins.filter(plugin=>plugin.name==='decart-dual-peer-compatibility');
assert.equal(adapters.length,1,'The actual config must contain one SDK compatibility adapter');
assert.equal(typeof adapters[0].transform,'function');
const directory=new URL('../node_modules/@decartai/sdk/dist/realtime/',import.meta.url);
const mediaId=new URL('media-channel.js',directory).pathname;
const source=await readFile(new URL('media-channel.js',directory),'utf8');
const settings=await readFile(new URL('config-realtime.js',directory),'utf8');
const transform=(code,id=mediaId)=>adapters[0].transform(code,id);
const harnesses=globalThis.__sdkTrackOwnershipTestHarnesses??=new Map();
let nextHarness=0;

// Execute the installed SDK media-channel body after the real Vite transform.
// Only its LiveKit transport is replaced: no WebSocket, camera or paid service.
// The fake disconnect default mirrors livekit-client Room.disconnect(true),
// including its explicit stop flag overriding stopLocalTrackOnUnpublish:false.
async function harness(t,{adapted=true,rejectDisconnect=false,deferDisconnect=false}={}){
  const key=++nextHarness,rooms=[],published=[],observed=[],pendingCloses=[];
  class MockRoom {
    remoteParticipants=new Map();
    handlers=new Map();
    disconnectCalls=[];
    publications=[];
    constructor(options){
      this.options=options;rooms.push(this);
      this.localParticipant={publishTrack:async(track,options)=>{
        if(track.readyState!=='live')throw new Error('Cannot publish ended caller track');
        this.publications.push(track);published.push({track,options});
      }};
    }
    on(event,listener){this.handlers.set(event,listener);}
    async connect(url,token,options){this.connection={url,token,options};}
    async disconnect(stopTracks=true){
      this.disconnectCalls.push(stopTracks);
      if(deferDisconnect)await new Promise(resolve=>pendingCloses.push(resolve));
      if(stopTracks)for(const track of this.publications)track.stop();
      this.publications=[];
      if(rejectDisconnect)throw new Error('Mock close failure');
    }
  }
  harnesses.set(key,{Room:MockRoom,RoomEvent:{TrackPublished:'published',Reconnected:'reconnected',TrackSubscribed:'subscribed',Disconnected:'disconnected'},Track:{Source:{Camera:'camera'}}});
  t.after(()=>harnesses.delete(key));
  const mockLivekit=dataUrl(`export async function loadLiveKitClient(){return globalThis.__sdkTrackOwnershipTestHarnesses.get(${key});}`);
  const settingsCode=transform(settings,new URL('config-realtime.js',directory).pathname).code.replace(/from "(\.[^"]+)";/g,(_whole,specifier)=>`from ${JSON.stringify(new URL(specifier,directory).href)};`);
  const settingsUrl=dataUrl(settingsCode);
  const replacements=new Map([
    ['../utils/logger.js',new URL('../utils/logger.js',directory).href],
    ['./config-realtime.js',settingsUrl],
    ['./livekit.js',mockLivekit],
    ['mitt',pathToFileURL(require.resolve('mitt')).href],
  ]);
  let code=adapted?transform(source).code:source;
  code=code.replace(/from "([^"]+)";/g,(whole,specifier)=>{
    assert.ok(replacements.has(specifier),`Review new SDK dependency: ${specifier}`);
    return `from ${JSON.stringify(replacements.get(specifier))};`;
  });
  const {LiveKitMediaChannel}=await import(dataUrl(code));
  const track={kind:'video',readyState:'live',stops:0,stop(){this.readyState='ended';this.stops++;}};
  const stream={getTracks:()=>[track],getVideoTracks:()=>[track],getAudioTracks:()=>[]};
  const create=()=>new LiveKitMediaChannel({localStream:stream,logger:{warn(){}},observability:{startPhase(){},endPhase(){},setLiveKitRoom(room){observed.push(room);}}});
  const connect=async channel=>{await channel.connect({url:'wss://never-contact.invalid',token:'mock-only'});await channel.publishLocalTracks();};
  return {create,connect,track,stream,rooms,published,observed,pendingCloses};
}

test('regression: unadapted SDK disconnect ends the caller track despite the Room unpublish option',async t=>{
  const h=await harness(t,{adapted:false}),first=h.create();
  await h.connect(first);assert.equal(h.rooms[0].options.stopLocalTrackOnUnpublish,false);
  first.disconnect();assert.equal(h.track.readyState,'ended');assert.equal(h.track.stops,1);
  assert.deepEqual(h.rooms[0].disconnectCalls,[true]);
  await assert.rejects(h.connect(h.create()),/ended caller track/);
});

test('adapted SDK closes two successive sessions without stopping the same caller-owned capture track',async t=>{
  const h=await harness(t),first=h.create();
  await h.connect(first);first.disconnect();
  assert.deepEqual(h.rooms[0].disconnectCalls,[false]);
  assert.equal(first.room,null);assert.equal(first.remoteStream,null);assert.equal(first.cameraTrackSource,null);
  assert.equal(h.observed.at(-1),null);assert.equal(h.track.readyState,'live');assert.equal(h.track.stops,0);
  const second=h.create();await h.connect(second);
  assert.equal(h.published.length,2);assert.equal(h.published[0].track,h.published[1].track);
  assert.equal(h.published[0].track,h.track);
  assert.equal(h.rooms[1].connection.options.maxRetries,0);
  second.disconnect();assert.deepEqual(h.rooms[1].disconnectCalls,[false]);
  assert.equal(h.track.readyState,'live');assert.equal(h.track.stops,0);
  h.track.stop();assert.equal(h.track.readyState,'ended','the application still owns final disposal');
});

test('adapted disconnect remains idempotent and clears its room if transport close rejects',async t=>{
  const h=await harness(t,{rejectDisconnect:true}),channel=h.create();
  await h.connect(channel);channel.disconnect();channel.disconnect();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(channel.room,null);assert.deepEqual(h.rooms[0].disconnectCalls,[false]);
  assert.equal(h.track.readyState,'live');assert.equal(h.track.stops,0);
});

test('late first-room cleanup cannot end the shared input already published by the next session',async t=>{
  const h=await harness(t,{deferDisconnect:true}),first=h.create();
  await h.connect(first);first.disconnect();
  assert.equal(h.pendingCloses.length,1);
  const second=h.create();await h.connect(second);
  h.pendingCloses.shift()();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.track.readyState,'live');assert.equal(h.track.stops,0);
  assert.equal(h.rooms[1].publications[0],h.track);
  second.disconnect();h.pendingCloses.shift()();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.track.readyState,'live');assert.equal(h.track.stops,0);
});

const markers=[
  ['RTC connect','await room.connect(opts.url, opts.token, { autoSubscribe: false });'],
  ['publish encoding','videoEncoding: {\n\t\t\tmaxBitrate,\n\t\t\tmaxFramerate: REALTIME_CONFIG.livekit.defaultPublishFps\n\t\t},'],
  ['room cleanup','disconnect() {\n\t\tconst room = this.room;'],
  ['track ownership','if (room) room.disconnect().catch(() => {});'],
];
for(const [name,marker] of markers){
  test(`SDK ${name} adapter refuses missing and duplicate markers after dependency changes`,()=>{
    assert.equal(source.split(marker).length,2,'fixture must be the currently installed unique SDK code');
    assert.throws(()=>transform(source.replace(marker,'/* dependency changed */')),/Review|review|changed/);
    assert.throws(()=>transform(source.replace(marker,`${marker}\n${marker}`)),/Review|review|changed/);
  });
}
