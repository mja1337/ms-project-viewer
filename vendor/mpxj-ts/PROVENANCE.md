# mpxj-ts: where this copy came from

- **What:** mpxj-ts, the TypeScript port of MPXJ's Microsoft Project readers
  behind johnmcm.com's MPP Viewer.
- **Source:** https://johnmcm.com/source/mpxj/ (not published on npm or GitHub).
- **Downloaded:** 15 Oct 2026. Upstream file dates run to 13 Oct 2026; upstream
  README says it was ported from MPXJ commit
  `3f9244a9c49b052300c2500545cb5ea65340792b` (6 Oct 2026).
- **Licence:** GNU LGPL 2.1 or later (see `LICENSE`, unchanged from upstream).
  Derived from MPXJ (https://github.com/joniles/mpxj), Copyright (c) 2000-2026
  Jon Iles and the MPXJ contributors.
- **Changes made here:** none to `src/` or `tools/`. `build.mjs` is a copy of
  upstream `build.upstream.mjs` with only the output path changed
  (`public/vendor/mpxj-ts/mpxj.mjs`) and esbuild imported from this repo's
  `node_modules`.
- **How it is used:** the app loads `public/vendor/mpxj-ts/mpxj.mjs` as a
  separate ES module at runtime (`src/readers/mpxjTs.js`). It is not bundled
  into the app, so it can be rebuilt from this source (`npm run build:mpxj`)
  or replaced with a newer or modified version without touching the app.
  If you change anything in `src/`, publish those changes under the LGPL.
