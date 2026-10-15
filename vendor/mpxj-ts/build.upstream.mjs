/**
 * Builds the Project file reader the MPP Viewer (/mpp-viewer) loads from
 * /vendor/local/mpxj@9/mpxj.mjs, as its own module: the reader is a port of
 * MPXJ and stays under MPXJ's licence (LGPL-2.1), separate from the page,
 * so anyone can rebuild it from this source and swap it in.
 *
 * src/fields.ts is generated from an MPXJ checkout by tools/gen_fields.py.
 * Run from this folder:  node build.mjs
 */
import { build } from '../../node_modules/esbuild/lib/main.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '../../vendor/local/mpxj@9');
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
  banner: { js: '/*! mpxj-ts: Microsoft Project file reader, a port of MPXJ (https://github.com/joniles/mpxj). LGPL-2.1-or-later. Source: https://johnmcm.com/source/mpxj/ */' },
});
fs.copyFileSync(path.join(here, 'LICENSE'), path.join(outDir, 'LICENSE'));
console.log(`built ${path.relative(process.cwd(), path.join(outDir, 'mpxj.mjs'))} (${Math.round(fs.statSync(path.join(outDir, 'mpxj.mjs')).size / 1024)} KB)`);
