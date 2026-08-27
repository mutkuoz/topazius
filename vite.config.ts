import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { resolveBase } from './scripts/base-path';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src https://api.github.com",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'topazius-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html; // dev server: skip, HMR needs inline + ws
        return html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`,
        );
      },
    },
  };
}

export default defineConfig({
  base: resolveBase(process.env),
  plugins: [preact(), csp()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
  },
});
