import { describe, expect, it } from 'vitest';
import type { FileDiff } from '@solline/protocol';
import {
  SessionQuality,
  claudeReviewer,
  fixMessage,
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

const input = { cwd: '/p', diff: DIFF, request: '', trusted: true };

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

  it('pede um JSON com esquema, sem definições num projeto sem confiança', async () => {
    let options: Record<string, unknown> = {};
    const finding = { path: 'a.ts', line: 1, severity: 'bug', title: 'x', detail: 'y' };
    const review = claudeReviewer({
      queryFn: fakeQuery({ findings: [finding] }, (o) => (options = o)),
    });
    expect(await review({ ...input, trusted: false })).toEqual([finding]);
    expect(options).toMatchObject({
      settingSources: [],
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
    const first = q.review('t1', input);
    const second = q.review('t2', input);
    releases[0]!([{ path: 'a.ts', line: 1, severity: 'bug', title: 'velho', detail: '' }]);
    releases[1]!([]);
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
});
