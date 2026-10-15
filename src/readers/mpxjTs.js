/**
 * Reader 1 (default): mpxj-ts, an LGPL TypeScript port of MPXJ, running in
 * the page. It is loaded at runtime from its own file
 * (public/vendor/mpxj-ts/mpxj.mjs) so it stays a separate, replaceable
 * LGPL module and is never bundled into the MIT app code.
 */
let modulePromise = null;

function load() {
  if (!modulePromise) {
    const url = new URL('vendor/mpxj-ts/mpxj.mjs', document.baseURI).href;
    modulePromise = import(/* @vite-ignore */ url);
  }
  return modulePromise;
}

export const mpxjTsReader = {
  id: 'mpxj-ts',
  label: 'mpxj-ts (in-browser .mpp / XML / MPX reader)',
  accepts: (kind) => kind === 'mpp' || kind === 'xml' || kind === 'mpx',
  async read(bytes) {
    const mpxj = await load();
    return mpxj.readProject(bytes);
  },
  /** Exposed so the views can use the library's duration formatting. */
  load,
};
