import { describe, expect, it } from 'vitest';
import type { EngineEvent, SessionState } from '@solline/protocol';
import { AttentionTracker, agentLabel } from './attention.ts';

const state = (sessionId: string, value: SessionState): EngineEvent => ({
  kind: 'event',
  type: 'session.state',
  sessionId,
  state: value,
});

function tracker() {
  const t = new AttentionTracker();
  t.track({ id: 's1', agent: 'claude', state: 'idle' }, 'solline');
  return t;
}

describe('avisos fora da app', () => {
  it('avisa quando precisa de ti ou acaba um turno, só sem foco', () => {
    const t = tracker();
    expect(t.observe(state('s1', 'running'), false)).toBeNull();
    expect(t.observe(state('s1', 'needs-you'), false)).toEqual({
      sessionId: 's1',
      title: 'Claude · solline',
      body: 'Precisa de ti',
      urgent: true,
    });
    expect(t.observe(state('s1', 'running'), false)).toBeNull();
    expect(t.observe(state('s1', 'idle'), false)).toMatchObject({
      body: 'Turno acabado',
      urgent: false,
    });
  });

  it('um pedido de perguntar a outro agente ou delegar avisa como um pedido de permissão', () => {
    const t = tracker();
    const consult = (sessionId: string): EngineEvent => ({
      kind: 'event',
      type: 'consult.request',
      sessionId,
      request: {
        id: 'c1',
        kind: 'ask',
        sessionId,
        from: 'claude',
        to: 'codex',
        summary: 'O Claude quer perguntar ao Codex',
        text: 'Onde está o parser?',
        createdAt: 1,
      },
    });
    expect(t.observe(consult('s1'), false)).toEqual({
      sessionId: 's1',
      title: 'Claude · solline',
      body: 'Precisa de ti: O Claude quer perguntar ao Codex',
      urgent: true,
    });
    // Com foco o cartão já está à vista; uma sessão desconhecida não avisa.
    expect(t.observe(consult('s1'), true)).toBeNull();
    expect(t.observe(consult('outra'), false)).toBeNull();
  });

  it('com a janela em foco, o bot chega: nada de avisos', () => {
    const t = tracker();
    t.observe(state('s1', 'running'), true);
    expect(t.observe(state('s1', 'idle'), true)).toBeNull();
    expect(t.observe(state('s1', 'needs-you'), true)).toBeNull();
  });

  it('o mesmo estado repetido ou uma sessão desconhecida não avisam', () => {
    const t = tracker();
    t.observe(state('s1', 'needs-you'), false);
    expect(t.observe(state('s1', 'needs-you'), false)).toBeNull();
    expect(t.observe(state('outra', 'needs-you'), false)).toBeNull();
  });

  it('avisa quando cai e uma vez por ronda de verificações que falhe', () => {
    const t = tracker();
    expect(t.observe(state('s1', 'error'), false)).toMatchObject({ body: 'Caiu', urgent: false });
    const checks = (turnId: string, lint: 'passed' | 'failed'): EngineEvent => ({
      kind: 'event',
      type: 'session.checks',
      sessionId: 's1',
      checks: {
        trusted: true,
        detected: true,
        turnId,
        specs: [
          { id: 'typecheck', label: 'Tipos', command: 'x', enabled: true },
          { id: 'lint', label: 'Lint', command: 'y', enabled: true },
        ],
        results: [
          { id: 'typecheck', state: 'passed', tail: null, durationMs: 1 },
          { id: 'lint', state: lint, tail: null, durationMs: 1 },
        ],
      },
    });
    expect(t.observe(checks('t1', 'passed'), false)).toBeNull();
    expect(t.observe(checks('t1', 'failed'), false)).toMatchObject({ body: 'Lint falhou' });
    expect(t.observe(checks('t1', 'failed'), false)).toBeNull();
    expect(t.observe(checks('t2', 'failed'), true)).toBeNull();
  });

  it('um turno que acaba com um pedido aberto também conta; sessões na mesma pasta avisam uma vez', () => {
    const t = tracker();
    t.track({ id: 's2', agent: 'codex', state: 'idle' }, 'solline');
    t.observe(state('s1', 'needs-you'), false);
    expect(t.observe(state('s1', 'idle'), false)).toMatchObject({ body: 'Turno acabado' });
    const failing = (sessionId: string): EngineEvent => ({
      kind: 'event',
      type: 'session.checks',
      sessionId,
      checks: {
        trusted: true,
        detected: true,
        turnId: 'r1',
        specs: [{ id: 'lint', label: 'Lint', command: 'x', enabled: true }],
        results: [{ id: 'lint', state: 'failed', tail: null, durationMs: 1 }],
      },
    });
    expect(t.observe(failing('s1'), false)).toMatchObject({ body: 'Lint falhou' });
    expect(t.observe(failing('s2'), false)).toBeNull();
  });

  it('as pistas que arrancam depois da primeira numa repartição passam a ser seguidas', () => {
    const t = tracker();
    const lanes = [
      { sessionId: 's1', agent: 'claude', state: 'running' as const },
      { sessionId: 's3', agent: 'codex', state: 'idle' as const },
    ];
    t.trackLanes(lanes, 'solline');
    // A que já se seguia mantém o estado; a nova avisa como qualquer outra.
    expect(t.observe(state('s3', 'running'), false)).toBeNull();
    expect(t.observe(state('s3', 'needs-you'), false)).toMatchObject({
      title: 'Codex · solline',
      body: 'Precisa de ti',
    });
    expect(t.observe(state('s1', 'running'), false)).toBeNull();
  });

  it('as pistas de uma repartição fechada não voltam a seguir-se', () => {
    const t = tracker();
    const lanes = [{ sessionId: 's9', agent: 'claude', state: 'idle' as const }];
    t.trackRace({ kind: 'split', phase: 'closed', lanes }, 'solline');
    expect(t.observe(state('s9', 'needs-you'), false)).toBeNull();
    // Uma corrida (não repartição) não passa por aqui; uma repartição aberta sim.
    t.trackRace({ kind: 'race', phase: 'running', lanes }, 'solline');
    expect(t.observe(state('s9', 'needs-you'), false)).toBeNull();
    t.trackRace({ kind: 'split', phase: 'running', lanes }, 'solline');
    expect(t.observe(state('s9', 'needs-you'), false)).toMatchObject({ body: 'Precisa de ti' });
  });

  it('o nome do agente', () => {
    expect(agentLabel('codex')).toBe('Codex');
    expect(agentLabel('omp')).toBe('OMP');
    expect(agentLabel('opencode')).toBe('Opencode');
  });
});
