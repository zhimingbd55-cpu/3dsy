import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

export const categories = ['top', 'bottom', 'outfit', 'accessory'];
export const defaultPrompts = {
  top: 'Substitute the upper body garment with the garment in the reference image. Preserve its visible color, shape, fabric, pattern and details.',
  bottom: 'Substitute the lower body garment with the garment in the reference image. Preserve its visible color, shape, fabric, pattern and details.',
  outfit: 'Substitute the outfit with the clothing in the reference image. Preserve its visible color, shape, fabric, pattern and details.',
  accessory: 'Add the accessory in the reference image to the outfit. Preserve its visible color, shape, material and details.',
};
export function createWardrobe(directory) {
  const images = path.join(directory, 'garments');
  const file = path.join(directory, 'wardrobe.json');
  let tail = Promise.resolve();
  const read = async () => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const mutate = (operation) => {
    const result = tail.then(async () => {
      await mkdir(images, { recursive: true });
      const items = await read();
      const value = await operation(items);
      const tmp = `${file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
      await rename(tmp, file);
      return value;
    });
    tail = result.catch(() => {});
    return result;
  };
  return {
    images,
    list: async () => { await tail; return read(); },
    async add(buffer, originalName, metadata = {}) {
      let image, info;
      try {
        const pipeline = sharp(buffer, { limitInputPixels: 40000000, animated: false, failOn: 'error' });
        info = await pipeline.metadata();
        if (!['jpeg', 'png', 'webp'].includes(info.format) || (info.pages || 1) > 1) throw new Error('format');
        image = await pipeline.rotate().resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).webp({ quality: 94 }).toBuffer();
      } catch { throw Object.assign(new Error('图片无法读取。请使用有效的 JPG、PNG 或 WebP，像素总量不超过 4000 万。'), { status: 400 }); }
      const id = randomUUID();
      const category = categories.includes(metadata.category) ? metadata.category : 'top';
      const item = { id, name: String(metadata.name || path.parse(originalName).name || '新衣服').slice(0, 80), category, prompt: String(metadata.prompt || defaultPrompts[category]).slice(0, 700), imageUrl: `/api/garments/${id}/image`, source: metadata.source || 'upload', width: info.width, height: info.height, createdAt: new Date().toISOString() };
      return mutate(async (items) => {
        await writeFile(path.join(images, `${id}.webp`), image);
        items.unshift(item);
        return item;
      });
    },
    update(id, update) {
      return mutate(async (items) => {
        const item = items.find(x => x.id === id);
        if (!item) throw Object.assign(new Error('这件衣服已不存在，请刷新衣橱。'), { status: 404 });
        if (update.name !== undefined) { if (typeof update.name !== 'string' || !update.name.trim()) throw Object.assign(new Error('请填写衣服名称。'), { status: 400 }); item.name = update.name.trim().slice(0, 80); }
        if (update.category !== undefined) { if (!categories.includes(update.category)) throw Object.assign(new Error('无效的服装类别。'), { status: 400 }); item.category = update.category; }
        if (update.prompt !== undefined) { if (typeof update.prompt !== 'string' || !update.prompt.trim() || update.prompt.length > 700) throw Object.assign(new Error('请填写 1–700 字符的服装描述。'), { status: 400 }); item.prompt = update.prompt.trim(); }
        return item;
      });
    },
    remove(id) { return mutate(async (items) => { const index = items.findIndex(x => x.id === id); if (index < 0) throw Object.assign(new Error('衣服不存在。'), { status: 404 }); items.splice(index, 1); await unlink(path.join(images, `${id}.webp`)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }); },
  };
}
