import { describe, expect, it } from 'vitest';
import { SessionLedger } from '../src/ledger/ledger.ts';

describe('livro de custo', () => {
  it('não soma dois totais acumulados', () => {
    const ledger = new SessionLedger();
    ledger.observe({ freshInput: 10, cachedInput: 4, output: 2, costUsd: 0.5, model: 'haiku' });
    ledger.observe({ freshInput: 12, cachedInput: 4, output: 3, costUsd: 0.6 });
    const view = ledger.view();
    expect(view.executions).toHaveLength(1);
    expect(view.total).toEqual({ freshInput: 12, cachedInput: 4, output: 3, costUsd: 0.6 });
    expect(view.executions[0]?.spent.freshInput).toBe(12);
  });

  it('um campo em falta não vira zero, e zero reportado fica zero', () => {
    const ledger = new SessionLedger();
    ledger.observe({ freshInput: 0, output: 0 });
    expect(ledger.view().total).toEqual({
      freshInput: 0,
      cachedInput: null,
      output: 0,
      costUsd: null,
    });
    expect(JSON.stringify(ledger.view().total.cachedInput)).toBe('null');
  });

  it('um total que desce abre outra execução e não duplica', () => {
    const ledger = new SessionLedger();
    ledger.observe({ freshInput: 15, cachedInput: 1, output: 4, costUsd: 1 });
    ledger.observe({ freshInput: 4, cachedInput: 0, output: 1, costUsd: 0.2 });
    const view = ledger.view();
    expect(view.executions.map((item) => item.kind)).toEqual(['session', 'resume']);
    expect(view.total.freshInput).toBe(19);
    expect(view.total.costUsd).toBeCloseTo(1.2);
  });

  it('um subagente não entra na soma da sessão', () => {
    const ledger = new SessionLedger();
    ledger.observe({ freshInput: 100, cachedInput: 0, output: 10, costUsd: 2 });
    ledger.observe({
      subagentId: 'consulta-1',
      freshInput: 40,
      cachedInput: 0,
      output: 5,
      costUsd: 0.4,
    });
    const view = ledger.view();
    expect(view.total.freshInput).toBe(100);
    expect(view.executions.find((item) => item.kind === 'subagent')?.spent.freshInput).toBe(40);
  });

  it('retomar a partir do livro guardado não duplica o próximo total', () => {
    const first = new SessionLedger();
    first.observe({ freshInput: 10, cachedInput: 2, output: 1, costUsd: 0.3 });
    const restored = SessionLedger.fromView(first.view());
    restored.observe({ freshInput: 14, cachedInput: 2, output: 2, costUsd: 0.4 });
    expect(restored.view().total.freshInput).toBe(14);
    expect(restored.view().executions).toHaveLength(1);
  });

  it('a quota fica desconhecida e o custo reportado não é uma estimativa', () => {
    const ledger = new SessionLedger();
    ledger.observe({ freshInput: 10, cachedInput: 0, output: 5, model: 'haiku', costUsd: 1 });
    expect(ledger.view().quota.status).toBe('unknown');
    expect(ledger.view().total.costUsd).toBe(1);
    expect('estimateUsd' in ledger.view()).toBe(false);
  });

  it('o limite pára antes do próximo turno e não no meio', () => {
    const ledger = new SessionLedger();
    ledger.setBudget({ maxTurns: 1, maxMinutes: null });
    expect(ledger.gate(0).ok).toBe(true);
    ledger.noteTurn(1_000);
    const blocked = ledger.gate(2_000);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('turns');
    const timed = new SessionLedger();
    timed.setBudget({ maxTurns: null, maxMinutes: 1 });
    expect(timed.gate(0).ok).toBe(true);
    timed.noteTurn(0);
    expect(timed.gate(30_000).ok).toBe(true);
    const later = timed.gate(60_000);
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.text).toContain('a meio');
  });
});
