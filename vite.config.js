import { defineConfig } from 'vite';

/**
 * Content Security Policy for the built site. connect-src 'none' and
 * form-action 'none' mean the page cannot send anything anywhere: a project
 * file opened here can only be read on the device. (Applied to the build
 * only; Vite's dev server needs a websocket.)
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // the Gantt sets inline styles
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
  "worker-src 'none'",
].join('; ');

export default defineConfig({
  // Relative base so the site works from any GitHub Pages sub-path.
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
  plugins: [
    {
      // DHTMLX's stylesheet pulls the Inter font from fonts.gstatic.com.
      // Strip it so the page makes no third-party requests at all.
      name: 'mspv-no-remote-fonts',
      enforce: 'pre',
      transform(code, id) {
        if (!id.includes('dhtmlxgantt.css')) return null;
        return { code: code.replace(/@font-face\{[^}]*https?:\/\/[^}]*\}/g, ''), map: null };
      },
    },
    {
      name: 'mspv-csp',
      apply: 'build',
      transformIndexHtml(html) {
        return html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
      },
    },
  ],
});
