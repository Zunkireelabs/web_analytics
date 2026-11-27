// Local-only: serves the real LivePreview component with example drafts. Run with the command in README.md. Nothing here is part of the product.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react(), tailwind()],
  server: { port: 5199, strictPort: true, proxy: { '/api': 'http://localhost:3099' }, fs: { allow: ['../..'] } },
});
