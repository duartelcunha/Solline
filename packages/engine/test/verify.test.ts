import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckSpec, FileDiff } from '@solline/protocol';
import { verify, failures } from '../src/verify/verify.ts';
import { claudeJudge, judgeBothWays, judgePrompt, type Judge } from '../src/verify/judge.ts';
import { WorktreeManager } from '../src/worktrees/worktrees.ts';
import type { RunCommand } from '../src/checks/run.ts';

const spec = (id: string): CheckSpec => ({ id, label: id, command: `run ${id}`, enabled: true });

describe('o Verificador', () => {
  it('passa tudo sem tocar na base', async () => {
    let baselines = 0;
    const run: RunCommand = async () => ({ state: 'passed', tail: null, durationMs: 1 });
    const out = await verify('lane', {
      specs: [spec('lint')],
      run,
      baseline: async () => (baselines++, { cwd: 'base', dispose: async () => undefined }),
    });
    expect(out).toEqual([
      { id: 'lint', label: 'lint', state: 'passed', tail: null, preexisting: false },
    ]);
    expect(baselines).toBe(0);
  });

  it('o que já falhava na base não conta contra a mudança', async () => {
    let disposed = false;
    const run: RunCommand = async (command, { cwd }) => {
      // test falha nas duas pastas (já estava partido); lint só falha na pista.
      if (command === 'run test') return { state: 'failed', tail: 'x', durationMs: 1 };
      if (command === 'run lint' && cwd === 'lane')
        return { state: 'failed', tail: 'y', durationMs: 1 };
      return { state: 'passed', tail: null, durationMs: 1 };
    };
    const out = await verify('lane', {
      specs: [spec('lint'), spec('test')],
      run,
      baseline: async () => ({ cwd: 'base', dispose: async () => void (disposed = true) }),
    });
    expect(out.map((v) => [v.id, v.state, v.preexisting])).toEqual([
      ['lint', 'failed', false],
      ['test', 'failed', true],
    ]);
    expect(failures(out)).toBe(1);
    expect(disposed).toBe(true);
  });

  it('a base é a worktree antes da mudança, e sai ao acabar', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'solline-vf-'));
    try {
      const project = path.join(root, 'p');
      await mkdir(project);
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: project, windowsHide: true });
      git('init', '--quiet', '-b', 'main');
      git('config', 'user.email', 't@solline.local');
      git('config', 'user.name', 'T');
      git('config', 'core.autocrlf', 'false');
      await writeFile(path.join(project, 'a.txt'), 'antes\n');
      git('add', '-A');
      git('commit', '--quiet', '-m', 'i');
      const manager = new WorktreeManager({ root: path.join(root, 'wt') });
      const wt = (await manager.create(project, 'p'))!;
      await writeFile(path.join(wt.cwd, 'a.txt'), 'depois\n');
      const base = await manager.baseline(wt);
      expect(await readFile(path.join(base.cwd, 'a.txt'), 'utf8')).toBe('antes\n');
      await base.dispose();
      expect(
        await stat(base.cwd).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

const diff = (file: string): FileDiff[] => [
  {
    path: file,
    status: 'modified',
    binary: false,
    additions: 1,
    deletions: 0,
    hunks: [
      {
        id: 'h',
        header: '@@ -1 +1,2 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: [{ kind: 'add', text: `// ${file}`, oldNo: null, newNo: 2 }],
      },
    ],
  },
];

describe('o juiz cego', () => {
  const candidates = [
    { id: 'pista-claude', diff: diff('a.ts'), checks: [] },
    { id: 'pista-codex', diff: diff('b.ts'), checks: [] },
  ];

  it('o que o juiz lê não diz de onde vem cada tentativa', () => {
    const prompt = judgePrompt('faz isto', candidates);
    expect(prompt).toContain('## Attempt A');
    expect(prompt).toContain('## Attempt B');
    expect(prompt).not.toMatch(/claude|codex/i);
  });

  it('nas duas ordens: a mesma melhor vale; melhores diferentes é empate', async () => {
    // Um juiz que escolhe sempre o conteúdo de a.ts: consistente nas duas ordens.
    const fair: Judge = async (input) => {
      const order = [...input.candidates]
        .sort((x) => (x.diff[0]!.path === 'a.ts' ? -1 : 1))
        .map((c) => c.id);
      return { order, notes: {} };
    };
    expect((await judgeBothWays(fair, { cwd: '.', request: 'r', candidates })).tie).toBeNull();
    // Um juiz que escolhe sempre a primeira posição: o viés aparece como empate.
    const biased: Judge = async (input) => ({
      order: input.candidates.map((c) => c.id),
      notes: {},
    });
    const verdict = await judgeBothWays(biased, { cwd: '.', request: 'r', candidates });
    expect(verdict.tie).toEqual(['pista-claude', 'pista-codex']);
  });

  it('o juiz Claude responde por letras e volta aos ids; nunca perde uma tentativa', async () => {
    const queryFn = (() =>
      (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          structured_output: {
            order: ['B'],
            notes: [{ attempt: 'B', best: 'simples', worst: 'sem testes' }],
          },
        };
      })()) as never;
    const ranking = await claudeJudge({ queryFn })({ cwd: '.', request: 'r', candidates });
    expect(ranking.order).toEqual(['pista-codex', 'pista-claude']);
    expect(ranking.notes['pista-codex']).toEqual({ best: 'simples', worst: 'sem testes' });
  });
});
