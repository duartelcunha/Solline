import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { AgentCapabilities } from '@solline/protocol';
import type {
  AgentAdapter,
  AdapterSink,
  AgentStartOptions,
  SendOptions,
} from '../src/adapters/types.ts';
import { SessionManager } from '../src/session-manager.ts';
import { WorktreeManager, type Worktree } from '../src/worktrees/worktrees.ts';
import { testRegistry } from './helpers.ts';

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const caps: AgentCapabilities = {
  models: [],
  modes: [],
  effort: false,
  effortOrder: [],
  features: { cost: false, context: false, resume: false, rewind: false },
};
class Writer implements AgentAdapter {
  constructor(
    private readonly options: AgentStartOptions,
    private readonly sink: AdapterSink,
  ) {}
  async start() {
    this.sink.state('idle');
    return { settings: { model: null, effort: null, mode: null }, capabilities: caps };
  }
  async send(text: string, options?: SendOptions) {
    const id = options?.turnId ?? 'turn-1';
    this.sink.delta({
      type: 'turn.start',
      turn: { id, role: 'user', blocks: [{ kind: 'text', id: 'text', text, parentToolId: null }] },
    });
    await writeFile(path.join(this.options.cwd, 'notes.txt'), 'Changed\n');
    return id;
  }
  async interrupt() {}
  async setMode() {}
  async setModel() {}
  async close() {}
  answerPermission() {
    return false;
  }
  capabilities() {
    return caps;
  }
  agentSessionId() {
    return null;
  }
}

/** Only the delivery of the real rename result is held. Git rename/remove/merge remain real. */
class HeldRename extends WorktreeManager {
  readonly renamed = deferred();
  readonly release = deferred();
  named: Worktree | undefined;
  readonly dependentCalls: string[] = [];
  override async rename(worktree: Worktree, title: string): Promise<Worktree> {
    this.named = await super.rename(worktree, title);
    this.renamed.resolve();
    await this.release.promise;
    return this.named;
  }
  // The fixture has exactly one modified file. Keep the lifecycle ordering independent of
  // Git process timing; the separate stats concurrency test covers the real counting path.
  override async stats() {
    return { files: 1, additions: 1, deletions: 1 };
  }
  override async statsOrNone() {
    return { files: 1, additions: 1, deletions: 1 };
  }
  override async remove(
    worktree: Pick<Worktree, 'path' | 'top' | 'branch'>,
    choice: 'always' | 'if-merged' | 'keep',
  ) {
    this.dependentCalls.push(`remove:${worktree.branch}`);
    return super.remove(worktree, choice);
  }
  override async bring(worktree: Worktree, message: string) {
    this.dependentCalls.push(`bring:${worktree.branch}`);
    return super.bring(worktree, message);
  }
}

for (const operation of ['discard', 'bring'] as const) {
  it(
    `renomear termina antes de ${operation}, sem usar uma ref antiga`,
    { timeout: 30_000 },
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'solline-rename-race-'));
      if (
        path.dirname(root) !== path.resolve(tmpdir()) ||
        !path.basename(root).startsWith('solline-rename-race-')
      )
        throw new Error('Invalid cleanup path');
      const project = path.join(root, 'project');
      const worktrees = new HeldRename({ root: path.join(root, 'data') });
      const manager = new SessionManager({
        emit: () => {},
        registry: testRegistry({ claude: (options, sink) => new Writer(options, sink) }),
        worktrees,
      });
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true }).trim();
      try {
        await mkdir(project);
        git('init', '-q', '-b', 'main');
        git('config', 'user.name', 'Solline QA');
        git('config', 'user.email', 'qa@solline.local');
        git('config', 'core.autocrlf', 'false');
        await writeFile(path.join(project, 'notes.txt'), 'Original\n');
        git('add', '.');
        git('commit', '-qm', 'Initial');
        const { session } = await manager.create({
          projectId: 'qa',
          cwd: project,
          agent: 'claude',
          trusted: true,
          worktree: 'always',
        });
        await manager.send(session.id, 'Update the notes');
        await worktrees.renamed.promise;
        const named = worktrees.named;
        if (!named) throw new Error('Rename did not return a worktree');
        expect(git('branch', '--list', named.branch)).toContain(named.branch);
        let settled = false;
        const action = (
          operation === 'discard' ? manager.close(session.id, 'discard') : manager.bring(session.id)
        )
          .then(
            (value) => ({ value, error: null }),
            (error: unknown) => ({ value: null, error: String(error) }),
          )
          .finally(() => {
            settled = true;
          });
        // A single event-loop boundary drains the promise queue. No real-time sleep, retries,
        // filesystem polling or guessed Git timing decides when the rename is released.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const beforeRelease = { settled, calls: [...worktrees.dependentCalls] };
        worktrees.release.resolve();
        const result = await action;
        const branches = git('branch', '--format=%(refname:short)').split('\n');
        const projectText = await readFile(path.join(project, 'notes.txt'), 'utf8');
        console.info(
          JSON.stringify({
            operation,
            beforeRelease,
            result,
            branches,
            named: named.branch,
            projectText,
          }),
        );
        expect(beforeRelease).toEqual({ settled: false, calls: [] });
        expect(result.error).toBeNull();
        if (operation === 'discard') {
          expect(result.value).toMatchObject({ closed: true });
          expect(branches).not.toContain(named.branch);
          expect(
            await stat(named.path).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
          expect(
            (await readdir(path.dirname(named.path))).filter((name) => name.endsWith('.json')),
          ).toEqual([]);
          expect(projectText).toBe('Original\n');
        } else {
          expect(result.value).toMatchObject({ merged: true, conflicts: [] });
          expect(projectText).toBe('Changed\n');
          expect(await readFile(`${named.path}.json`, 'utf8')).toContain(named.branch);
        }
      } finally {
        worktrees.release.resolve();
        await manager.disposeAll();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
