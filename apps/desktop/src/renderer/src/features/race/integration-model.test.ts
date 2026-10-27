import { describe, expect, it } from 'vitest';
import type { Race, RaceIntegration, SplitPart } from '@solline/protocol';
import { formatDuration, resolverLane, stepRows, visibleFiles } from './integration-model.ts';

const part = (title: string, zero = false): SplitPart => ({
  title,
  goal: title,
  allowed: [],
  forbidden: [],
  interfaces: '',
  expected: '',
  check: null,
  zero,
});
const lane = (sessionId: string, title: string, zero = false) => ({
  sessionId,
  agent: 'claude',
  model: null,
  state: 'idle' as const,
  part: part(title, zero),
});
const integration = (patch: Partial<RaceIntegration>): RaceIntegration => ({
  state: 'merging',
  tip: { branch: 'b', path: 'p', top: 't', base: 'x' },
  steps: [],
  conflict: null,
  final: null,
  review: null,
  warnings: [],
  metrics: { costUsd: null, slowestMs: 0, totalMs: 0, conflicts: 0, failures: 0 },
  brought: null,
  ...patch,
});
const race = (patch: Partial<Race>): Race => ({
  kind: 'split',
  id: 'r',
  projectId: 'p',
  text: 't',
  phase: 'assembling',
  lanes: [lane('a', 'Base', true), lane('b', 'Ecrã'), lane('c', 'Dados')],
  split: {
    pending: [],
    warnings: [],
    lanes: [
      { sessionId: 'c', index: 2, after: 0, startedAt: 0, settledAt: 1 },
      { sessionId: 'a', index: 0, after: null, startedAt: 0, settledAt: 1 },
      { sessionId: 'b', index: 1, after: 0, startedAt: 0, settledAt: 1 },
    ],
  },
  ...patch,
});

describe('passos da integração', () => {
  it('mostra os passos feitos, a parte a juntar agora e as que esperam, pela ordem do plano', () => {
    const rows = stepRows(
      race({
        integration: integration({
          steps: [
            { sessionId: 'a', title: 'Base', merged: true, conflicts: [], checks: [], failures: 0 },
          ],
        }),
      }),
    );
    expect(rows.map((r) => [r.title, r.status])).toEqual([
      ['Base', 'done'],
      ['Ecrã', 'current'],
      ['Dados', 'waiting'],
    ]);
  });

  it('um conflito pára a lista e nada fica "a juntar"', () => {
    const rows = stepRows(
      race({
        phase: 'done',
        integration: integration({
          state: 'conflict',
          steps: [
            { sessionId: 'a', title: 'Base', merged: true, conflicts: [], checks: [], failures: 0 },
            {
              sessionId: 'b',
              title: 'Ecrã',
              merged: false,
              conflicts: ['x'],
              checks: [],
              failures: 0,
            },
          ],
        }),
      }),
    );
    expect(rows.map((r) => r.status)).toEqual(['done', 'conflict', 'waiting']);
  });

  it('sem integração não há passos', () => {
    expect(stepRows(race({ integration: null }))).toEqual([]);
  });
});

describe('quem resolve o conflito', () => {
  const conflict = { sessionId: 'b', branch: 'x', files: ['f'], resolver: null };
  it('a parte zero, senão a primeira juntada, senão a que chocou', () => {
    const merged = {
      sessionId: 'c',
      title: 'Dados',
      merged: true,
      conflicts: [],
      checks: [],
      failures: 0,
    };
    expect(
      resolverLane(race({ integration: integration({ state: 'conflict', conflict }) }))?.sessionId,
    ).toBe('a');
    const noZero = race({
      lanes: [lane('b', 'Ecrã'), lane('c', 'Dados')],
      integration: integration({ state: 'conflict', conflict, steps: [merged] }),
    });
    expect(resolverLane(noZero)?.sessionId).toBe('c');
    const alone = race({
      lanes: [lane('b', 'Ecrã')],
      integration: integration({ state: 'conflict', conflict }),
    });
    expect(resolverLane(alone)?.sessionId).toBe('b');
    expect(resolverLane(race({ integration: integration({}) }))).toBeUndefined();
  });
});

describe('números em palavras', () => {
  it('durações sem arredondar para parecer melhor', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(45_400)).toBe('45 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
    expect(formatDuration(180_000)).toBe('3 min');
    expect(formatDuration(3_780_000)).toBe('1 h 3 min');
  });

  it('os ficheiros de um conflito: os primeiros e quantos faltam', () => {
    expect(visibleFiles(['a', 'b'], 6)).toEqual({ shown: ['a', 'b'], more: 0 });
    expect(visibleFiles(['a', 'b', 'c'], 2)).toEqual({ shown: ['a', 'b'], more: 1 });
  });
});
