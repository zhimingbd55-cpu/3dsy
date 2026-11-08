import test from 'node:test';
import assert from 'node:assert/strict';
import {imageShareFile,prepareImageExport,createImageShareController} from '../src/image-sharing.ts';

const png=()=>imageShareFile(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:'image/png'}),'1➕衣-test.png');
function setup(navigator){const views=[],busy=[];const controller=createImageShareController({file:png(),navigator,onSaveView:()=>views.push('save'),onBusyChange:value=>busy.push(value)});return {controller,views,busy};}

test('image files retain real PNG/JPEG MIME and correct extensions, never generic binary',()=>{
  const file=png();assert.equal(file.type,'image/png');assert.equal(file.name,'1➕衣-test.png');assert.equal(file.size,8);
  const jpeg=imageShareFile(new Blob(['jpeg'],{type:'image/jpeg'}),'a.png');assert.equal(jpeg.name,'a.jpg');assert.equal(jpeg.type,'image/jpeg');
  assert.throws(()=>imageShareFile(new Blob(['x'],{type:'application/octet-stream'}),'a.png'),/PNG 或 JPEG/);
  assert.throws(()=>imageShareFile(new Blob([],{type:'image/png'}),'a.png'),/PNG 或 JPEG/);
});

test('sharing sends files only synchronously within the click before the returned promise settles',async()=>{
  const calls=[];let resolve;
  const h=setup({canShare:data=>{calls.push(['canShare',data]);return true;},share:data=>{calls.push(['share',data]);return new Promise(done=>{resolve=done;});}});
  const pending=h.controller.share();assert.equal(calls.length,2);assert.deepEqual(Object.keys(calls[1][1]),['files']);assert.equal(calls[1][1].files[0].type,'image/png');assert.deepEqual(h.busy,[true]);
  assert.equal(await h.controller.share(),'ignored');assert.equal(calls.length,2);resolve();assert.equal(await pending,'shared');assert.deepEqual(h.busy,[true,false]);assert.deepEqual(h.views,[]);
});

test('unsupported or rejected file capability opens image view without trying a download or share',async()=>{
  for(const navigator of [{},{canShare:()=>false,share:()=>assert.fail('share called')},{canShare:()=>{throw new Error('unsupported');},share:()=>assert.fail('share called')}]){
    const h=setup(navigator);assert.equal(await h.controller.share(),'fallback');assert.deepEqual(h.views,['save']);assert.deepEqual(h.busy,[]);
  }
});

test('WeChat opens the image view synchronously even when Web Share advertises file support but never settles',async()=>{
  for(const userAgent of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.60',
    'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.60',
  ]){
    let capabilityCalls=0,nativeCalls=0;
    const h=setup({userAgent,canShare:()=>{capabilityCalls++;return true;},share:()=>{nativeCalls++;return new Promise(()=>{});}});
    const pending=h.controller.share();assert.equal(capabilityCalls,0);assert.equal(nativeCalls,0);assert.deepEqual(h.views,['save']);assert.equal(h.controller.busy,false);
    assert.equal(await pending,'fallback');assert.deepEqual(h.busy,[]);
    h.controller.dispose();assert.equal(await h.controller.share(),'ignored');assert.deepEqual(h.views,['save']);
  }
});

test('Safari and Chrome user agents retain native image sharing',async()=>{
  for(const userAgent of ['Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1','Mozilla/5.0 Chrome/130.0.0.0 Mobile Safari/537.36']){
    let calls=0;const h=setup({userAgent,canShare:()=>true,share:()=>{calls++;return Promise.resolve();}});
    assert.equal(await h.controller.share(),'shared');assert.equal(calls,1);assert.deepEqual(h.views,[]);
  }
});

test('native cancellation is quiet for both asynchronous and synchronous AbortError',async()=>{
  for(const share of [()=>Promise.reject(new DOMException('cancel','AbortError')),()=>{throw new DOMException('cancel','AbortError');}]){
    const h=setup({canShare:()=>true,share});assert.equal(await h.controller.share(),'cancelled');assert.deepEqual(h.views,[]);assert.deepEqual(h.busy,[true,false]);
  }
});

test('native failure opens the image view and allows a subsequent explicit retry',async()=>{
  let attempts=0;const h=setup({canShare:()=>true,share:()=>++attempts===1?Promise.reject(new Error('failed')):Promise.resolve()});
  assert.equal(await h.controller.share(),'fallback');assert.deepEqual(h.views,['save']);assert.equal(await h.controller.share(),'shared');assert.equal(attempts,2);
});

test('non-standard share bridge without a Promise falls back instead of claiming success',async()=>{
  for(const result of [undefined,null,true]){
    const h=setup({canShare:()=>true,share:()=>result});
    assert.equal(await h.controller.share(),'fallback');assert.deepEqual(h.views,['save']);assert.deepEqual(h.busy,[true,false]);assert.equal(h.controller.busy,false);
  }
});

test('closing during a pending native share prevents late fallbacks and callbacks',async()=>{
  let reject;const h=setup({canShare:()=>true,share:()=>new Promise((_,fail)=>{reject=fail;})});const pending=h.controller.share();h.controller.dispose();reject(new Error('late'));
  assert.equal(await pending,'ignored');assert.deepEqual(h.views,[]);assert.deepEqual(h.busy,[true]);assert.equal(await h.controller.share(),'ignored');
});

test('prepared previews use an image data URL and disposal releases the preview without file download',async t=>{
  const original=globalThis.FileReader;
  globalThis.FileReader=class{result=null;readAsDataURL(blob){void blob.arrayBuffer().then(bytes=>{this.result=`data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;this.onload();});}};
  t.after(()=>{if(original)globalThis.FileReader=original;else delete globalThis.FileReader;});
  const image=await prepareImageExport(png(),'preview.png');assert.match(image.previewUrl,/^data:image\/png;base64,/);assert.equal(image.file.type,'image/png');assert.equal(image.disposed,false);
  image.dispose();image.dispose();assert.equal(image.previewUrl,'');assert.equal(image.disposed,true);
});
