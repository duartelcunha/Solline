import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { WorktreeManager } from '../src/worktrees/worktrees.ts';

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const gates = vi.hoisted(() => ({
  active: false,
  adds: 0,
  reads: 0,
  firstAdded: () => {},
  releaseFirst: () => {},
  releaseSecond: () => {},
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    file: string,
    args: readonly string[],
    options: import('node:child_process').ExecFileOptions,
    callback: Callback,
  ) => {
    if (!gates.active || !options.env?.GIT_INDEX_FILE)
      return original.execFile(file, args, options, (error, stdout, stderr) =>
        callback(error, String(stdout), String(stderr)),
      );
    const read = args.includes('read-tree') ? ++gates.reads : 0;
    const add = args.includes('add') ? ++gates.adds : 0;
    return original.execFile(file, args, options, (error, stdout, stderr) => {
      let called = false;
      const done = () => {
        if (!called) {
          called = true;
          callback(error, String(stdout), String(stderr));
        }
      };
      if (add === 1) {
        gates.releaseFirst = done;
        gates.firstAdded();
        return;
      }
      if (read === 2) {
        gates.releaseSecond = done;
        gates.releaseFirst();
        return;
      }
      if (args.includes('diff') && gates.adds === 1) {
        done();
        gates.releaseSecond();
        return;
      }
      done();
    });
  };
  return { ...original, execFile };
});

it(
  'duas contagens intercaladas nunca escondem alterações por trazer',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'solline-stats-race-'));
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('solline-stats-race-')
    )
      throw new Error('Invalid cleanup path');
    const project = path.join(root, 'project');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: project, windowsHide: true });
    try {
      await mkdir(project);
      git('init', '-q');
      git('config', 'user.name', 'Solline QA');
      git('config', 'user.email', 'qa@solline.local');
      await writeFile(path.join(project, 'notes.txt'), 'Original\n');
      git('add', '.');
      git('commit', '-qm', 'Initial');
      const manager = new WorktreeManager({ root: path.join(root, 'data') });
      const worktree = await manager.create(project, 'qa');
      if (!worktree) throw new Error('Expected real Git worktree');
      await writeFile(path.join(worktree.cwd, 'notes.txt'), 'Changed\n');
      const added = new Promise<void>((resolve) => {
        gates.firstAdded = resolve;
      });
      gates.active = true;
      gates.adds = 0;
      gates.reads = 0;
      const first = manager.stats(worktree);
      await added;
      // The second read-tree completes after the first add but before its diff.
      const second = manager.stats(worktree);
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.files)).toEqual([1, 1]);
      expect(
        (await readdir(path.dirname(worktree.path))).filter((name) => name.endsWith('.index')),
      ).toEqual([]);
    } finally {
      gates.active = false;
      gates.releaseFirst();
      gates.releaseSecond();
      await rm(root, { recursive: true, force: true });
    }
  },
);
