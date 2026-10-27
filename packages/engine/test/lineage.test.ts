import { describe, expect, it } from 'vitest';
import {
  EngineSnapshot,
  Finding,
  Quality,
  RecoverySession,
  SessionInfo,
  SessionOrigin,
  commandSchemas,
} from '@solline/protocol';

const session = {
  id: 's1',
  projectId: 'p',
  agent: 'claude',
  cwd: '/p',
  title: 'Sessão',
  state: 'idle',
  settings: { model: null, effort: null, mode: null },
  agentSessionId: null,
};

describe('origem e passagem de testemunho', () => {
  it('a origem e o handedTo passam pelo esquema da sessão e da recuperação sem se perderem', () => {
    const origin = { kind: 'handoff', sessionId: 's0', turnId: 't4' };
    const info = SessionInfo.parse({ ...session, origin, handedTo: 's2' });
    expect(info).toMatchObject({ origin, handedTo: 's2' });
    const view = RecoverySession.parse({
      session: info,
      capabilities: null,
      turns: [],
      usage: { costUsd: null, models: [], context: null, tokens: null },
      queue: { items: [], paused: false },
      timeline: null,
      quality: null,
      checks: null,
      conflicts: null,
      interrupted: false,
      error: null,
    });
    const snapshot = EngineSnapshot.parse({
      version: 1,
      epoch: 'e',
      sequence: 1,
      sessions: [view],
      races: [],
      operations: [],
      durability: { status: 'saved' },
    });
    expect(JSON.parse(JSON.stringify(snapshot)).sessions[0].session).toMatchObject({
      origin,
      handedTo: 's2',
    });
  });

  it('só aceita ids e tipos conhecidos', () => {
    expect(() => SessionOrigin.parse({ kind: 'handoff', summary: 'texto' })).toThrow();
    expect(() => SessionOrigin.parse({ kind: 'magia' })).toThrow();
    for (const kind of ['handoff', 'fork', 'lane', 'part', 'task']) {
      expect(SessionOrigin.parse({ kind })).toEqual({ kind });
    }
    expect(SessionInfo.parse(session).origin).toBeUndefined();
  });

  it('session.create aceita a origem', () => {
    const payload = commandSchemas['session.create'].payload.parse({
      projectId: 'p',
      agent: 'claude',
      origin: { kind: 'fork', sessionId: 's0', turnId: 't1' },
    });
    expect(payload.origin).toEqual({ kind: 'fork', sessionId: 's0', turnId: 't1' });
  });
});

describe('achados com prioridade e estado', () => {
  const base = { id: '1', path: 'a.ts', line: 1, severity: 'bug', title: 't', detail: 'd' };

  it('o que foi gravado antes lê-se com valores por omissão', () => {
    expect(Finding.parse(base)).toMatchObject({ priority: 2, confidence: 0.5, status: 'open' });
    const quality = Quality.parse({
      available: true,
      enabled: true,
      review: { state: 'done', turnId: 't', findings: [base], error: null },
    });
    expect(quality.stats).toEqual({ fixed: 0, dismissed: 0, total: 0 });
  });

  it('recusa prioridade e confiança fora de limites', () => {
    expect(() => Finding.parse({ ...base, priority: 4 })).toThrow();
    expect(() => Finding.parse({ ...base, priority: -1 })).toThrow();
    expect(() => Finding.parse({ ...base, confidence: 1.5 })).toThrow();
    expect(() => Finding.parse({ ...base, status: 'feito' })).toThrow();
  });

  it('a revisão guarda quem reviu e o gatilho', () => {
    const quality = Quality.parse({
      available: true,
      enabled: true,
      review: {
        state: 'done',
        turnId: 't',
        findings: [],
        error: null,
        reviewer: { vendor: 'codex', model: 'gpt', sameVendor: false },
        trigger: 'bring',
      },
    });
    expect(quality.review).toMatchObject({ trigger: 'bring', reviewer: { vendor: 'codex' } });
    expect(commandSchemas['quality.dismiss'].payload.parse({ sessionId: 's', ids: ['a'] })).toEqual(
      { sessionId: 's', ids: ['a'] },
    );
    expect(() =>
      commandSchemas['quality.dismiss'].payload.parse({ sessionId: 's', ids: [] }),
    ).toThrow();
  });
});
