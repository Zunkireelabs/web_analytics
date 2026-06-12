import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// Dev: Vite serves the dashboard on :5173 and proxies /api to the Express server.
// Build: emits static files into web/dist, which the Express server serves in prod.
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${process.env.API_PORT || 3002}`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
