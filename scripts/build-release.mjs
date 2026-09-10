import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createPackage, ASSET_NAME } from '../int-helper/prototype-bridge/src/updater.mjs';
const output = resolve(process.argv[2] || 'release');
await mkdir(output, { recursive: true });
const payload = await createPackage(fileURLToPath(new URL('../', import.meta.url)));
await writeFile(join(output, ASSET_NAME), JSON.stringify(payload));
console.log('Built ' + payload.version + ': ' + payload.files.length + ' files → ' + join(output, ASSET_NAME));
