import {VIDEO_PROFILE} from './video-profile.ts';
type RoomHandle={engine?:{pcManager?:{publisher?:RTCPeerConnection|null}|null}|null};
type Runtime=typeof globalThis&{__amenBindRtcRoom?:(room:RoomHandle|null)=>void;__amenRtcRoom?:RoomHandle|null};
export type PublishProfile={width:number|null;height:number|null;layers:number|null;targetBitrateBps:number|null};
const runtime=globalThis as Runtime;
runtime.__amenBindRtcRoom=room=>{runtime.__amenRtcRoom=room;};

function sender(){
  const pc=runtime.__amenRtcRoom?.engine?.pcManager?.publisher;
  return pc?.getSenders().find(item=>item.track?.kind==='video');
}
function profileFromParameters(track:MediaStreamTrack|null|undefined,encodings:RTCRtpEncodingParameters[]|undefined):PublishProfile|null{
  if(!encodings?.length)return null;
  const settings=track?.getSettings?.(),sourceWidth=settings?.width,sourceHeight=settings?.height;
  const primary=encodings.reduce((index,item,current,array)=>{
    const scale=Number.isFinite(item.scaleResolutionDownBy)?item.scaleResolutionDownBy!:1;
    const best=Number.isFinite(array[index].scaleResolutionDownBy)?array[index].scaleResolutionDownBy!:1;
    return scale<best?current:index;
  },0);
  const scale=Number.isFinite(encodings[primary].scaleResolutionDownBy)?encodings[primary].scaleResolutionDownBy!:1;
  const width=Number.isFinite(sourceWidth)&&sourceWidth!>0?Math.round(sourceWidth!/scale):null;
  const height=Number.isFinite(sourceHeight)&&sourceHeight!>0?Math.round(sourceHeight!/scale):null;
  const rates=encodings.map(encoding=>encoding.maxBitrate).filter((value):value is number=>Number.isFinite(value)&&value!>0);
  return {width,height,layers:encodings.length,targetBitrateBps:rates.length?rates.reduce((sum,value)=>sum+value,0):null};
}
/** Report the active RTP sender's accepted dimensions, layer count, and caps. */
export function readPublishProfile():PublishProfile|null{
  const active=sender();
  if(!active||typeof active.getParameters!=='function')return null;
  try{return profileFromParameters(active.track,active.getParameters().encodings);}catch{return null;}
}
/** Apply one absolute downshift while retaining the source track and RIDs. */
export async function applyFluidPublishProfile():Promise<boolean>{
  const active=sender();
  if(!active||typeof active.getParameters!=='function'||typeof active.setParameters!=='function')return false;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const parameters=active.getParameters();
      if(!parameters.encodings?.length)return false;
      const primary=parameters.encodings.reduce((index,item,current,array)=>{
        const scale=Number.isFinite(item.scaleResolutionDownBy)?item.scaleResolutionDownBy!:1;
        const best=Number.isFinite(array[index].scaleResolutionDownBy)?array[index].scaleResolutionDownBy!:1;
        return scale<best?current:index;
      },0);
      parameters.encodings.forEach((encoding,index)=>{
        encoding.scaleResolutionDownBy=index===primary?1:VIDEO_PROFILE.canvas.height/VIDEO_PROFILE.secondary.height;
        encoding.maxFramerate=VIDEO_PROFILE.reduced.fps;
        encoding.maxBitrate=index===primary?VIDEO_PROFILE.reduced.primaryBitrate:VIDEO_PROFILE.reduced.secondaryBitrate;
      });
      await active.setParameters(parameters);
      return true;
    }catch(error){
      if(attempt===0&&(error as DOMException)?.name==='InvalidModificationError')continue;
      return false;
    }
  }
  return false;
}
