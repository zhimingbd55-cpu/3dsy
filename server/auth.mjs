import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { hash } from './store.mjs';
import { fail } from './config.mjs';
export function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => { const n = x.indexOf('='); return n < 0 ? [] : [x.slice(0,n).trim(), x.slice(n+1).trim()]; }).filter(x => x.length === 2));
}
export function createAuth(store, options) {
  const secure = options.origin.startsWith('https:');
  const visitorName = secure ? '__Host-amen-visitor' : 'amen-visitor';
  const adminName = secure ? '__Host-amen-admin' : 'amen-admin';
  const cookie = (res, name, value, age) => res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`);
  function visitor(req, res, create = true) {
    const token = cookies(req)[visitorName];
    let item = token && /^[\w-]{43}$/.test(token) ? store.get('SELECT * FROM visitors WHERE token_hash=?', hash(token)) : undefined;
    if (!item && create) {
      store.rate(`visitor:${req.ip}`, 30, 3600000);
      const secret = randomBytes(32).toString('base64url');
      const id = randomBytes(16).toString('hex');
      store.run('INSERT INTO visitors(id,token_hash,created_at) VALUES (?,?,?)', id, hash(secret), store.now());
      cookie(res, visitorName, secret, 365 * 86400);
      item = store.get('SELECT * FROM visitors WHERE id=?', id);
    }
    if (!item) throw fail(401, '请重新打开页面。');
    return item;
  }
  function isAdmin(req) {
    const token = cookies(req)[adminName];
    return Boolean(token && /^[\w-]{43}$/.test(token) && store.get('SELECT 1 FROM admins WHERE token_hash=? AND expires_at>?', hash(token), store.now()));
  }
  function requireAdmin(req, res, next) { if (!isAdmin(req)) return next(fail(401, '请登录管理后台。')); next(); }
  function login(req, res) {
    store.rate(`admin:${req.ip}`, 8, 15 * 60000);
    const { username, password } = req.body || {};
    const parts = options.adminHash.split('$');
    if (parts.length !== 3 || !parts[2]) throw fail(503, '后台尚未配置。');
    const computed = scryptSync(String(password || '').slice(0,256), parts[1], 64);
    const expected = Buffer.from(parts[2], 'hex');
    if (username !== options.adminUser || expected.length !== computed.length || !timingSafeEqual(computed, expected)) throw fail(401, '账号或密码错误。');
    const token = randomBytes(32).toString('base64url');
    store.run('INSERT INTO admins VALUES (?,?)', hash(token), store.now() + 8 * 3600000);
    cookie(res, adminName, token, 8 * 3600);
    return { authenticated: true };
  }
  function logout(req, res) { const token = cookies(req)[adminName]; if (token) store.run('DELETE FROM admins WHERE token_hash=?', hash(token)); cookie(res, adminName, '', 0); }
  return { visitor, isAdmin, requireAdmin, login, logout };
}
