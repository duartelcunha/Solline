import { describe, expect, it } from 'vitest';
import { hasReading, shownAmount } from './format.ts';
import type { LedgerView } from '@solline/protocol';

describe('consumo visível', () => {
  it('zero reportado fica zero e o em falta fica desconhecido', () => {
    const format = (value: number) => String(value);
    expect(shownAmount(0, format)).toBe('0');
    expect(shownAmount(null, format)).toBe('desconhecido');
  });

  it('sem número reportado não há painel', () => {
    expect(hasReading(null)).toBe(false);
    const empty = {
      executions: [],
      total: { freshInput: null, cachedInput: null, output: null, costUsd: null },
      quota: { status: 'unknown' as const, reason: 'x' },
      budget: {
        maxTurns: null,
        maxMinutes: null,
        turns: 0,
        startedAt: null,
        stop: null,
      },
    } satisfies LedgerView;
    expect(hasReading(empty)).toBe(false);
    expect(hasReading({ ...empty, total: { ...empty.total, costUsd: 0 } })).toBe(true);
  });
});
