import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Separate entry: never imported by the production renderer or its preload.
export default defineConfig({
  root: resolve(__dirname, 'qa'),
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.SOLLINE_QA_PORT ?? 5178),
    strictPort: true,
    fs: {
      allow: [
        resolve(__dirname, '../..'),
        ...(process.env.SOLLINE_QA_SHARED_ROOT ? [process.env.SOLLINE_QA_SHARED_ROOT] : []),
      ],
    },
  },
  build: { outDir: resolve(__dirname, 'out/qa'), emptyOutDir: true },
});
