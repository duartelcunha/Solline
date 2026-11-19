import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
const evidence = process.env.SOLLINE_QA_EVIDENCE;
export default defineConfig({
  testDir: './qa/electron',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  outputDir: evidence ? join(evidence, 'electron-artifacts') : 'test-results/electron-qa',
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: evidence ? join(evidence, 'electron-report') : 'qa-electron-report',
        open: 'never',
      },
    ],
    [
      'json',
      {
        outputFile: evidence ? join(evidence, 'electron.json') : 'qa-evidence/latest-electron.json',
      },
    ],
  ],
  use: { trace: 'on' },
});
