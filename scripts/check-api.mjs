import { config, loadApiKey, MODEL, HARD_LIMIT } from '../server/config.mjs';
import { createStore } from '../server/store.mjs';
import { createApiKeys } from '../server/api-keys.mjs';
const store=createStore(config.dataDirectory,config),provider=createApiKeys(store,{...config,apiKey:loadApiKey()});
try {
  const token = await provider.token(MODEL,HARD_LIMIT,config.origin);
  console.log(JSON.stringify({ configured: provider.configured(), authenticated: true, shortLivedTokenIssued: Boolean(token.apiKey), expiresAt: token.expiresAt, generationStarted: false }));
} catch(error) { console.log(JSON.stringify({ configured: provider.configured(), authenticated: false, code: error.code, status: error.status, message: error.message })); process.exitCode = 1; }
finally{store.close();}
