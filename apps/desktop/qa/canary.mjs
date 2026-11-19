import { realpathSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, writeFile, symlink, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '../..');
const label = process.argv[2] ?? 'canary';
if (!/^[a-z0-9-]{1,48}$/.test(label)) throw new Error('Invalid evidence label');
const output = join(desktop, 'qa-evidence', label);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const tempBase = realpathSync.native(tmpdir());
const scratch = await mkdtemp(join(tempBase, 'solline-canary-'));
const target = join(scratch, 'apps/desktop');
if (!resolve(scratch).startsWith(resolve(tempBase) + sep + 'solline-canary-'))
  throw new Error('Invalid temporary directory');
await mkdir(target, { recursive: true });
const junctions = [];
try {
  // Copy only authored source/config. No user data, secrets or live working tree mutations.
  for (const item of ['src', 'qa', 'vite.qa.config.ts', 'playwright.qa.config.ts', 'package.json'])
    await cp(join(desktop, item), join(target, item), { recursive: true });
  await symlink(join(repo, 'node_modules'), join(scratch, 'node_modules'), 'junction');
  junctions.push(join(scratch, 'node_modules'));
  await symlink(join(desktop, 'node_modules'), join(target, 'node_modules'), 'junction');
  junctions.push(join(target, 'node_modules'));
  const asks = join(target, 'src/renderer/src/features/conversation/asks.tsx');
  const before = await readFile(asks, 'utf8');
  const wrong = before.replaceAll(
    "answer({ decision: 'deny' })",
    "answer({ decision: 'allow-once' })",
  );
  if (wrong === before) throw new Error('Permission canary target disappeared');
  await writeFile(asks, wrong);
  const agents = join(target, 'src/renderer/src/features/agents/agents-panel.tsx');
  const focus = await readFile(agents, 'utf8');
  const brokenFocus = focus.replace(
    'returnFocus.current?.focus({ preventScroll: true });',
    'returnFocus.current = null;',
  );
  if (focus === brokenFocus) throw new Error('Focus canary target disappeared');
  await writeFile(agents, brokenFocus);
  const diff = join(target, 'src/renderer/src/features/review/diff-view.tsx');
  const diffSource = await readFile(diff, 'utf8');
  const hiddenMarker = diffSource.replace("'diff-direction'", "'diff-direction opacity-0'");
  if (hiddenMarker === diffSource) throw new Error('Diff marker canary target disappeared');
  await writeFile(diff, hiddenMarker);
  const reportPath = join(output, 'results.json');
  const result = spawnSync(
    process.execPath,
    [
      join(repo, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config',
      'playwright.qa.config.ts',
      'renderer.spec.ts',
      '--grep',
      'a decisão de negar|o diálogo devolve|marcadores do diff permanecem visíveis',
      '--reporter=json',
    ],
    {
      cwd: target,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 180_000,
      env: {
        ...process.env,
        SOLLINE_QA_PORT: '5179',
        SOLLINE_QA_FRESH: '1',
        SOLLINE_QA_SHARED_ROOT: repo,
        SOLLINE_QA_EVIDENCE: output,
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
      },
    },
  );
  await writeFile(join(output, 'runner.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const specs = report.suites.flatMap(
    (s) => s.specs ?? s.suites?.flatMap((child) => child.specs ?? []) ?? [],
  );
  if (result.status !== 1 || specs.length !== 3 || specs.some((s) => s.ok))
    throw new Error('Canaries did not produce exactly the three expected failures');
  const details = specs.map((s) => ({
    title: s.title,
    errors: s.tests.flatMap((t) => t.results.flatMap((r) => r.errors?.map((e) => e.message) ?? [])),
  }));
  if (
    !details.some((d) => d.errors.some((e) => e.includes('denied') && e.includes('allowed'))) ||
    !details.some((d) => d.errors.some((e) => e.includes('focused') && e.includes('inactive'))) ||
    !details.some(
      (d) => d.title.includes('marcadores do diff') && d.errors.some((e) => e.includes('opacity')),
    )
  )
    throw new Error('Failures were not the intended behavioral assertions');
  await writeFile(
    join(output, 'proof.json'),
    JSON.stringify(
      {
        passed: true,
        sourceHash: process.env.SOLLINE_SOURCE_HASH ?? null,
        originals: {
          permission: createHash('sha256').update(before).digest('hex'),
          focus: createHash('sha256').update(focus).digest('hex'),
          diff: createHash('sha256').update(diffSource).digest('hex'),
        },
        mutations: details,
      },
      null,
      2,
    ),
  );
  console.log('All three intentional defects were detected by their behavioral assertions.');
} finally {
  // Remove junction itself first, so recursive cleanup cannot traverse shared dependencies.
  for (const path of junctions.reverse()) await unlink(path);
  await rm(scratch, { recursive: true, force: true });
}
