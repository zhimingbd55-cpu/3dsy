function readableFailure(error:unknown){
  const message=error instanceof Error?error.message:typeof error==='string'?error:'';
  if(/额度不足|insufficient[ _-]?(?:credits?|balance)|not enough credits?|credits? (?:exhausted|depleted)|out of credits?/i.test(message))return '试衣服务额度不足，请联系管理员。';
  if(/session_limit|Session Limit Reached|云端并发已满/i.test(message))return '云端并发已满，请稍后重试。';
  return message||'试衣连接失败，请重试。';
}

// The SDK can report "disconnected" before its error/sessionEnded callback.
// Read the server's recorded cause after stopping the session, without starting
// another connection. The caller owns the timeout and stale-session guard.
export async function sessionFailureMessage(error:unknown,read?:()=>Promise<{error?:string|null}>){
  if(read)try{const saved=await read();if(saved.error)return readableFailure(saved.error);}catch{/* Keep a useful fallback when the phone is offline. */}
  return readableFailure(error);
}
