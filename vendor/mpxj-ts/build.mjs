/**
 * Rebuilds the vendored mpxj-ts reader into public/vendor/mpxj-ts/mpxj.mjs.
 *
 * mpxj-ts is LGPL-2.1-or-later (a port of MPXJ). It is kept as a separate,
 * replaceable file that the app loads at runtime, never bundled into the
 * MIT-licensed app code. Anyone can rebuild it from vendor/mpxj-ts/src with:
 *
 *   npm run build:mpxj
 *
 * Adapted from upstream build.mjs (kept as build.upstream.mjs) only in its
 * paths: upstream writes to ../../vendor/local/mpxj@9/.
 */
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '../../public/vendor/mpxj-ts');
fs.mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [path.join(here, 'src/index.ts')],
  outfile: path.join(outDir, 'mpxj.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  legalComments: 'inline',
  banner: { js: '/*! mpxj-ts: Microsoft Project file reader, a port of MPXJ (https://github.com/joniles/mpxj). LGPL-2.1-or-later. Source: https://johnmcm.com/source/mpxj/ (vendored copy in vendor/mpxj-ts/src) */' },
});
fs.copyFileSync(path.join(here, 'LICENSE'), path.join(outDir, 'LICENSE'));
console.log(`built ${path.relative(process.cwd(), path.join(outDir, 'mpxj.mjs'))} (${Math.round(fs.statSync(path.join(outDir, 'mpxj.mjs')).size / 1024)} KB)`);
