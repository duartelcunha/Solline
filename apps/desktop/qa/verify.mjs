// One immutable evidence directory per independent execution. No retries, no golden updates.
import { spawnSync, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const label = process.argv[2];
if (!label || !/^[a-z0-9-]{1,40}$/.test(label))
  throw new Error('Supply a new evidence label: node qa/verify.mjs final-1');
const output = join(desktop, 'qa-evidence', label);
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Deliberately fails instead of overwriting previous evidence.
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function sources() {
  const paths = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\0')
    .filter(Boolean);
  const result = {};
  for (const path of [...new Set(paths)].sort())
    result[path] = sha(await readFile(join(root, path)));
  return result;
}
const initial = await sources();
const manifest = {
  label,
  startedAt: new Date().toISOString(),
  sourceHash: sha(JSON.stringify(initial)),
  sources: initial,
  base: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  node: process.version,
  platform: process.platform,
  browser: process.env.SOLLINE_QA_BROWSER ?? 'Playwright default',
  steps: [],
  complete: false,
};
const env = {
  ...process.env,
  SOLLINE_SKIP_SDK: '1',
  SOLLINE_E2E_SDK: '0',
  SOLLINE_E2E_CODEX: '0',
  SOLLINE_QA_FRESH: '1',
  SOLLINE_QA_PORT: process.env.SOLLINE_QA_PORT ?? '5185',
  SOLLINE_QA_EVIDENCE: output,
  SOLLINE_SOURCE_HASH: manifest.sourceHash,
};
delete env.SOLLINE_EXE;
delete env.SOLLINE_SHOTS;
async function save() {
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
await save();
async function run(name, args, cwd = desktop) {
  const started = Date.now();
  // Native cases each retain their own deadline. Budget the complete sequential batch
  // separately: process setup/recovery can exceed 15 minutes under concurrent host load.
  const timeoutMs = name === 'electron' ? 1_800_000 : 900_000;
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  await writeFile(join(output, `${name}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  manifest.steps.push({
    name,
    cwd: relative(root, cwd),
    args,
    exitCode: result.status,
    elapsedMs: Date.now() - started,
    timeoutMs,
    error: result.error?.message,
  });
  await save();
  console.log(`${name}: ${result.status === 0 ? 'passed' : 'FAILED'}`);
  if (result.status !== 0) throw new Error(`${name} failed; see ${output}`);
}
try {
  for (const project of ['web', 'node', 'qa'])
    await run(`types-${project}`, [
      '../../node_modules/typescript/bin/tsc',
      '-p',
      `tsconfig.${project}.json`,
    ]);
  for (const name of ['ui', 'protocol', 'engine']) {
    await run(
      `types-${name}`,
      ['../../node_modules/typescript/bin/tsc', '--noEmit'],
      join(root, 'packages', name),
    );
    // Protocol has no standalone test script; its schemas are exercised by engine/bridge tests.
    if (name === 'protocol') continue;
    await run(
      `unit-${name}`,
      ['../../node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'runner', '--maxWorkers=1'],
      join(root, 'packages', name),
    );
  }
  await run('unit-desktop', [
    '../../node_modules/vitest/vitest.mjs',
    'run',
    '--configLoader',
    'runner',
    '--maxWorkers=1',
  ]);
  await run('unit-qa', ['--experimental-strip-types', '--test', 'qa/electron/owned-process.node-test.ts']);
  await run(
    'lint',
    [
      'node_modules/eslint/bin/eslint.js',
      'apps/desktop',
      'packages/ui',
      'packages/protocol',
      'packages/engine',
    ],
    root,
  );
  await run('canary', ['qa/canary.mjs', `${label}-canary`]);
  await run('recovery-canary', ['qa/recovery-canary.mjs', `${label}-recovery-canary`]);
  await run('renderer', [
    '../../node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'playwright.qa.config.ts',
  ]);
  await run('electron-build', [
    '../../node_modules/electron-vite/bin/electron-vite.js',
    'build',
    '--config',
    'electron.qa.config.ts',
  ]);
  await run('electron', [
    '../../node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'playwright.electron-qa.config.ts',
  ]);
  await run('production-build', ['../../node_modules/electron-vite/bin/electron-vite.js', 'build']);
  await run('distribution', ['qa/distribution.mjs']);
  await run('production-smoke', [
    '../../node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'playwright.config.ts',
    '--output',
    join(output, 'production-smoke'),
  ]);
  if (sha(JSON.stringify(await sources())) !== manifest.sourceHash)
    throw new Error('Source changed during verification. Evidence is not a release approval.');
  manifest.complete = true;
} finally {
  manifest.finishedAt = new Date().toISOString();
  const files = {};
  async function inventory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inventory(path);
      else if (!['manifest.json', 'index.html'].includes(entry.name))
        files[relative(output, path).replaceAll('\\', '/')] = sha(await readFile(path));
    }
  }
  await inventory(output);
  manifest.evidence = files;
  await save();
  const links = manifest.steps
    .map(
      (step) =>
        `<li><a href="${step.name}.log">${step.name}</a> — ${step.exitCode === 0 ? 'passed' : 'failed'}</li>`,
    )
    .join('');
  await writeFile(
    join(output, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Solline QA · ${label}</title><style>body{font:16px system-ui;max-width:850px;margin:60px auto;padding:20px;background:#f5f4f1;color:#292827}a{color:#373532}li{margin:12px 0}</style><h1>Solline QA · ${label}</h1><p>${manifest.complete ? 'Automated gates passed. Visual review and external checks remain separate.' : 'Incomplete execution. Do not treat as approval.'}</p><p>Source: ${manifest.sourceHash}</p><a href="manifest.json">Source hashes, environment and evidence integrity</a><ul>${links}</ul><p><a href="renderer-report/index.html">Renderer: screenshots, motion, traces, protocol journals</a></p><p><a href="electron-report/index.html">Electron: real engine and Git effects</a></p>`,
  );
}
