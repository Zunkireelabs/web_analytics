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

export default defineConfig({
  root: 'web',
  base: APP_BASE,
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    proxy: isEmbedded ? undefined : {
      '/api': `http://localhost:${process.env.API_PORT || 3002}`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
