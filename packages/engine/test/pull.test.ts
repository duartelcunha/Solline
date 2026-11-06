import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCapabilities, Project, SessionStartPayload } from '@solline/protocol';
import type { AdapterSink, AgentAdapter, AgentStartOptions, SendOptions } from '../src/adapters/types.ts';
import { Engine } from '../src/engine.ts';
import { resolveGh, runGh } from '../src/pull/gh.ts';
import { IssueService, issuePrompt, listGithubIssues, openListedIssue } from '../src/pull/issues.ts';
import { PullService, mapChecks } from '../src/pull/pull.ts';
import { repoFromRemote } from '../src/pull/repo.ts';
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

class Talker implements AgentAdapter {
  constructor(
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
    this.sink.delta({ type: 'turn.end', turnId: id, outcome: 'done' });
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

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 })),
  );
});

function realGit(): string {
  return execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
}

async function gitHarness(): Promise<{
  root: string;
  project: string;
  git: string;
  log: string;
  run: (cwd: string, ...args: string[]) => string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'solline-pull-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const log = path.join(root, 'git.log');
  const git = path.join(root, 'git');
  await writeFile(log, '');
  await writeFile(
    git,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_NOSYSTEM=1
exec ${JSON.stringify(realGit())} "$@"
`,
  );
  await chmod(git, 0o755);
  await mkdir(project);
  const run = (cwd: string, ...args: string[]) =>
    execFileSync(git, args, { cwd, encoding: 'utf8' }).trim();
  run(project, 'init', '-q', '-b', 'main');
  run(project, 'config', 'user.name', 'Solline QA');
  run(project, 'config', 'user.email', 'qa@solline.local');
  await writeFile(path.join(project, 'base.txt'), 'base\n');
  run(project, 'add', '.');
  run(project, 'commit', '-qm', 'base');
  return { root, project, git, log, run };
}

const issue = {
  id: 'gh-42',
  projectId: 'atelier',
  provider: 'github' as const,
  key: '42',
  title: 'O parser rejeita o caminho relativo',
  body: '  Abrir a sessão já com este texto.  ',
};

describe('gh', () => {
  it('só aceita um gh numa pasta absoluta do PATH', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'solline-gh-'));
    roots.push(root);
    const dir = path.join(root, 'bin');
    await mkdir(dir);
    await writeFile(path.join(dir, 'gh'), '#!/bin/sh\nexit 0\n');
    expect(resolveGh({ PATH: `rel:${dir}` })).toBe(path.normalize(path.join(dir, 'gh')));
    expect(resolveGh({ PATH: 'rel:./bin' })).toBeNull();
  });

  it('sem gh a lista diz missing e não corre nada', async () => {
    let called = false;
    const list = await listGithubIssues({
      cwd: '/tmp',
      projectId: 'atelier',
      gh: null,
      run: () => {
        called = true;
        return Promise.resolve({ code: 0, stdout: '[]', stderr: '' });
      },
    });
    expect(list).toEqual({ issues: [], unavailable: 'missing' });
    expect(called).toBe(false);
    const relative = await listGithubIssues({
      cwd: '/tmp',
      projectId: 'atelier',
      gh: 'gh',
      run: () => {
        called = true;
        return Promise.resolve({ code: 0, stdout: '[]', stderr: '' });
      },
    });
    expect(relative.unavailable).toBe('missing');
    expect(called).toBe(false);
  });

  it('lista com o gh absoluto e corta o corpo; sem sessão, diz logged-out', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'solline-gh-'));
    roots.push(root);
    const gh = path.join(root, 'gh');
    const log = path.join(root, 'args.log');
    const body = `  texto  ${'x'.repeat(9000)}`;
    const payload = JSON.stringify([{ number: 42, title: '  O parser  ', body }]);
    await writeFile(
      gh,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
printf '%s' ${JSON.stringify(payload)}
`,
    );
    await chmod(gh, 0o755);
    const cwd = path.join(root, 'repo');
    await mkdir(cwd);
    const listed = await listGithubIssues({ cwd, projectId: 'atelier', gh, run: runGh });
    expect(listed.unavailable).toBeNull();
    expect(listed.issues).toHaveLength(1);
    expect(listed.issues[0]).toMatchObject({ id: 'gh-42', key: '42', title: 'O parser' });
    expect(listed.issues[0]?.body.length).toBe(8_000);
    expect(listed.issues[0]?.body.endsWith('…')).toBe(true);
    expect(await readFile(log, 'utf8')).toContain('issue list --json number,title,body --limit 100');

    await writeFile(
      gh,
      `#!/bin/sh
echo "please run: gh auth login" >&2
exit 4
`,
    );
    const out = await listGithubIssues({ cwd, projectId: 'atelier', gh, run: runGh });
    expect(out).toEqual({ issues: [], unavailable: 'logged-out' });
  });
});

