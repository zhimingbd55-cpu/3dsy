import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config, root } from '../server/config.mjs';

const assetRoot = path.join(root, 'assets', 'garments');
const manifestPath = path.join(assetRoot, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const { id } of manifest) {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'seed-bundled-garment.mjs'), manifestPath, assetRoot, id, '--only-item'], {
    env: { ...process.env, FITTING_DATA_DIR: config.dataDirectory },
    stdio: 'inherit',
  });
}
