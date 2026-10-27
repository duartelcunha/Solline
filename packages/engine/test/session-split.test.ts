import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentCapabilities } from '@solline/protocol';
import type {
  AdapterSink,
  AgentAdapter,
  AgentStartOptions,
  SendOptions,
} from '../src/adapters/types.ts';
import { SessionManager } from '../src/session-manager.ts';
import { WorktreeManager } from '../src/worktrees/worktrees.ts';
import { testRegistry } from './helpers.ts';

const caps: AgentCapabilities = {
  models: [],
  modes: [],
  effort: false,
  effortOrder: [],
  features: { cost: false, context: false, resume: false, rewind: false },
};

/** Escreve um ficheiro e responde, como um agente a acabar um turno. */
class Talker implements AgentAdapter {
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
      turn: { id, role: 'user', blocks: [{ kind: 'text', id: 'u', text, parentToolId: null }] },
    });
    await writeFile(path.join(this.options.cwd, 'parte.txt'), 'trabalho da parte\n');
    this.sink.delta({
      type: 'turn.start',
      turn: {
        id: `${id}-a`,
        role: 'assistant',
        blocks: [{ kind: 'text', id: 'a', text: 'Li tudo. Escrevi a parte.', parentToolId: null }],
      },
    });
    this.sink.delta({ type: 'turn.end', turnId: `${id}-a`, outcome: 'done' });
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

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it('uma sessão com startAfter parte do resultado da outra, e laneDigest dá a última resposta', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solline-session-split-'));
  const project = path.join(root, 'project');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  await mkdir(project);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Solline QA');
  git(project, 'config', 'user.email', 'qa@solline.local');
  git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, 'base.txt'), 'base\n');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'Initial');
  const worktrees = new WorktreeManager({ root: path.join(root, 'data') });
  const manager = new SessionManager({
    emit: () => {},
    registry: testRegistry({ claude: (options, sink) => new Talker(options, sink) }),
    worktrees,
  });
  const start = { projectId: 'p', cwd: project, agent: 'claude', trusted: true } as const;
  const first = await manager.create({ ...start, worktree: 'always' });
  expect(manager.laneDigest(first.session.id)).toBe('');
  await manager.send(first.session.id, 'Faz a parte');
  expect(manager.laneDigest(first.session.id)).toBe('Li tudo. Escrevi a parte.');

  const second = await manager.create({
    ...start,
    worktree: 'always',
    startAfter: first.session.id,
  });
  const one = manager.worktreeOf(first.session.id);
  const two = manager.worktreeOf(second.session.id);
  if (!one || !two) throw new Error('Faltam worktrees');
  expect(await readFile(path.join(two.cwd, 'parte.txt'), 'utf8')).toBe('trabalho da parte\n');
  expect(two.base).toBe(git(one.path, 'rev-parse', 'HEAD'));
  expect(second.session.cwd).toBe(two.cwd);
  // Sem a sessão de que parte, não arranca (e não deixa worktrees nem sessões para trás).
  await expect(
    manager.create({ ...start, worktree: 'always', startAfter: 'nao-existe' }),
  ).rejects.toThrow('A parte anterior já não está disponível');
  expect(() => manager.laneDigest('nao-existe')).toThrow();
}, 60_000);
