export type PreparedImage = {
  readonly file: File;
  readonly previewUrl: string;
  readonly disposed: boolean;
  dispose(): void;
};

export function imageShareFile(blob: Blob, filename: string): File {
  const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : null;
  if (!extension || !blob.size) throw new Error('请使用已生成的 PNG 或 JPEG 图片。');
  const base = filename.replace(/\.(?:png|jpe?g)$/i, '').replace(/[\\/\u0000-\u001f]/g, '-').trim() || '1加衣海报';
  return new File([blob], `${base}.${extension}`, {type: blob.type});
}

export async function prepareImageExport(source: HTMLCanvasElement | Blob, filename: string): Promise<PreparedImage> {
  const blob = source instanceof Blob ? source : await new Promise<Blob>((resolve, reject) => {
    source.toBlob(value => value ? resolve(value) : reject(new Error('海报图片生成失败。')), 'image/png');
  });
  const file = imageShareFile(blob, filename);
  // A real image data URL avoids the blob:-URL long-press incompatibility of some
  // embedded browsers. Prepare it before exposing save/share actions.
  let previewUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('海报图片读取失败。'));
    reader.onerror = () => reject(new Error('海报图片读取失败。'));
    reader.onabort = () => reject(new Error('海报图片读取已取消。'));
    reader.readAsDataURL(file);
  });
  let disposed = false;
  return {file, get previewUrl() {return previewUrl;}, get disposed() {return disposed;}, dispose() {disposed = true;previewUrl = '';}};
}

type ImageShareNavigator = Pick<Navigator, 'share' | 'canShare'> & Partial<Pick<Navigator, 'userAgent'>>;
export function isWeChatBrowser(userAgent: string = navigator.userAgent): boolean {
  return /MicroMessenger/i.test(userAgent);
}
export type ImageShareOutcome = 'shared' | 'cancelled' | 'fallback' | 'ignored';
export function createImageShareController(options: {
  file: File;
  onSaveView(): void;
  onBusyChange?(busy: boolean): void;
  navigator?: ImageShareNavigator;
}) {
  let active = true, busy = false;
  const shareNavigator = options.navigator ?? navigator;
  const fallback = (): ImageShareOutcome => {if (active) options.onSaveView();return 'fallback';};
  const failure = (error: unknown): ImageShareOutcome => {
    if (!active) return 'ignored';
    return (error as {name?: string} | null)?.name === 'AbortError' ? 'cancelled' : fallback();
  };
  return {
    share(): Promise<ImageShareOutcome> {
      if (!active || busy) return Promise.resolve('ignored');
      // Embedded WeChat can expose Web Share without a usable file-share UI.
      // Open its image workflow on this click, never await that native bridge.
      if (isWeChatBrowser(shareNavigator.userAgent ?? '')) return Promise.resolve(fallback());
      const data: ShareData = {files: [options.file]};
      // Do not mix text, title or URL into an image share. The separate copy-link
      // action is responsible for links. Call share before yielding activation.
      try {
        if (typeof shareNavigator.share !== 'function' || typeof shareNavigator.canShare !== 'function' || !shareNavigator.canShare(data)) return Promise.resolve(fallback());
      } catch {return Promise.resolve(fallback());}
      busy = true;options.onBusyChange?.(true);
      const settled = () => {busy = false;if (active) options.onBusyChange?.(false);};
      try {
        const pending = shareNavigator.share(data);
        // A non-standard WebView bridge returning nothing is not a successful
        // share. Keep the image available instead of silently reporting success.
        if (!pending || typeof pending.then !== 'function') {
          const outcome = fallback();settled();return Promise.resolve(outcome);
        }
        return Promise.resolve(pending).then<ImageShareOutcome, ImageShareOutcome>(() => active ? 'shared' : 'ignored', failure).finally(settled);
      } catch (error) {
        const outcome = failure(error);settled();return Promise.resolve(outcome);
      }
    },
    dispose() {active = false;},
    get busy() {return busy;}
  };
}

export function openImageSaveView(image: PreparedImage, options: {title?: string;alt?: string;mode?: 'save' | 'share';showDownload?: boolean;onClose?(): void} = {}) {
  if (image.disposed || !image.previewUrl) throw new Error('图片已关闭，请重新打开海报。');
  const dialog = document.createElement('dialog');dialog.className = 'image-save-dialog';
  dialog.innerHTML = '<header><h2></h2><button type="button" data-image-close aria-label="关闭图片">×</button></header><p class="image-save-instruction">长按下方图片，选择“保存图片”</p><div class="image-save-picture"></div><p class="image-save-note">发送给好友时，可从手机相册选择这张图片。</p><details class="image-file-fallback"><summary>其他保存方式</summary><a data-image-download>下载图片文件</a><p>此方式保存到浏览器下载位置，并非直接存入相册。</p><p data-image-download-status role="status"></p></details>';
  const sharing = options.mode === 'share';
  dialog.dataset.imageMode = sharing ? 'share' : 'save';
  dialog.querySelector('h2')!.textContent = options.title ?? (sharing ? '分享海报图片' : '保存海报图片');
  if (sharing) {
    dialog.querySelector('.image-save-instruction')!.textContent = isWeChatBrowser()
      ? '长按海报，选择“转发给朋友”'
      : '长按海报保存，再从微信相册发送';
    dialog.querySelector('.image-save-note')!.textContent = isWeChatBrowser()
      ? '长按后，点击微信菜单里的“转发给朋友”。也可以选择“保存图片”，再从聊天“＋ → 相册”发送。若菜单不同，请使用其中的图片分享或保存选项。'
      : '若长按没有保存选项，可使用下方“其他保存方式”。在微信聊天的“＋ → 相册”中选择图片发送。';
  }
  const picture = document.createElement('img');picture.src = image.previewUrl;picture.alt = options.alt ?? '1➕衣海报';picture.draggable = false;
  dialog.querySelector('.image-save-picture')!.append(picture);
  const download = dialog.querySelector<HTMLAnchorElement>('[data-image-download]')!;download.href = image.previewUrl;download.download = image.file.name;
  if(options.showDownload){
    dialog.querySelector<HTMLDetailsElement>('.image-file-fallback')!.open=true;
    dialog.querySelector('.image-file-fallback summary')!.textContent='电脑保存 PNG 图片';
    download.textContent='下载 PNG 图片';
  }
  download.onclick = () => {dialog.querySelector('[data-image-download-status]')!.textContent = '已请求下载图片文件，请在浏览器下载记录中查看。';};
  let active = true;
  const cleanup = () => {if (!active) return;active = false;picture.removeAttribute('src');download.removeAttribute('href');dialog.remove();options.onClose?.();};
  const close = () => {if (dialog.open) dialog.close();cleanup();};
  dialog.querySelector<HTMLButtonElement>('[data-image-close]')!.onclick = close;
  dialog.addEventListener('close', cleanup, {once: true});dialog.addEventListener('cancel', cleanup, {once: true});
  document.body.append(dialog);dialog.showModal();
  return {dialog, close};
}
