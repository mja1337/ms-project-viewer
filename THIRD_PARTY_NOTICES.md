# Third-party notices

| Component | Version | Licence | Where | How it is used |
| --- | --- | --- | --- | --- |
| mpxj-ts (port of MPXJ) | snapshot of 13 Oct 2026, ported from MPXJ commit `3f9244a` | LGPL-2.1-or-later | `vendor/mpxj-ts/` (source), `public/vendor/mpxj-ts/mpxj.mjs` (built) | Loaded at runtime as a separate module; not bundled into the app. See `vendor/mpxj-ts/PROVENANCE.md`. |
| MPXJ test files | from `joniles/mpxj` master, 15 Oct 2026 | LGPL-2.1 | `test-files/mpxj/` | Test data only; not part of the built site. |
| DHTMLX Gantt (Community edition) | 10.0.3 | MIT | npm `dhtmlx-gantt`, bundled into `dist/` | Gantt chart and task grid. Its export/import services (export.dhtmlx.com) are not used, and the page's CSP blocks all network requests. |
| Vite | 8.3.4 | MIT | dev dependency | Build tool only. |
| esbuild | 0.28.2 | MIT | dev dependency | Rebuilds `mpxj.mjs` from source (`npm run build:mpxj`). |

## LGPL notes for mpxj-ts

- The reader stays a separate file, `vendor/mpxj-ts/mpxj.mjs` in the built
  site, that users can replace with their own build of the same source.
- Its complete source is in `vendor/mpxj-ts/src`, with the LGPL text in
  `vendor/mpxj-ts/LICENSE` (also copied next to the built file).
- No changes have been made to the mpxj-ts source. If you change it, publish
  the changes under the LGPL.
- Have the adopting organisation's legal team confirm the LGPL is acceptable
  before the tool is used inside a company (open question from the research).
