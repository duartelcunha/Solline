import { defineConfig } from 'vitest/config';

// Testes unitários do main (Node puro, sem Electron). O smoke da app vive em e2e/ (Playwright).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
