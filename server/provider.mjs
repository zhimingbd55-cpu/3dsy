export class ProviderError extends Error {
  constructor(message, status = 502, code = 'PROVIDER_ERROR') { super(message); this.status = status; this.code = code; }
}
export function providerError(status) {
  const messages = {
    401: ['Decart 密钥未通过验证，请在后台配置有效密钥。', 'INVALID_API_KEY'],
    403: ['Decart 拒绝访问，请检查此密钥的模型权限。', 'ACCESS_DENIED'],
    402: ['Decart 账户额度不足，请在开发者平台补充额度。', 'INSUFFICIENT_CREDITS'],
    429: ['Decart 并发或调用频率已达上限，请结束其他会话后重试。', 'RATE_LIMITED'],
    422: ['Decart 拒绝了会话参数，请检查模型与时长。', 'INVALID_PARAMETERS'],
  };
  const [message, code] = messages[status] || [`Decart 服务暂时不可用（HTTP ${status}），请稍后重试。`, 'PROVIDER_ERROR'];
  return new ProviderError(message, status >= 400 && status < 500 ? status : 502, code);
}
export function createProvider(apiKey, fetcher = fetch) {
  return {
    configured: Boolean(apiKey),
    async quota({signal,timeoutMs=5000}={}){
      const requestSignal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
      let response;
      try{response=await fetcher('https://api.decart.ai/v1/realtime/quota',{headers:{'x-api-key':apiKey},signal:requestSignal});}
      catch{throw new ProviderError('无法查询 Decart 并发名额。',502,'NETWORK_ERROR');}
      if(!response.ok)throw providerError(response.status);
      let data;try{data=await response.json();}catch{throw new ProviderError('Decart 并发数据无效。',502,'INVALID_RESPONSE');}
      if(!data||['limit','active','remaining'].some(k=>data[k]!==null&&(!Number.isSafeInteger(data[k])||data[k]<0)))throw new ProviderError('Decart 并发数据无效。',502,'INVALID_RESPONSE');
      return {limit:data.limit,active:data.active,remaining:data.remaining};
    },
    async token(model, duration, origin, { signal, timeoutMs = 18000 } = {}) {
      if (!apiKey) throw new ProviderError('尚未配置 Decart 密钥，请在后台添加并选择密钥。', 503, 'KEY_MISSING');
      signal?.throwIfAborted();
      const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      let response;
      try {
        response = await fetcher('https://api.decart.ai/v1/client/tokens', {
          method: 'POST', headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresIn: 120, allowedModels: [model], allowedOrigins: [origin], constraints: { realtime: { maxSessionDuration: duration } } }),
          signal: requestSignal,
        });
      } catch {
        signal?.throwIfAborted();
        throw new ProviderError('无法连接 Decart，请检查网络后重试。', 502, 'NETWORK_ERROR');
      }
      signal?.throwIfAborted();
      if (!response.ok) throw providerError(response.status);
      let token;
      try { token = await response.json(); } catch {
        signal?.throwIfAborted();
        if (requestSignal.aborted) throw new ProviderError('Decart 响应超时。', 502, 'NETWORK_ERROR');
        throw new ProviderError('Decart 返回了无法识别的响应。', 502, 'INVALID_RESPONSE');
      }
      signal?.throwIfAborted();
      if (!token || Array.isArray(token) || typeof token.apiKey !== 'string' || !token.apiKey.trim() || token.apiKey.length > 4096 || /\s/.test(token.apiKey) || token.apiKey === apiKey) throw new ProviderError('Decart 未返回有效的临时令牌。', 502, 'INVALID_RESPONSE');
      return { apiKey: token.apiKey, expiresAt: token.expiresAt };
    },
  };
}
