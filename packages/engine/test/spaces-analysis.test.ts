import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { collectProject, redact } from '../src/spaces/context.ts';
import { SpaceAnalysis } from '../src/spaces/analysis.ts';
import { SpaceManager } from '../src/spaces/manager.ts';
import { claudeAnalysis } from '../src/spaces/claude-analysis.ts';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const roots: string[] = [];
it('recolher contexto não executa o fsmonitor configurado pelo repositório', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'solline-monitor-'));
  roots.push(root);
  const marker = path.join(root, 'executed.txt');
  const hook = path.join(root, 'monitor.mjs');
  await writeFile(
    hook,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`,
  );
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  execFileSync(
    'git',
    [
      'config',
      'core.fsmonitor',
      `"${process.execPath.replaceAll('\\', '/')}" "${hook.replaceAll('\\', '/')}"`,
    ],
    { cwd: root, windowsHide: true },
  );
  await collectProject({ id: 'p', path: root, name: 'P', trusted: true, addedAt: 0 });
  expect(existsSync(marker)).toBe(false);
});
it('o perfil de análise não disponibiliza ferramentas e recusa alterações mesmo nos hooks', async () => {
  let captured: Options | undefined;
  let closed = false;
  const query = ((args: { options: Options }) => {
    captured = args.options;
    const run = (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: { insights: [], memories: [] },
      };
    })();
    return Object.assign(run, {
      close: () => {
        closed = true;
      },
    });
  }) as never;
  const analyze = claudeAnalysis(undefined, query);
  await analyze({
    agent: 'claude',
    model: '',
    sources: [],
    known: [],
    signal: new AbortController().signal,
  });
  if (!captured) throw new Error('Sem perfil');
  expect(captured.tools).toEqual([]);
  expect(captured.settingSources).toEqual([]);
  expect(captured.strictMcpConfig).toBe(true);
  expect(await captured.canUseTool?.('Bash', { command: 'write' }, {} as never)).toMatchObject({
    behavior: 'deny',
  });
  const hook = captured.hooks?.PreToolUse?.[0]?.hooks[0];
  if (typeof hook !== 'function') throw new Error('Sem guarda');
  expect(
    await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} } as never,
      undefined,
      {} as never,
    ),
  ).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  expect(closed).toBe(true);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('só recolhe código autorizado, sem segredos nem ligações para fora do projeto', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'solline-context-'));
  roots.push(root);
  const outside = await mkdtemp(path.join(tmpdir(), 'solline-outside-'));
  roots.push(outside);
  await writeFile(path.join(root, 'main.ts'), 'export const fine = true;');
  await writeFile(path.join(root, '.env'), 'PASSWORD=hidden');
  await writeFile(path.join(outside, 'outside.ts'), 'private data');
  await symlink(outside, path.join(root, 'escape'), 'junction');
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'node_modules', 'ignored.ts'), 'ignored');
  const result = await collectProject({
    id: 'p',
    path: root,
    trusted: true,
    name: 'P',
    addedAt: 0,
  });
  expect(result.sources.map((s) => s.id)).toEqual(['p:main.ts']);
  expect(redact('const KEY = "sk-abcdefghijklmnopqrstuvwxyz"')).not.toContain('sk-abc');
  expect(redact('{ "accessToken": "example-private-value" }')).not.toContain(
    'example-private-value',
  );
  expect(
    redact('-----BEGIN PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----'),
  ).not.toContain('private-body');
  await expect(
    collectProject({ id: 'p', path: root, trusted: false, name: 'P', addedAt: 0 }),
  ).rejects.toThrow();
});
it('faz análises incrementais, respeita o dia e não repete sugestões dispensadas', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'solline-analysis-'));
  roots.push(root);
  await writeFile(path.join(root, 'main.ts'), 'export const n = 1;');
  let now = 1_000_000;
  let calls = 0;
  const manager = new SpaceManager({
    save: () => {},
    create: async () => 's',
    send: async () => ({ turnId: 't', how: 'sent' }),
    projectOf: () => 'p',
  });
  manager.syncProjects([{ id: 'p', path: root, name: 'P', trusted: true, addedAt: 0 }], root);
  manager.configure({
    analysisMode: 'proactive',
    learningMode: 'approval',
    projectIds: ['p'],
    agent: 'claude',
    model: '',
  });
  const analysis = new SpaceAnalysis({
    manager,
    now: () => now,
    idle: () => true,
    history: () => [],
    run: async () => {
      calls++;
      return {
        insights: [
          {
            projectId: 'p',
            title: 'Melhorar navegação',
            detail: 'O código pode melhorar.',
            sources: ['p:main.ts'],
          },
        ],
        memories: [],
      };
    },
  });
  await analysis.analyze(true);
  expect(calls).toBe(1);
  manager.decideInsight(manager.snapshot().insights[0]!.id, 'dismiss');
  await writeFile(path.join(root, 'main.ts'), 'export const n = 2;');
  await analysis.analyze(true);
  expect(calls).toBe(1);
  now += 86_400_000;
  await analysis.analyze(true);
  expect(calls).toBe(2);
  expect(manager.snapshot().insights).toHaveLength(1);
  await analysis.analyze(false);
  expect(calls).toBe(2);
});
