import { realpathSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, writeFile, symlink, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const label = process.argv[2];
if (!label || !/^[a-z0-9-]{1,48}$/.test(label)) throw new Error('Supply a unique evidence label');
const output = join(desktop, 'qa-evidence', label);
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const tempBase = realpathSync.native(tmpdir());
const scratch = await mkdtemp(join(tempBase, 'solline-recovery-canary-'));
if (
  dirname(scratch) !== resolve(tempBase) ||
  !scratch.startsWith(resolve(tempBase) + sep + 'solline-recovery-canary-')
)
  throw new Error('Unsafe cleanup');
const desktopCopy = join(scratch, 'apps/desktop');
const uiCopy = join(scratch, 'packages/ui');
const junctions = [];
try {
  await mkdir(desktopCopy, { recursive: true });
  await mkdir(uiCopy, { recursive: true });
  for (const item of ['src', 'vitest.config.ts', 'package.json'])
    await cp(join(desktop, item), join(desktopCopy, item), { recursive: true });
  for (const item of ['src', 'test', 'package.json'])
    await cp(join(root, 'packages/ui', item), join(uiCopy, item), { recursive: true });
  for (const [link, target] of [
    [join(scratch, 'node_modules'), join(root, 'node_modules')],
    [join(desktopCopy, 'node_modules'), join(desktop, 'node_modules')],
    [join(uiCopy, 'node_modules'), join(root, 'packages/ui/node_modules')],
  ]) {
    await symlink(target, link, 'junction');
    junctions.push(link);
  }
  const cases = [
    {
      name: 'premature-save',
      cwd: desktopCopy,
      file: 'src/main/ui-recovery.ts',
      before: 'await handle.sync();',
      after: 'void handle.sync();',
      test: 'src/main/ui-recovery.test.ts',
      title: 'does not acknowledge a write before fsync resolves',
    },
    {
      name: 'out-of-order-event',
      cwd: desktopCopy,
      file: 'src/renderer/src/stores/app/recovery.ts',
      before: 'if (event.sequence !== sequence + 1) return false;',
      after: '/* canary: gap accepted */',
      test: 'src/renderer/src/stores/recovery.test.ts',
      title: 'resnapshots gaps instead of accepting an out-of-order event',
    },
    {
      name: 'orphan-pointer-listener',
      cwd: uiCopy,
      file: 'src/bot/gaze.ts',
      before: "window.removeEventListener('pointermove', move);",
      after: '/* canary: abandoned pointer listener */',
      test: 'test/gaze.test.ts',
      title: 'partilha um frame',
    },
  ];
  const results = [];
  for (const entry of cases) {
    const path = join(entry.cwd, entry.file);
    const source = await readFile(path, 'utf8');
    if (!source.includes(entry.before)) throw new Error(`Canary target disappeared: ${entry.name}`);
    await writeFile(path, source.replace(entry.before, entry.after));
    const report = join(output, `${entry.name}.json`);
    const run = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--configLoader',
        'runner',
        entry.test,
        '-t',
        entry.title,
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      {
        cwd: entry.cwd,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, SOLLINE_SKIP_SDK: '1' },
      },
    );
    await writeFile(join(output, `${entry.name}.log`), `${run.stdout ?? ''}\n${run.stderr ?? ''}`);
    const evidence = JSON.parse(await readFile(report, 'utf8'));
    const failures = evidence.testResults
      .flatMap((test) => test.assertionResults)
      .filter((test) => test.status === 'failed');
    if (run.status !== 1 || failures.length !== 1 || !failures[0].fullName.includes(entry.title))
      throw new Error(`Unexpected canary result: ${entry.name}`);
    results.push({
      name: entry.name,
      detected: true,
      assertion: failures[0].fullName,
      messages: failures[0].failureMessages,
    });
    await writeFile(path, source);
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(
    'Recovery fault canaries detected premature acknowledgement, event ordering and abandoned listener.',
  );
} finally {
  // Remove links themselves before recursive cleanup so no shared module target is traversed.
  for (const path of junctions.reverse()) await unlink(path);
  await rm(scratch, { recursive: true, force: true });
}
