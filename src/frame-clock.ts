// Retain fractional deadlines: resetting to each 60 Hz display tick turns a
// nominal 24 fps pipeline into 20 fps. Do not catch up stale frames after a stall.
export function frameClock(fps:number){
  if(!Number.isFinite(fps)||fps<=0)throw new RangeError('Invalid frame rate');
  const interval=1000/fps;let next=-Infinity;
  return (time:number)=>{
    if(!Number.isFinite(time)||time+.5<next)return false;
    next=!Number.isFinite(next)||time-next>interval*2?time+interval:next+interval;
    return true;
  };
}
