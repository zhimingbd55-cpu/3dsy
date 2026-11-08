export type CameraSession = { stream: MediaStream; close: () => void };

export async function openCamera(source: string, onError: (message: string) => void): Promise<CameraSession> {
  if (source !== 'realsense') {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持摄像头，请使用本机 Chrome 或 Edge。');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...(source !== 'default' ? { deviceId: { exact: source } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } });
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => onError('摄像头已断开，请重新连接设备。'));
    return { stream, close: () => stream.getTracks().forEach(track => track.stop()) };
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const context = canvas.getContext('2d', { alpha: false })!;
  const ws = new WebSocket(`ws://${location.host}/api/camera/stream`);
  ws.binaryType = 'blob';
  let closed = false, decoding = false, received = false, stream: MediaStream | null = null;
  const close = () => { closed = true; ws.close(); stream?.getTracks().forEach(track => track.stop()); };
  return await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => { close(); reject(new Error('D455 启动超时，请检查 USB 连接或其他程序是否占用摄像头。')); }, 40000);
    function fail(message: string) { clearTimeout(timeout); if (closed) return; if (!received) { close(); reject(new Error(message)); } else { close(); onError(message); } }
    ws.onmessage = async event => {
      if (typeof event.data === 'string') { try { const payload = JSON.parse(event.data); if (payload.type === 'error') fail(payload.message); } catch {} return; }
      if (decoding || closed) return;
      decoding = true;
      try {
        const image = await createImageBitmap(event.data);
        if (closed) { image.close(); return; }
        // Contain the camera's 16:10 frame in 16:9 without cropping heads/feet.
        const ratio = Math.min(canvas.width / image.width, canvas.height / image.height);
        const width = image.width * ratio, height = image.height * ratio;
        context.fillStyle = '#202622'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        image.close();
        if (!received) { received = true; clearTimeout(timeout); stream = canvas.captureStream(30); resolve({ stream, close }); }
      } catch { fail('D455 画面解码失败，请重新打开摄像头。'); }
      finally { decoding = false; }
    };
    ws.onerror = () => fail('无法连接本机 D455 视频服务。');
    ws.onclose = () => { if (!closed) fail('D455 视频服务已断开。'); };
  });
}

export function cameraError(error: unknown): string {
  const value = error as Error;
  const messages: Record<string, string> = {
    NotAllowedError: '摄像头权限被拒绝。请在浏览器地址栏允许此页面使用摄像头，然后重试。',
    NotFoundError: '没有找到摄像头。请接好 USB 摄像头，或选择 RealSense D455。',
    NotReadableError: '摄像头被占用或无法读取，请关闭其他相机程序后重试。',
    OverconstrainedError: '摄像头不支持当前设置，请重新选择设备或使用 D455 专用接入。',
  };
  return messages[value?.name] || value?.message || '无法打开摄像头。';
}
