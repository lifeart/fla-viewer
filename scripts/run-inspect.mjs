import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '.inspect-bundle.mjs');
await build({
  entryPoints: [resolve(here, 'inspect-binary.ts')],
  bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: out, logLevel: 'warning',
});
await import(pathToFileURL(out).href);
