/**
 * Bundles scripts/extract-fla-structure.ts into a single self-contained ESM file
 * (scripts/dist/fla-structure.mjs) with linkedom + jszip + pako inlined, so the
 * issue-#42 reporter can run it with nothing but Node:
 *
 *   node fla-structure.mjs their-file.fla --pretty
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'dist');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(here, 'extract-fla-structure.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // Everything inlined (no `packages: external`) → one portable file.
  // Node built-ins stay external automatically under platform:node.
  // `canvas` is linkedom's OPTIONAL native dep — never used for XML parsing.
  // linkedom guards `require('canvas')` in a try/catch and falls back to a
  // pure-JS shim, so leaving it external means machines without canvas just use
  // the shim. The createRequire banner lets that CJS require work in ESM output.
  external: ['canvas'],
  outfile: resolve(outDir, 'fla-structure.mjs'),
  banner: {
    js:
      '// fla-viewer structure extractor (issue #42 verification build) — self-contained.\n' +
      "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});

console.log('built scripts/dist/fla-structure.mjs');
