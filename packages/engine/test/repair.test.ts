import { describe, expect, it } from 'vitest';
import { RepairLoop, normaliseFailure } from '../src/repair/loop.ts';

const fail = (tail = 'expected 1') => ({ id: 'types', state: 'failed' as const, tail });

describe('ciclo de correção', () => {
  it('está desligado e não manda nada', () => {
    const loop = new RepairLoop();
    expect(loop.see({ turnId: 't1', outcomes: [fail()] }).fixId).toBeNull();
    expect(loop.view().state).toBe('off');
  });

  it('para na segunda falha igual e ao fim de 3 correções', () => {
    const loop = new RepairLoop();
    loop.setEnabled(true);
    expect(loop.see({ turnId: 't1', outcomes: [fail()] }).fixId).toBe('types');
    loop.markSent();
    expect(loop.see({ turnId: 't2', outcomes: [fail()] }).fixId).toBeNull();
    expect(loop.view().reason).toContain('duas vezes');
    expect(loop.view().fixes).toBe(1);

    const other = new RepairLoop();
    other.setEnabled(true);
    for (const turn of ['a', 'b', 'c', 'd']) {
      const next = other.see({ turnId: turn, outcomes: [fail(`erro ${turn}`)] });
      if (next.fixId) other.markSent();
    }
    expect(other.view().fixes).toBe(3);
    expect(other.view().state).toBe('stopped');
  });

  it('não repete infraestrutura e só fica feito com a ronda verde', () => {
    const loop = new RepairLoop();
    loop.setEnabled(true);
    expect(
      loop.see({ turnId: 't1', outcomes: [{ id: 'types', state: 'timeout', tail: null }] }).fixId,
    ).toBeNull();
    expect(loop.view().reason).toContain('infraestrutura');

    const ok = new RepairLoop();
    ok.setEnabled(true);
    expect(
      ok.see({ turnId: 't9', outcomes: [{ id: 'types', state: 'passed', tail: null }] }).fixId,
    ).toBeNull();
    expect(ok.view()).toMatchObject({ state: 'done', proofTurnId: 't9' });
    expect(ok.view().reason).toContain('Não houve push');
  });

  it('duas falhas iguais depois de limpar caminhos e horas param o ciclo', () => {
    const loop = new RepairLoop();
    loop.setEnabled(true);
    const first =
      'expected 1\n    at /tmp/solline-abc/src/parser.ts:12:4\n    2026-11-10T10:00:01.250Z\n    durou 1.2s id 6f1e2a9b0c1d';
    const second =
      'expected 1\n    at /private/var/folders/zz/src/parser.ts:40:8\n    11:15:02\n    durou 80ms id a1b2c3d4e5f6';
    expect(normaliseFailure(first)).toBe(normaliseFailure(second));
    expect(loop.see({ turnId: 't1', outcomes: [fail(first)] }).fixId).toBe('types');
    loop.markSent();
    expect(loop.see({ turnId: 't2', outcomes: [fail(second)] }).fixId).toBeNull();
    expect(loop.view().reason).toContain('duas vezes');
  });

  it('uma ronda a meio não dispara correção', () => {
    const loop = new RepairLoop();
    loop.setEnabled(true);
    expect(
      loop.see({
        turnId: 't1',
        outcomes: [
          fail(),
          { id: 'lint', state: 'running', tail: null },
        ],
      }).fixId,
    ).toBeNull();
    expect(loop.view().fixes).toBe(0);
  });
});
