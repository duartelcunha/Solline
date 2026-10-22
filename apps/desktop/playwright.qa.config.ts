import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
const baseURL = `http://127.0.0.1:${process.env.SOLLINE_QA_PORT ?? 5178}`;
const evidence = process.env.SOLLINE_QA_EVIDENCE;

export default defineConfig({
  testDir: './qa/tests',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 1,
  retries: 0,
  outputDir: evidence ? join(evidence, 'renderer-artifacts') : './test-results/qa',
  reporter: [
    ['list'],
    [
      'html',
      { outputFolder: evidence ? join(evidence, 'renderer-report') : 'qa-report', open: 'never' },
    ],
    [
      'json',
      {
        outputFile: evidence ? join(evidence, 'renderer.json') : 'qa-evidence/latest-renderer.json',
      },
    ],
  ],
  use: {
    baseURL,
    launchOptions: { executablePath: process.env.SOLLINE_QA_BROWSER },
    viewport: { width: 1200, height: 780 },
    locale: 'pt-PT',
    timezoneId: 'Europe/Lisbon',
    trace: 'on',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      process.env.SOLLINE_QA_FRESH === '1'
        ? 'node qa/serve.mjs'
        : 'node ../../node_modules/vite/bin/vite.js --config vite.qa.config.ts',
    url: baseURL,
    reuseExistingServer: process.env.SOLLINE_QA_FRESH !== '1',
    timeout: 120_000,
  },
});