describe('commit da worktree', () => {
  it('sem email falha e não grava', async () => {
    const { project, git, log, run, root } = await gitHarness();
    run(project, 'config', '--unset', 'user.email');
    const worktrees = new WorktreeManager({ root: path.join(root, 'wt'), git });
    const made = await worktrees.create(project, 'atelier');
    if (!made) throw new Error('sem worktree');
    await writeFile(path.join(made.path, 'novo.txt'), 'novo\n');
    await writeFile(log, '');
    await expect(worktrees.commitMessage(made, 'fix: o parser')).rejects.toThrow(/user\.email/);
    const trace = await readFile(log, 'utf8');
    expect(trace).not.toMatch(/\bcommit\b/);
    expect(trace).not.toMatch(/\bpush\b/);
    expect(trace).not.toMatch(/\bmerge\b/);
  });

  it('grava com a mensagem, corre o hook e não faz merge nem push', async () => {
    const { project, git, log, root } = await gitHarness();
    const hook = path.join(project, '.git', 'hooks', 'pre-commit');
    const mark = path.join(root, 'hook-ran');
    await writeFile(hook, `#!/bin/sh\necho ran > ${JSON.stringify(mark)}\n`);
    await chmod(hook, 0o755);
    const worktrees = new WorktreeManager({ root: path.join(root, 'wt'), git });
    const made = await worktrees.create(project, 'atelier');
    if (!made) throw new Error('sem worktree');
    await writeFile(path.join(made.path, 'novo.txt'), 'novo\n');
    await writeFile(log, '');
    const saved = await worktrees.commitMessage(made, 'fix: o parser');
    expect(saved.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await readFile(mark, 'utf8')).toBe('ran\n');
    const trace = await readFile(log, 'utf8');
    expect(trace).toContain('commit -m fix: o parser');
    expect(trace).not.toMatch(/\bpush\b/);
    expect(trace).not.toMatch(/\bmerge\b/);
    const clean = await worktrees.commitMessage(made, 'outra');
    expect(clean.sha).toBeNull();
  });
});

