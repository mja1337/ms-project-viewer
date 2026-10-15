# MS Project Viewer

A read-only viewer for Microsoft Project plans that runs entirely in the
browser. Click **Open file…**, pick a `.mpp` (or Project XML) file, and see:

- **Task grid:** ID, WBS, outline hierarchy (expand and collapse), name,
  start, finish, duration, % complete, resources and predecessors
- **Gantt chart:** bars, summary bars, milestones (◆), progress, dependency
  arrows (colour-coded FS / SS / FF / SF), zoom from days to years,
  tooltips
- **Dependencies:** every link with predecessor, successor, type and lag
- **Resources:** each resource with type, max units, rate, work and the tasks
  it is assigned to
- **Task details:** click a task to see its resources, predecessors and
  successors (with type and lag) and notes

It is a static site with no server, meant to be hosted on GitHub Pages.
Nothing can be edited or saved.

A proposed plan for adding editing is in [docs/editor-plan.md](docs/editor-plan.md) (not built yet).

## Privacy: files never leave your browser

- The file is read with the browser's File API and parsed in JavaScript on
  your device. There is no upload and no backend.
- The built page carries a Content Security Policy with
  `connect-src 'none'` and `form-action 'none'`, so the page cannot send
  data anywhere, even by mistake.
- All code is served from the site itself: no CDNs, analytics or fonts from
  other sites.
- DHTMLX's hosted MS Project import/export service and Aspose's cloud APIs
  upload files to third parties, so they are **not** used.
- Do not commit plans to this repo. `test-files/` holds only public MPXJ
  samples and a generated, fictional plan.

## Run it locally

Needs Node.js 20 or newer.

```sh
cd ~/Documents/ms-project-viewer
npm install
npm run build && npm run preview
```

Then open http://localhost:4173 and open a file from `test-files/`.
`npm run dev` starts a live-reloading dev server instead (without the CSP).
`dist/` is plain static files, so any static server works, e.g.
`python3 -m http.server -d dist 4173`.

## Supported files

| Input | Reader | Notes |
| --- | --- | --- |
| `.mpp` / `.mpt`, Project 98 to 2024 | mpxj-ts | Tested on MPXJ sample files from Project 98, 2000-2003, 2007 and 2010. |
| Project XML (File › Save As › XML, "MSPDI") | mpxj-ts, falling back to the built-in XML reader | The fallback path for anything the `.mpp` reader can't open. |
| `.mpx` | mpxj-ts | Old Project exchange format. |

Known limits:

- **Password-protected plans can't be opened.** The viewer says so; remove
  the password in Project or save as XML.
- Not read: timephased data, saved views, filters, groups, enterprise custom
  fields, subproject contents. Links to tasks in other projects are left out.
- Dates are shown exactly as Project shows them (Project stores no time zone).
- mpxj-ts is new, single-maintainer code with no published tests. Check it
  against Project on a set of real plans before relying on it.

## How it is built

```
index.html, src/main.js     page shell, file open, tabs
src/readers/index.js         reader registry: the one swappable step
  mpxjTs.js                  reader 1: mpxj-ts, loaded at runtime from public/vendor/mpxj-ts/mpxj.mjs
  mspdiNative.js             reader 2: built-in Project XML reader (MIT, no dependencies)
  remote.js                  reader 3: placeholder for a self-hosted MPXJ converter (off)
src/model.js                 reader output -> view model (successors, links, resource assignments)
src/views/gantt.js           DHTMLX Gantt, read-only
src/views/tables.js          tasks, dependencies, resources, task details
vendor/mpxj-ts/              mpxj-ts source (LGPL), rebuild with `npm run build:mpxj`
scripts/gen-sample-mspdi.mjs makes test-files/generated/sample-garden-build.xml
```

Every reader returns the same `Project` object (the mpxj-ts model in
`vendor/mpxj-ts/src/model.ts`), so a reader can be swapped without touching
the views. If the browser reader ever fails on real plans, enable
`remote.js` against a small MPXJ service on localhost (later a cloud
function in our own tenant) and allow that one origin in the CSP in
`vite.config.js`.

## Licences

- This repo's own code is under the **MIT licence** (`LICENSE`).
- **mpxj-ts** is **LGPL-2.1-or-later** (a port of MPXJ by Jon Iles and
  contributors). It is vendored with its full source in `vendor/mpxj-ts/`
  and shipped as a separate, replaceable file (`vendor/mpxj-ts/mpxj.mjs` in
  the built site), not bundled into the app code. See
  `vendor/mpxj-ts/PROVENANCE.md`.
- **DHTMLX Gantt Community 10.0.3** is MIT.
- MPXJ sample files in `test-files/mpxj/` are LGPL-2.1.

Details: `THIRD_PARTY_NOTICES.md`.

## Hosting and migration plan

1. **Now:** built and reviewed under a personal account (`mja1337`), with no
   company or confidential data anywhere in the repo.
2. **GitHub Pages:** `.github/workflows/pages.yml` builds the site and
   deploys it automatically on every push to `main` via GitHub Actions. It
   can also be run by hand from the Actions tab. Without GitHub Enterprise
   Cloud a Pages site is public, which is fine here: the site holds no plan
   data.
3. **Later:** the repo is intended to move to an organisation account once
   the LGPL dependency has been cleared for use there. Pages can then be
   switched on in that account (privately, if it has Enterprise Cloud).
