import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { root } from './config.mjs';

export function cameraBridge(server, allowedHost) {
  const candidates = [process.env.CAMERA_PYTHON, path.join(root, '..', 'runtime', 'camera-python', 'Scripts', 'python.exe')].filter(Boolean);
  const python = candidates.find(existsSync);
  const wss = new WebSocketServer({ noServer: true });
  let child, pending = Buffer.alloc(0), stderr = '', lastError = '', ready = false;
  const broadcast = (data, binary = false) => { for (const client of wss.clients) if (client.readyState === 1 && client.bufferedAmount < 1000000) client.send(data, { binary }); };
  function stop() { const current = child; child = undefined; ready = false; pending = Buffer.alloc(0); current?.kill(); }
  function start() {
    if (child) return;
    if (!python) { broadcast(JSON.stringify({ type: 'error', message: 'D455 运行环境未安装，请使用普通摄像头或运行安装依赖脚本。' })); return; }
    lastError = ''; stderr = ''; pending = Buffer.alloc(0);
    const process = spawn(python, ['-u', path.join(root, 'camera', 'realsense_rgb.py')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child = process;
    process.stdout.on('data', chunk => {
      if (child !== process) return;
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (length > 5000000 || length === 0) { stop(); return; }
        if (pending.length < length + 4) break;
        broadcast(pending.subarray(4, length + 4), true);
        pending = pending.subarray(length + 4);
      }
    });
    process.stderr.on('data', data => {
      stderr += data.toString();
      const lines = stderr.split('\n'); stderr = lines.pop() || '';
      for (const line of lines) { try { const event = JSON.parse(line); if (event.type === 'ready') ready = true; if (event.type === 'error') lastError = event.message; broadcast(JSON.stringify(event)); } catch {} }
    });
    process.on('error', () => { lastError = 'D455 摄像头进程未能启动。'; broadcast(JSON.stringify({ type: 'error', message: lastError })); });
    process.on('exit', () => { if (child !== process) return; child = undefined; ready = false; broadcast(JSON.stringify({ type: 'error', message: lastError || 'D455 视频流已结束，请重新打开摄像头。' })); });
  }
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/camera/stream' || !allowedHost(request)) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => { start(); ws.on('close', () => { if (wss.clients.size === 0) stop(); }); });
  return { info: () => ({ available: Boolean(python), running: ready, viewers: wss.clients.size }), close: () => { for (const client of wss.clients) client.close(); stop(); wss.close(); } };
}