describe('abrir uma issue', () => {
  it('a primeira mensagem leva o número, o título e o corpo cortado', () => {
    expect(issuePrompt(issue)).toBe(
      '#42 O parser rejeita o caminho relativo\n\nAbrir a sessão já com este texto.',
    );
    expect(issuePrompt({ ...issue, body: '' })).toBe('#42 O parser rejeita o caminho relativo');
  });

  it('abre a sessão na worktree com o título da issue', async () => {
    const { project, git, root } = await gitHarness();
    const worktrees = new WorktreeManager({ root: path.join(root, 'wt'), git });
    const manager = new SessionManager({
      emit: () => {},
      registry: testRegistry({
        claude: (_options: AgentStartOptions, sink: AdapterSink) => new Talker(sink),
      }),
      worktrees,
    });
    closers.push(() => manager.disposeAll());
    const projectInfo: Project = {
      id: 'atelier',
      path: project,
      name: 'Atelier',
      addedAt: 1,
      trusted: true,
    };
    let start: SessionStartPayload | undefined;
    const opened = await openListedIssue({
      project: projectInfo,
      issueId: 'gh-42',
      list: { issues: [{ ...issue, body: 'Abrir a sessão já com este texto.' }], unavailable: null },
      start: async (payload) => {
        start = payload;
        return (await manager.create(payload)).session.id;
      },
      send: async (sessionId, text) => {
        await manager.send(sessionId, text);
      },
    });
    expect(start?.worktree).toBe('always');
    expect(start?.title).toBe('O parser rejeita o caminho relativo');
    const saved = manager.recovery().find((item) => item.view.session.id === opened.sessionId);
    expect(saved?.view.session.title).toBe('O parser rejeita o caminho relativo');
    expect(saved?.view.session.workspace?.kind).toBe('worktree');
    const text = saved?.view.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.kind === 'text');
    expect(text && 'text' in text ? text.text : '').toContain(
      '#42 O parser rejeita o caminho relativo',
    );
  });

  it('o motor lista pelo serviço injectado e não sai à rede', async () => {
    const engine = new Engine({
      isolated: true,
      checkpoints: false,
      checks: false,
      reviewer: false,
      worktrees: false,
      issues: new IssueService({
        gh: null,
      }),
    });
    engine.spaces.syncProjects(
      [{ id: 'atelier', path: '/tmp/atelier', name: 'Atelier', addedAt: 1, trusted: true }],
      '/tmp',
    );
    const listed = await engine.handle({
      kind: 'request',
      id: '1',
      command: 'issues.list',
      payload: { projectId: 'atelier' },
    });
    expect(listed.ok && listed.result).toEqual({ issues: [], unavailable: 'missing' });
    const refused = await engine.handle({
      kind: 'request',
      id: '2',
      command: 'ci.read',
      payload: { prId: 'gh-pr-7' },
    });
    expect(refused.ok).toBe(false);
    await engine.dispose();
  });
});

