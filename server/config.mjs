import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MODEL = 'lucy-vton-3.6';
export const DURATION = 30;
export const HARD_LIMIT = 45;
export const RETENTION_DAYS = 30;
export const RESERVATION_BYTES = 200 * 1024 * 1024;
export const config = {
  root, dataDirectory: process.env.FITTING_DATA_DIR || path.join(root, '.amen-data'),
  origin: process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.PORT || 8766}`,
  port: Number(process.env.PORT || 8766), adminUser: process.env.ADMIN_USER || 'admin',
  adminHash: process.env.ADMIN_PASSWORD_HASH || '',
  turnSecret: process.env.TURN_SECRET || '', turnHost: process.env.TURN_HOST || '',
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  minFreeBytes: Number(process.env.MIN_FREE_BYTES ?? 10 * 1024 ** 3),
  parallelAdminOrigin: process.env.PARALLEL_ADMIN_ORIGIN || 'http://127.0.0.1:8776',
  parallelAdminBridgeFile: process.env.PARALLEL_ADMIN_BRIDGE_FILE || '',
  parallelAdminBridgeToken: process.env.PARALLEL_ADMIN_BRIDGE_TOKEN || '',
  parallelPublicOrigin: process.env.PARALLEL_PUBLIC_ORIGIN || '',
};
export function loadApiKey() {
  if (process.env.DECART_API_KEY) return process.env.DECART_API_KEY.trim();
  const secret = path.join(root, '.local', 'decart-key.dpapi');
  if (process.platform !== 'win32' || !existsSync(secret)) return '';
  try {
    const env = { ...process.env, PSModulePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') };
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'read-secret.ps1'), '-Path', secret], { encoding: 'utf8', windowsHide: true, env, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
export function publicError(error) {
  if (!error?.status || (error.status >= 500 && !error.expose)) return '服务暂时不可用，请稍后重试。';
  return String(error.message || '操作失败').replace(/(?:dct_|ek_)[A-Za-z0-9_.-]+/g, '[已隐藏]').replace(/([?&](?:api_key|token)=)[^&\s]+/g, '$1[已隐藏]').slice(0, 200);
}
export const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
