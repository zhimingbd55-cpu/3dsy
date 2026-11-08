// A long rotation may still be recording in another tab. Only server terminal
// state, never the age of local chunks, authorizes recovery to finish a job.
export function recordingStillActive(status:string){
  return ['queued','reserved','connecting','recording'].includes(status);
}
