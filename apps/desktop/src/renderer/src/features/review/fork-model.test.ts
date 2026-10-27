import { describe, expect, it } from 'vitest';
import type { Checkpoint } from '@solline/protocol';
import { forkGate, forkTargets, forkTurnAtStop } from './fork-model.ts';

const cp = (index: number, state: Checkpoint['state'] = 'done'): Checkpoint => ({
  turnId: `t${index}`,
  index,
  title: `Turno ${index}`,
  at: 0,
  state,
  stats: { files: 0, additions: 0, deletions: 0 },
});

describe('bifurcar daqui', () => {
  const git = { timeline: { available: true }, workspace: { kind: 'project' } as const };

  it('pode em projetos git, parado, num turno acabado', () => {
    expect(forkGate({ ...git, busy: false, checkpoint: cp(1) })).toEqual({
      enabled: true,
      reason: null,
    });
  });

  it('sem git: "Só em projetos git"', () => {
    expect(
      forkGate({ timeline: { available: false }, workspace: undefined, busy: false }).reason,
    ).toBe('Só em projetos git');
    expect(
      forkGate({ timeline: { available: true }, workspace: { kind: 'shared' }, busy: false })
        .reason,
    ).toBe('Só em projetos git');
    expect(forkGate({ timeline: null, workspace: undefined, busy: false }).enabled).toBe(false);
  });

  it('a trabalhar ou com o turno por acabar, não', () => {
    expect(forkGate({ ...git, busy: true }).reason).toBe('O agente ainda está a trabalhar');
    expect(forkGate({ ...git, busy: false, checkpoint: cp(2, 'running') }).reason).toBe(
      'O turno ainda não acabou',
    );
  });

  it('os turnos vêm do mais recente para o mais antigo', () => {
    expect(forkTargets([cp(1), cp(2), cp(3)]).map((t) => t.index)).toEqual([3, 2, 1]);
  });

  it('"antes do turno N" parte do fim do turno anterior', () => {
    const list = [cp(1), cp(2), cp(3)];
    expect(forkTurnAtStop(list, 0)).toBeUndefined();
    expect(forkTurnAtStop(list, 2)?.turnId).toBe('t2');
    expect(forkTurnAtStop(list, 3)?.turnId).toBe('t3');
  });
});
