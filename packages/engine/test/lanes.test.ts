import { describe, expect, it } from 'vitest';
import type { SessionStartPayload, SessionState } from '@solline/protocol';
import { Lanes, type LaneSessions } from '../src/races/lanes.ts';

const project = { projectId: 'p', cwd: '/p', trusted: true };

/** Sessões de mentira: `failAt` é o índice (a partir de 0) do create que falha. */
function fake(options: { failAt?: number; missing?: string[] } = {}) {
  const calls = {
    created: [] as {
      agent: string;
      model?: string | undefined;
      raceId?: string | undefined;
      origin?: SessionStartPayload['origin'];
    }[],
    sent: [] as [string, string][],
    closed: [] as [string, string | undefined][],
  };
  let n = 0;
  const sessions: LaneSessions = {
    create: async (payload) => {
      if (calls.created.length === options.failAt) throw new Error('sem espaço');
      calls.created.push({
        agent: payload.agent,
        model: payload.model,
        raceId: payload.raceId,
        origin: payload.origin,
      });
      expect(payload.worktree).toBe('always');
      return {
        session: { id: `s${++n}`, agent: payload.agent, state: 'starting', settings: {} },
      } as never;
    },
    send: async (id, text) => void calls.sent.push([id, text]),
    close: async (id, worktree) => {
      calls.closed.push([id, worktree]);
      if (options.missing?.includes(id)) throw new Error('Sessão desconhecida');
    },
    worktreeOf: (id) => (options.missing?.includes(id) ? undefined : ({} as never)),
  };
  return { sessions, calls };
}

const lane = (sessionId: string, state: SessionState = 'starting') => ({ sessionId, state });

describe('Lanes.open', () => {
  it('manda a cada pista o seu texto, com o grupo e a worktree sempre', async () => {
    const { sessions, calls } = fake();
    const opened = await new Lanes(sessions).open(project, 'g1', [
      { agent: 'claude', text: 'parte A' },
      { agent: 'codex', model: 'm', text: 'parte B' },
    ]);
    expect(opened.sessions.map((s) => s.session.id)).toEqual(['s1', 's2']);
    expect(calls.created.map((c) => [c.agent, c.model, c.raceId])).toEqual([
      ['claude', undefined, 'g1'],
      ['codex', 'm', 'g1'],
    ]);
    // Nada é enviado antes de quem abriu registar o grupo.
    expect(calls.sent).toEqual([]);
    await opened.send();
    expect(calls.sent).toEqual([
      ['s1', 'parte A'],
      ['s2', 'parte B'],
    ]);
  });

  it('cada sessão nasce com a origem: pista da corrida ou parte (com o produtor, se houver)', async () => {
    const { sessions, calls } = fake();
    await new Lanes(sessions).open(project, 'g1', [
      { agent: 'claude', text: 'a' },
      { agent: 'codex', text: 'b', kind: 'part', after: 's0' },
    ]);
    expect(calls.created.map((c) => c.origin)).toEqual([
      { kind: 'lane', raceId: 'g1' },
      { kind: 'part', raceId: 'g1', sessionId: 's0' },
    ]);
  });

  it('se a segunda pista não abre, deita fora a primeira e propaga o erro', async () => {
    const { sessions, calls } = fake({ failAt: 1 });
    await expect(
      new Lanes(sessions).open(project, 'g1', [
        { agent: 'claude', text: 'a' },
        { agent: 'claude', text: 'b' },
        { agent: 'claude', text: 'c' },
      ]),
    ).rejects.toThrow('sem espaço');
    expect(calls.closed).toEqual([['s1', 'discard']]);
    expect(calls.sent).toEqual([]);
  });
});

describe('Lanes.observe', () => {
  it('só dá por acabado depois de cada pista ter começado e parado', () => {
    const core = new Lanes(fake().sessions);
    const lanes = [lane('a'), lane('b')];
    // Parar sem ter começado não conta.
    expect(core.observe(lanes, { sessionId: 'a', state: 'idle' })).toEqual({ settled: false });
    expect(core.observe(lanes, { sessionId: 'b', state: 'running' })).toEqual({ settled: false });
    expect(core.observe(lanes, { sessionId: 'a', state: 'running' })).toEqual({ settled: false });
    expect(core.observe(lanes, { sessionId: 'a', state: 'idle' })).toEqual({ settled: false });
    expect(core.observe(lanes, { sessionId: 'b', state: 'error' })).toEqual({ settled: true });
    expect(lanes.map((l) => l.state)).toEqual(['idle', 'error']);
  });

  it('ignora o que não é do grupo e o estado que não mudou', () => {
    const core = new Lanes(fake().sessions);
    const lanes = [lane('a')];
    expect(core.observe(lanes, { sessionId: 'x', state: 'running' })).toBeUndefined();
    expect(core.observe(lanes, { sessionId: 'a', state: 'starting' })).toBeUndefined();
  });

  it('as pistas repostas do disco ficam em erro', () => {
    const lanes = [lane('a', 'running'), lane('b', 'idle')];
    new Lanes(fake().sessions).restored(lanes);
    expect(lanes.map((l) => l.state)).toEqual(['error', 'error']);
  });
});

describe('Lanes.close', () => {
  it('deita fora todas e guarda só o branch da escolhida', async () => {
    const { sessions, calls } = fake();
    await new Lanes(sessions).close(['a', 'b', 'c'], 'b');
    expect(calls.closed).toEqual([
      ['a', 'discard'],
      ['b', 'keep'],
      ['c', 'discard'],
    ]);
  });

  it('uma sessão que já não existe não impede de fechar as outras', async () => {
    const { sessions, calls } = fake({ missing: ['a'] });
    await new Lanes(sessions).close(['a', 'b'], 'b');
    expect(calls.closed).toEqual([
      ['a', 'discard'],
      ['b', 'keep'],
    ]);
  });

  it('um erro de uma sessão que ainda existe propaga-se', async () => {
    const { sessions } = fake();
    sessions.close = async () => {
      throw new Error('falhou');
    };
    await expect(new Lanes(sessions).close(['a'])).rejects.toThrow('falhou');
  });
});
