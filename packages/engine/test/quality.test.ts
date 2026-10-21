import { describe, expect, it } from 'vitest';
import type { FileDiff } from '@solline/protocol';
import {
  SessionQuality,
  claudeReviewer,
  fixMessage,
  insideProject,
  promptFor,
  readOnly,
  unifiedDiff,
  type Reviewer,
} from '../src/index.ts';

const DIFF: FileDiff[] = [
  {
    path: 'a.ts',
    status: 'modified',
    binary: false,
    additions: 1,
    deletions: 1,
    hunks: [
      {
        id: 'h',
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: 'del', text: 'const x = 1;', oldNo: 1, newNo: null },
          { kind: 'add', text: 'const x = 2;', oldNo: null, newNo: 1 },
        ],
      },
    ],
  },
];

const input = { cwd: '/p', diff: DIFF, request: '' };
const ready = () => Promise.resolve(input);

function fakeQuery(output: unknown, seen?: (options: Record<string, unknown>) => void) {
  return ((args: { options: Record<string, unknown> }) => {
    seen?.(args.options);
    return (async function* () {
      yield { type: 'result', subtype: 'success', structured_output: output };
    })();
  }) as never;
}

describe('revisor', () => {
  it('o prompt leva o pedido e o diff unificado', () => {
    expect(unifiedDiff(DIFF)).toBe(
      ['--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-const x = 1;', '+const x = 2;'].join('\n'),
    );
    expect(promptFor({ diff: DIFF, request: 'muda o x' })).toContain('muda o x');
  });

  it('só deixa ler: escrever ou correr comandos é recusado', async () => {
    const opts = { signal: new AbortController().signal, toolUseID: 't' } as never;
    expect(await readOnly('Read', { file_path: 'a' }, opts)).toMatchObject({ behavior: 'allow' });
    expect(await readOnly('Edit', {}, opts)).toMatchObject({ behavior: 'deny' });
    expect(await readOnly('Bash', {}, opts)).toMatchObject({ behavior: 'deny' });
  });

  it('pede um JSON com esquema, só com as três ferramentas e sem definições nem MCP', async () => {
    let options: Record<string, unknown> = {};
    const finding = { path: 'a.ts', line: 1, severity: 'bug', title: 'x', detail: 'y' };
    const review = claudeReviewer({
      queryFn: fakeQuery({ findings: [finding] }, (o) => (options = o)),
    });
    expect(await review(input)).toEqual([finding]);
    expect(options).toMatchObject({
      settingSources: [],
      tools: ['Read', 'Grep', 'Glob'],
      strictMcpConfig: true,
      allowedTools: ['Read', 'Grep', 'Glob'],
      outputFormat: { type: 'json_schema' },
      persistSession: false,
    });
  });

  it('uma resposta fora do formato é um erro, não achados inventados', async () => {
    await expect(claudeReviewer({ queryFn: fakeQuery({ nada: true }) })(input)).rejects.toThrow(
      'formato',
    );
  });
});

describe('estado da segunda opinião', () => {
  it('um turno novo cancela a revisão do anterior', async () => {
    const releases: ((v: Awaited<ReturnType<Reviewer>>) => void)[] = [];
    const reviewer: Reviewer = () => new Promise((resolve) => releases.push(resolve));
    const states: string[] = [];
    const q = new SessionQuality({
      reviewer,
      enabled: true,
      emit: (s) => states.push(s.review.state),
    });
    const first = q.review('t1', ready);
    const second = q.review('t2', ready);
    // O primeiro nem chega ao revisor: foi cancelado enquanto o diff chegava.
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toHaveLength(1);
    releases[0]!([]);
    await Promise.all([first, second]);
    expect(q.state.review).toMatchObject({ state: 'done', turnId: 't2', findings: [] });
    expect(states).toEqual(['running', 'running', 'done']);
  });

  it('a mensagem de corrigir diz onde e o quê', () => {
    const message = fixMessage([
      {
        id: '1',
        path: 'a.ts',
        line: 3,
        severity: 'risk',
        title: 'Erro engolido',
        detail: 'Mostra-o.',
      },
      {
        id: '2',
        path: 'b.ts',
        line: null,
        severity: 'slop',
        title: 'Comentário a mais',
        detail: '',
      },
    ]);
    expect(message).toContain('1. [risco] a.ts:3: Erro engolido');
    expect(message).toContain('   Mostra-o.');
    expect(message).toContain('2. [ruído] b.ts: Comentário a mais');
  });

  it('desligar a meio não deixa a revisão presa em "a rever"', async () => {
    const reviewer: Reviewer = () => new Promise(() => undefined);
    const q = new SessionQuality({ reviewer, enabled: true, emit: () => undefined });
    void q.review('t1', ready);
    await Promise.resolve();
    q.setEnabled(false);
    expect(q.state.review.state).toBe('idle');
    q.setEnabled(true);
    expect(q.state.review.state).toBe('idle');
  });

  it('uma falha a preparar o diff fica à vista como erro', async () => {
    const q = new SessionQuality({
      reviewer: async () => [],
      enabled: true,
      emit: () => undefined,
    });
    await q.review('t1', () => Promise.reject(new Error('git trancado')));
    expect(q.state.review).toMatchObject({ state: 'error', error: 'git trancado' });
  });

  it('um turno novo cancela o anterior mesmo com o diff ainda a chegar', async () => {
    let release: (value: typeof input) => void = () => undefined;
    const slow = () => new Promise<typeof input>((resolve) => (release = resolve));
    const calls: string[] = [];
    const reviewer: Reviewer = async (i) => (calls.push(i.request), []);
    const q = new SessionQuality({ reviewer, enabled: true, emit: () => undefined });
    const old = q.review('t1', slow);
    await q.review('t2', () => Promise.resolve({ ...input, request: 'novo' }));
    release({ ...input, request: 'velho' });
    await old;
    expect(calls).toEqual(['novo']);
    expect(q.state.review.turnId).toBe('t2');
  });
});

describe('o revisor não sai da pasta do projeto', () => {
  const root = process.platform === 'win32' ? 'C:\\p' : '/p';
  const guard = insideProject(root);
  const ask = (tool_name: string, tool_input: Record<string, unknown>) =>
    guard(
      { hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' } as never,
      't',
      { signal: new AbortController().signal },
    );
  const denied = (out: unknown) =>
    (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision === 'deny';

  it('lê dentro, recusa fora e recusa tudo o que não seja ler', async () => {
    expect(denied(await ask('Read', { file_path: 'src/a.ts' }))).toBe(false);
    expect(denied(await ask('Grep', { pattern: 'x' }))).toBe(false);
    expect(denied(await ask('Read', { file_path: '../.ssh/id_rsa' }))).toBe(true);
    expect(denied(await ask('Read', { file_path: '/etc/passwd' }))).toBe(true);
    expect(denied(await ask('Glob', { pattern: '/Users/**' }))).toBe(true);
    expect(denied(await ask('Bash', { command: 'rm -rf .' }))).toBe(true);
    expect(denied(await ask('Edit', { file_path: 'a.ts' }))).toBe(true);
    // A resposta em JSON passa por uma ferramenta do SDK: tem de passar.
    expect(denied(await ask('StructuredOutput', { findings: [] }))).toBe(false);
  });
});
