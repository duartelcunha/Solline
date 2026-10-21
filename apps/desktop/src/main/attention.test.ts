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

  it('o nome do agente', () => {
    expect(agentLabel('codex')).toBe('Codex');
    expect(agentLabel('opencode')).toBe('Opencode');
  });
});
