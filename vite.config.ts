import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist', emptyOutDir: true },
  // `npm run dev:web` proxies the API to a running `wrangler dev`.
  server: { proxy: { '/api': 'http://localhost:8799' } },
});
