export function syntheticStream(label:string,color:string){const canvas=document.createElement('canvas');canvas.width=360;canvas.height=640;const ctx=canvas.getContext('2d')!;const start=performance.now();const draw=()=>{const seconds=(performance.now()-start)/1000;ctx.fillStyle='#efefec';ctx.fillRect(0,0,360,640);ctx.fillStyle=color;ctx.beginPath();ctx.arc(180+Math.sin(seconds)*30,150,48,0,Math.PI*2);ctx.fill();ctx.fillRect(110+Math.sin(seconds)*30,215,140,280);ctx.fillStyle='#202020';ctx.font='23px sans-serif';ctx.fillText(label,24,560);ctx.font='18px monospace';ctx.fillText(seconds.toFixed(1)+' s',24,600);};draw();const timer=setInterval(draw,50);const stream=canvas.captureStream(20),track=stream.getVideoTracks()[0],stop=track.stop.bind(track);track.stop=()=>{clearInterval(timer);stop();};return stream;}
function wideStream(width:number,height:number){
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d')!;
 let tick=0;const draw=()=>{tick++;ctx.fillStyle='#e3e8eb';ctx.fillRect(0,0,width,height);ctx.fillStyle='#475e70';ctx.beginPath();ctx.arc(width/2,height*.24,height*.11,0,Math.PI*2);ctx.fill();ctx.fillRect(width/2-height*.14,height*.38,height*.28,height*.5);ctx.fillStyle='#e6b255';ctx.fillRect(0,0,width*.04,height);ctx.fillStyle='#65a793';ctx.fillRect(width*.96,0,width*.04,height);ctx.fillStyle='#222';ctx.font=`${height*.035}px sans-serif`;ctx.fillText(`${width} × ${height} · 模拟相机 · ${tick}`,width*.08,height*.95);};
 draw();const timer=setInterval(draw,50);const stream=canvas.captureStream(20);const track=stream.getVideoTracks()[0],stop=track.stop.bind(track);track.stop=()=>{clearInterval(timer);stop();};return stream;
}
let calls=0,active=0;
// Reproduce browsers which expose rVFC but never deliver hidden-source frames.
// This QA shim is loaded only by the loopback server and never deployed.
if(new URLSearchParams(location.search).get('frames')==='stalled'){
 const request=HTMLVideoElement.prototype.requestVideoFrameCallback;
 HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){
  if(this.getAttribute('aria-hidden')==='true'){document.documentElement.dataset.qaBlockedFrameCallbacks=String(Number(document.documentElement.dataset.qaBlockedFrameCallbacks||0)+1);return 0;}
  return request.call(this,callback);
 };
}
const draw=CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage=function(...args:Parameters<typeof draw>){
 if(args[0] instanceof HTMLVideoElement&&args[0].getAttribute('aria-hidden')==='true')document.documentElement.dataset.qaCameraPaints=String(Number(document.documentElement.dataset.qaCameraPaints||0)+1);
 return draw.apply(this,args);
};
Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async(constraints:MediaStreamConstraints)=>{
  calls++;document.documentElement.dataset.qaCameraCalls=String(calls);
  document.documentElement.dataset.qaCameraConstraints=JSON.stringify(constraints);
  const mode=new URLSearchParams(location.search).get('camera');
  if(mode==='blocked'&&calls===1)throw new DOMException('Synthetic permission denial','NotAllowedError');
  const requested=constraints.video as MediaTrackConstraints;
  const width=Number((requested.width as ConstrainULongRange)?.ideal)||480,height=Number((requested.height as ConstrainULongRange)?.ideal)||640;
  const stream=mode==='landscape'?wideStream(1280,720):mode==='portrait'||mode==='blocked'?wideStream(960,1280):wideStream(width,height);
  const track=stream.getVideoTracks()[0],stop=track.stop.bind(track);let stopped=false;
  active++;document.documentElement.dataset.qaActiveCameras=String(active);
  const facing=(constraints.video as MediaTrackConstraints)?.facingMode;
  document.documentElement.dataset.qaFacing=String(typeof facing==='object'?(facing as ConstrainDOMStringParameters).ideal:facing||'');
  track.stop=()=>{if(!stopped){stopped=true;active--;document.documentElement.dataset.qaActiveCameras=String(active);}stop();};
  return stream;
}});