describe('PR e CI', () => {
  it('lê o repositório sem o token e sem URL', () => {
    const repo = repoFromRemote('https://user:ghp_secret@github.com/duartelcunha/atelier.git');
    expect(repo).toBe('duartelcunha/atelier');
    expect(repo).not.toContain('ghp_secret');
    expect(repoFromRemote('git@github.com:duartelcunha/atelier.git')).toBe('duartelcunha/atelier');
    expect(repoFromRemote('/tmp/origin.git')).toBeNull();
  });

  it('envia só o branch da worktree, sem merge', async () => {
    const { project, git, log, run, root } = await gitHarness();
    const bare = path.join(root, 'origin.git');
    run(project, 'init', '--bare', '-q', bare);
    run(project, 'remote', 'add', 'origin', bare);
    const worktrees = new WorktreeManager({ root: path.join(root, 'wt'), git });
    const made = await worktrees.create(project, 'atelier');
    if (!made) throw new Error('sem worktree');
    await writeFile(log, '');
    await worktrees.pushBranch(made);
    const trace = await readFile(log, 'utf8');
    expect(trace).toContain(`push --set-upstream origin ${made.branch}`);
    expect(trace).not.toMatch(/\bmerge\b/);
    expect(trace).not.toContain('--force');
  });

  it('abre o PR com o gh absoluto e lê o check falhado, sem rede nem URL', async () => {
    const calls: string[][] = [];
    let ran = false;
    const pulls = new PullService({
      gh: '/tmp/gh',
      run: (_executable, args) => {
        calls.push(args);
        if (args[1] === 'create') {
          return Promise.resolve({
            code: 0,
            stdout: 'https://github.com/duartelcunha/atelier/pull/7\n',
            stderr: '',
          });
        }
        return Promise.resolve({
          code: 1,
          stdout: JSON.stringify([
            {
              name: 'typecheck',
              state: 'FAILURE',
              bucket: 'fail',
              description: 'src/a.ts:1 erro',
              link: 'https://github.com/duartelcunha/atelier/runs/1',
            },
          ]),
          stderr: '',
        });
      },
    });
    const pr = await pulls.open({
      cwd: '/tmp/atelier',
      branch: 'solline/parser-ab12',
      sessionId: 'sessao-1',
      title: 'Corrige o parser',
      body: 'O corpo.',
    });
    expect(pr).toEqual({
      id: 'gh-pr-7',
      sessionId: 'sessao-1',
      key: '7',
      title: 'Corrige o parser',
      state: 'open',
    });
    expect(JSON.stringify(pr)).not.toContain('http');
    expect(calls[0]).toEqual([
      'pr',
      'create',
      '--title',
      'Corrige o parser',
      '--body',
      'O corpo.',
      '--head',
      'solline/parser-ab12',
    ]);
    const ci = await pulls.checks('gh-pr-7');
    expect(ci.checks).toEqual([
      { id: 'ci-typecheck', name: 'typecheck', state: 'failed', summary: 'src/a.ts:1 erro' },
    ]);
    expect(JSON.stringify(ci)).not.toContain('http');
    const missing = new PullService({
      gh: 'gh',
      run: () => {
        ran = true;
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    });
    await expect(
      missing.open({
        cwd: '/tmp/atelier',
        branch: 'solline/parser-ab12',
        sessionId: 'sessao-1',
        title: 't',
        body: '',
      }),
    ).rejects.toThrow('Não encontrei o gh.');
    expect(ran).toBe(false);
    expect(mapChecks([{ name: 'lint', bucket: 'pass', state: 'SUCCESS', description: '' }])[0]?.state).toBe(
      'passed',
    );
  });
});

describe('PR entrado', () => {
  it('lê o estado pelo gh absoluto e arquiva a sessão, sem rede', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'solline-archive-'));
    roots.push(dir);
    const calls: string[][] = [];
    const pulls = new PullService({
      gh: '/tmp/gh',
      run: (_executable, args) => {
        calls.push(args);
        if (args[1] === 'create') {
          return Promise.resolve({
            code: 0,
            stdout: 'https://github.com/duartelcunha/atelier/pull/9\n',
            stderr: '',
          });
        }
        if (args[1] === 'view') {
          return Promise.resolve({ code: 0, stdout: '{"state":"MERGED"}', stderr: '' });
        }
        return Promise.resolve({ code: 0, stdout: '[]', stderr: '' });
      },
    });
    const engine = new Engine({
      isolated: true,
      checkpoints: false,
      checks: false,
      reviewer: false,
      worktrees: false,
      registry: testRegistry({
        claude: (_options, sink) => new Talker(sink),
      }),
      pulls,
    });
    closers.push(() => engine.dispose());
    const started = await engine.handle({
      kind: 'request',
      id: 'start',
      command: 'session.start',
      payload: { projectId: 'atelier', agent: 'claude', cwd: dir, trusted: true },
    });
    if (!started.ok) throw new Error(started.error.message);
    const sessionId = (started.result as { session: { id: string } }).session.id;
    await pulls.open({
      cwd: dir,
      branch: 'solline/parser-ab12',
      sessionId,
      title: 'Corrige o parser',
      body: '',
    });
    const read = await engine.handle({
      kind: 'request',
      id: 'ci',
      command: 'ci.read',
      payload: { prId: 'gh-pr-9' },
    });
    expect(read.ok).toBe(true);
    expect(calls.some((args) => args.join(' ') === 'pr view 9 --json state')).toBe(true);
    const snap = await engine.handle({
      kind: 'request',
      id: 'snap',
      command: 'engine.snapshot',
      payload: {},
    });
    if (!snap.ok) throw new Error('snapshot');
    const sessions = (snap.result as { sessions: { session: { archived?: boolean } }[] }).sessions;
    expect(sessions[0]?.session.archived).toBe(true);
    const sent = await engine.handle({
      kind: 'request',
      id: 'send',
      command: 'session.send',
      payload: { sessionId, text: 'mais uma' },
    });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.message).toContain('para ler');
    const again = await engine.handle({
      kind: 'request',
      id: 'ci-2',
      command: 'ci.read',
      payload: { prId: 'gh-pr-9' },
    });
    expect(again.ok).toBe(true);
    expect(sessions[0]?.session.archived).toBe(true);
  });
});
