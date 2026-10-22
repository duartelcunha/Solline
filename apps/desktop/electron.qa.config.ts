import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// This config is never imported by the production build or distribution scripts.
export default defineConfig({
  main: {
    plugins: [
      {
        name: 'qa-engine-options',
        enforce: 'pre',
        resolveId(source, importer) {
          if (
            source === './options.ts' &&
            importer?.replaceAll('\\', '/').endsWith('/src/engine/index.ts')
          )
            return resolve(__dirname, 'qa/engine-options.ts');
          return null;
        },
      },
    ],
    build: {
      outDir: 'out/qa-electron/main',
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          engine: resolve(__dirname, 'src/engine/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/qa-electron/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: resolve(__dirname, 'out/qa-electron/renderer'),
      minify: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
    plugins: [react(), tailwindcss()],
  },
});
