import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// Dev: Vite serves the dashboard on :5173 and proxies /api to the Express server.
// Build: emits static files into web/dist, which the Express server serves in prod.
//
// server/index.js also loads this same config to embed Vite in middleware
// mode inside the Express process itself (one port, no separate `vite`
// process) — VITE_EMBEDDED marks that case so the proxy below is skipped.
// Without this, the embedded instance inherits a "/api" -> this same port
// proxy rule, and any authenticated request to a path no Express router
// matches falls through to Vite's middleware and gets proxied back at
// itself, hanging forever instead of ever getting a response.
const APP_BASE = process.env.APP_BASE || '/';
const isEmbedded = process.env.VITE_EMBEDDED === 'true';

// Page Fixer is a public static page (web/public/page-fixer). Vite only serves a folder's index.html at its full
// path, so /page-fixer would otherwise fall through to the dashboard and its login. Rewrite the clean URL to the file.
const publicPageFixer = {
  name: 'public-page-fixer',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const [path, query] = (req.url || '').split('?');
      if (path === '/page-fixer' || path === '/page-fixer/') req.url = '/page-fixer/index.html' + (query ? `?${query}` : '');
      next();
    });
  },
};

export default defineConfig({
  root: 'web',
  base: APP_BASE,
  plugins: [publicPageFixer, react(), tailwind()],
  server: {
    port: 5173,
    proxy: isEmbedded ? undefined : {
      '/api': `http://localhost:${process.env.API_PORT || 3002}`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Libraries change rarely, the app changes every deploy: keeping them in their own files means a
        // deploy re-downloads only the app, and the browser fetches them in parallel with it.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return 'vendor-react';
          if (/node_modules\/(recharts|d3-[^/]+|victory-vendor|recharts-scale)\//.test(id)) return 'vendor-charts';
          return undefined;
        },
      },
    },
  },
});
