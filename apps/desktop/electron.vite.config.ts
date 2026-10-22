import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { IPC } from '../../packages/protocol/src/bridge.ts';

export default defineConfig({
  main: {
    build: {
      // As dependências de runtime (SDK, zod) ficam fora do bundle e vão para node_modules.
      // Os pacotes do workspace entram no bundle.
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
    define: { __SOLLINE_IPC__: JSON.stringify(IPC) },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          recovery: resolve(__dirname, 'src/preload/recovery.ts'),
          prompt: resolve(__dirname, 'src/preload/prompt.ts'),
          attention: resolve(__dirname, 'src/preload/attention.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      minify: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          recovery: resolve(__dirname, 'src/renderer/recovery.html'),
          prompt: resolve(__dirname, 'src/renderer/prompt.html'),
          attention: resolve(__dirname, 'src/renderer/attention.html'),
        },
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
