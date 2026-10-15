/**
 * Reader 3 (placeholder, OFF by default): a self-hosted MPXJ converter.
 *
 * If the in-browser reader ever fails on real plans, run a small MPXJ
 * service (on localhost first, later in our own cloud tenant) that turns a
 * project file into the same Project JSON, set `endpoint` below, set
 * `enabled: true`, and relax `connect-src` in vite.config.js's CSP to that
 * one origin. The views do not change.
 *
 * While this is disabled, the page's Content Security Policy blocks every
 * network request, so no file can leave the browser.
 */
export const remoteReader = {
  id: 'remote',
  label: 'Self-hosted converter (not configured)',
  enabled: false,
  auto: false,
  endpoint: null, // e.g. 'http://localhost:8765/convert'
  accepts: () => true,
  async read() {
    throw Object.assign(new Error('The self-hosted converter is not configured.'), { code: 'format' });
  },
};
