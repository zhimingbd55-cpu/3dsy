// Public posters follow established browser attribution; admin posters use the
// selected saved agent returned by an authenticated request, never that browser.
const agentCode = /^[A-Za-z0-9_-]{1,100}$/;
export function promotionUrl(origin:string,referralPath:unknown):string{
  const path=typeof referralPath==='string'&&/^\/a\/[A-Za-z0-9_-]{1,100}$/.test(referralPath)?referralPath:'/';
  return new URL(path,new URL(origin).origin).href;
}
export function agentPromotionUrl(origin:string,agent:{code?:unknown;active?:unknown}|null|undefined):string{
  if(!agent)throw new Error('该代理不存在，请刷新代理列表。');
  if(agent.active!==true)throw new Error('该代理已停用，请先启用再生成专属海报。');
  if(typeof agent.code!=='string'||!agentCode.test(agent.code))throw new Error('代理推广链接无效，请刷新后重试。');
  return promotionUrl(origin,`/a/${agent.code}`);
}
