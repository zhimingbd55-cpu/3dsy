import { readFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStore } from '../server/store.mjs';
import { validateGlb } from '../server/media.mjs';

const [manifestPath, assetRoot, id, ...flags] = process.argv.slice(2);
if (flags.some(flag => flag !== '--only-item')) throw new Error('Unknown bundled garment import option.');
const dataDirectory = process.env.FITTING_DATA_DIR;
if (!manifestPath || !assetRoot || !id || !dataDirectory) {
  throw new Error('Usage: FITTING_DATA_DIR=<data> node scripts/seed-bundled-garment.mjs <manifest.json> <asset-root> <id> [--only-item]');
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const item = manifest.find(entry => entry.id === id);
if (!item || !/^[a-z0-9-]+$/.test(item.id)) throw new Error('Bundled garment id is invalid or missing.');
const type = item.assetType || (item.sha256?.['original.glb'] ? '3d' : '2d');
if (!['2d','3d'].includes(type)) throw new Error('Bundled garment asset type is invalid.');
const originalName = type === '3d' ? 'original.glb' : 'original.png';
const sourceDirectory = path.join(assetRoot, item.id);
const assets = {};
for (const file of [originalName, 'reference.webp']) {
  const bytes = await readFile(path.join(sourceDirectory, file));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== item.sha256?.[file]) throw new Error(`Bundled garment checksum failed: ${file}`);
  assets[file] = bytes;
}
const reference = assets['reference.webp'];
if (reference.length < 12 || reference.toString('ascii', 0, 4) !== 'RIFF' || reference.toString('ascii', 8, 12) !== 'WEBP' || reference.readUInt32LE(4) + 8 !== reference.length) throw new Error('Bundled reference image is not a complete WebP.');
if (type === '3d') validateGlb(assets[originalName]);

const store = createStore(dataDirectory, { minFreeBytes: 0, migrateBuiltinDetails: !flags.includes('--only-item') });
try {
  const existing = store.get('SELECT * FROM garments WHERE id=?', item.id);
  if (existing?.owner_id) throw new Error('Bundled id is already owned by a visitor.');
  const folder = path.posix.join('files', item.id);
  const original = path.posix.join(folder, originalName);
  const reference = path.posix.join(folder, 'reference.webp');
  store.canWrite(assets[originalName].length + assets['reference.webp'].length);
  await mkdir(store.safeFile(folder), { recursive: true });
  await Promise.all([
    copyFile(path.join(sourceDirectory, originalName), store.safeFile(original)),
    copyFile(path.join(sourceDirectory, 'reference.webp'), store.safeFile(reference))
  ]);
  const mime = type === '3d' ? 'model/gltf-binary' : 'image/png';
  const modelPath = type === '3d' ? original : null;
  store.transaction(() => {
    if (existing) {
      store.run('UPDATE garments SET name=?,category=?,category_known=1,details=?,original_name=?,original_path=?,mime=?,image_path=?,model_path=?,published=1,position=? WHERE id=? AND owner_id IS NULL', item.name, item.category, item.details || '', item.id + (type === '3d' ? '.glb' : '.png'), original, mime, reference, modelPath, item.position, item.id);
    } else {
      store.run('INSERT INTO garments(id,name,category,category_known,details,original_name,original_path,mime,image_path,model_path,published,position,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', item.id, item.name, item.category, 1, item.details || '', item.id + (type === '3d' ? '.glb' : '.png'), original, mime, reference, modelPath, 1, item.position, store.now());
    }
    if (!flags.includes('--only-item')) for (const bundled of manifest) store.run('UPDATE garments SET position=? WHERE id=? AND owner_id IS NULL', bundled.position, bundled.id);
  });
  console.log(JSON.stringify({ id: item.id, name: item.name, assetType: type, position: item.position, originalBytes: assets[originalName].length, referenceBytes: assets['reference.webp'].length, totalBuiltIn: store.get('SELECT COUNT(*) AS count FROM garments WHERE owner_id IS NULL AND published=1').count }));
} finally {
  store.close();
}
