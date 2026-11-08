import QRCode from 'qrcode';
export type PosterCover={url:string|null;missing:string};
let fontPromise:Promise<void>|null=null;
async function posterFont(){
  fontPromise??=(async()=>{const face=new FontFace('OneYiPoster','url(/brand/poster-display.woff)',{weight:'900'});await face.load();document.fonts.add(face);})();
  try{await fontPromise;}catch(error){fontPromise=null;throw error;}
}
export function loadPosterImage(url:string){return new Promise<HTMLImageElement>((resolve,reject)=>{const image=new Image();const timer=setTimeout(()=>{image.onload=null;image.onerror=null;reject(new Error('封面读取超时。'));},15000);image.onload=()=>{clearTimeout(timer);resolve(image);};image.onerror=()=>{clearTimeout(timer);reject(new Error('封面暂不可用。'));};image.src=url;});}
function multiline(ctx:CanvasRenderingContext2D,label:string,x:number,y:number,maxWidth:number){
  let line='';const lines:string[]=[];for(const letter of label){if(ctx.measureText(line+letter).width>maxWidth){lines.push(line);line=letter;}else line+=letter;}if(line)lines.push(line);
  lines.forEach((value,index)=>ctx.fillText(value,x,y+index*54));
}
export async function createBrandPoster(link:string,original:PosterCover,result:PosterCover){
  await posterFont();
  const logo=await loadPosterImage('/brand/logo.svg');
  const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1620;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('无法生成分享海报。');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1080,1620);ctx.drawImage(logo,52,42,320,120);
  ctx.fillStyle='#ff641f';ctx.fillRect(868,65,150,94);ctx.fillStyle='#151515';ctx.font='900 112px OneYiPoster';ctx.fillText('今天，换个样',48,302);
  const top=395,width=468,height=832;
  for(const [index,cover] of [original,result].entries()){
    const x=48+index*516;ctx.fillStyle=index?'#ff641f':'#151515';ctx.fillRect(x,337,width,58);ctx.fillStyle=index?'#151515':'#fff';ctx.font='900 34px OneYiPoster';ctx.fillText(index?'试穿成片':'原视频',x+22,379);
    ctx.fillStyle='#efefed';ctx.fillRect(x,top,width,height);
    let image:HTMLImageElement|null=null;try{if(cover.url)image=await loadPosterImage(cover.url);}catch{}
    if(image){const scale=Math.min(width/image.naturalWidth,height/image.naturalHeight),w=image.naturalWidth*scale,h=image.naturalHeight*scale;ctx.drawImage(image,x+(width-w)/2,top+(height-h)/2,w,h);}
    else{ctx.fillStyle='#737371';ctx.font='900 38px OneYiPoster';ctx.textAlign='center';multiline(ctx,cover.url?'封面暂不可用':cover.missing,x+width/2,top+height/2-20,width-64);ctx.textAlign='left';}
  }
  ctx.fillStyle='#151515';ctx.font='900 68px OneYiPoster';ctx.fillText('扫码看试穿',48,1385);
  ctx.fillStyle='#ff641f';ctx.beginPath();ctx.moveTo(50,1452);ctx.lineTo(493,1452);ctx.lineTo(493,1405);ctx.lineTo(600,1474);ctx.lineTo(493,1543);ctx.lineTo(493,1496);ctx.lineTo(50,1496);ctx.closePath();ctx.fill();
  const qr=document.createElement('canvas');await QRCode.toCanvas(qr,link,{errorCorrectionLevel:'M',margin:4,width:310,color:{dark:'#151515',light:'#ffffff'}});ctx.drawImage(qr,724,1270,310,310);
  return canvas;
}
