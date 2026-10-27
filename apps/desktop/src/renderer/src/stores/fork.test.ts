import { afterEach, expect, it, vi } from 'vitest';
import { commandSchemas, type SessionInfo, type Turn } from '@solline/protocol';
import { capabilities } from '../../../../qa/fixtures';
import { actions, dispatch, restoreSnapshot, sessionStore, useApp } from './app.ts';

vi.mock('../lib/morph.ts', () => ({
  morphUpdate: (apply: () => void) => apply(),
  morphs: () => false,
}));

afterEach(() => vi.unstubAllGlobals());

const info = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  projectId: 'project',
  agent: 'claude',
  cwd: '/project',
  title: `Sessão ${id}`,
  state: 'idle',
  settings: { model: null, effort: null, mode: null },
  agentSessionId: null,
  ...over,
});

const turn = (id: string, role: Turn['role'], text: string): Turn => ({
  id,
  role,
  blocks: [{ kind: 'text', id: `${id}-x`, text, parentToolId: null }],
});

function open() {
  restoreSnapshot(
    {
      version: 1,
      epoch: 'fork',
      sequence: 0,
      sessions: [
        {
          session: info('a'),
          capabilities,
          turns: [turn('t1', 'user', 'primeiro'), turn('t1:a', 'assistant', 'feito')],
          usage: { costUsd: null, models: [], context: null, tokens: null },
          queue: { items: [], paused: false },
          timeline: null,
          quality: null,
          checks: null,
          conflicts: null,
          interrupted: false,
          error: null,
        },
      ],
      races: [],
      operations: [],
      durability: { status: 'saved' },
    },
    { version: 1, revision: 0, drafts: {} },
  );
}

it('forkSession abre a sessão nova com o histórico até ao turno e deixa a origem como estava', async () => {
  open();
  const history = [turn('t1', 'user', 'primeiro'), turn('t1:a', 'assistant', 'feito')];
  const forked = info('b', {
    title: 'Sessão a (bifurcação)',
    origin: { kind: 'fork', sessionId: 'a', turnId: 't1' },
  });
  const request = vi.fn(async (command: string) => {
    expect(command).toBe('session.fork');
    // Os eventos da sessão nova chegam antes da resposta e não duplicam o histórico.
    for (const item of history)
      dispatch({
        kind: 'event',
        type: 'session.event',
        sessionId: 'b',
        delta: { type: 'turn.start', turn: item },
      });
    return commandSchemas['session.fork'].result.parse({
      session: forked,
      capabilities,
      turns: history,
      conversation: 'summary',
    });
  });
  vi.stubGlobal('window', { solline: { request } });

  expect(await actions.forkSession('a', 't1')).toBe(true);
  expect(request).toHaveBeenCalledWith('session.fork', { sessionId: 'a', turnId: 't1' });
  expect(useApp.getState().activeSessionId).toBe('b');
  expect(useApp.getState().sessionIds).toContain('b');
  const next = sessionStore('b')?.getState();
  // O nome é o da origem, não o do primeiro pedido copiado.
  expect(next?.info.title).toBe('Sessão a (bifurcação)');
  expect(next?.info.origin).toEqual({ kind: 'fork', sessionId: 'a', turnId: 't1' });
  expect(next?.turns.map((t) => t.id)).toEqual(['t1', 't1:a']);
  // A origem não mudou.
  expect(sessionStore('a')?.getState().turns).toHaveLength(2);
  expect(sessionStore('a')?.getState().info).toEqual(info('a'));
});

it('o evento de um turno que chega primeiro à sessão de uma bifurcação não lhe muda o nome', () => {
  restoreSnapshot(
    {
      version: 1,
      epoch: 'fork-title',
      sequence: 0,
      sessions: [
        {
          session: info('c', { title: 'Origem (bifurcação)', origin: { kind: 'fork' } }),
          capabilities,
          turns: [],
          usage: { costUsd: null, models: [], context: null, tokens: null },
          queue: { items: [], paused: false },
          timeline: null,
          quality: null,
          checks: null,
          conflicts: null,
          interrupted: false,
          error: null,
        },
      ],
      races: [],
      operations: [],
      durability: { status: 'saved' },
    },
    { version: 1, revision: 0, drafts: {} },
  );
  dispatch({
    kind: 'event',
    type: 'session.event',
    sessionId: 'c',
    delta: { type: 'turn.start', turn: turn('u1', 'user', 'um pedido qualquer') },
  });
  expect(sessionStore('c')?.getState().info.title).toBe('Origem (bifurcação)');
});

it('um erro do motor fica na sessão de origem e não abre nada', async () => {
  open();
  vi.stubGlobal('window', {
    solline: {
      request: vi.fn(async () => {
        throw new Error('Bifurcar só funciona em projetos git.');
      }),
    },
  });
  expect(await actions.forkSession('a', 't1')).toBe(false);
  expect(sessionStore('a')?.getState().actionError).toBe('Bifurcar só funciona em projetos git.');
  expect(useApp.getState().sessionIds).toEqual(['a']);
});
