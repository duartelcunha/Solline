import { afterEach, expect, it, vi } from 'vitest';
import { commandSchemas, type EngineEvent, type SessionInfo } from '@solline/protocol';
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

const saved = (session: SessionInfo) => ({
  session,
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
});

function open() {
  restoreSnapshot(
    {
      version: 1,
      epoch: 'handoff',
      sequence: 0,
      sessions: [saved(info('a'))],
      races: [],
      operations: [],
      durability: { status: 'saved' },
    },
    { version: 1, revision: 0, drafts: {} },
  );
}

const handoffEvent = (sessionId: string, handedTo: string | null): EngineEvent => ({
  kind: 'event',
  type: 'session.handoff',
  sessionId,
  handedTo,
});

it('o evento session.handoff põe e tira o handedTo da sessão', () => {
  open();
  dispatch(handoffEvent('a', 'b'));
  expect(sessionStore('a')?.getState().info.handedTo).toBe('b');
  dispatch(handoffEvent('a', null));
  expect(sessionStore('a')?.getState().info).not.toHaveProperty('handedTo');
});

it('startHandoff abre a sessão nova e a origem fica a passar; o evento chega antes da resposta', async () => {
  open();
  const next = info('b', {
    title: 'Executar a fase 1',
    origin: { kind: 'handoff', sessionId: 'a' },
  });
  const request = vi.fn(async (command: string) => {
    expect(command).toBe('handoff.start');
    dispatch(handoffEvent('a', 'b'));
    dispatch({
      kind: 'event',
      type: 'session.event',
      sessionId: 'b',
      delta: {
        type: 'turn.start',
        turn: {
          id: 't1',
          role: 'user',
          blocks: [
            { kind: 'text', id: 'x', text: 'Passagem de testemunho de Claude', parentToolId: null },
          ],
        },
      },
    });
    return commandSchemas['handoff.start'].result.parse({
      session: next,
      capabilities,
      turnId: 't1',
    });
  });
  vi.stubGlobal('window', { solline: { request } });
  expect(await actions.startHandoff('a', 'codex', '## Objetivo\nX', { model: 'm' })).toBe(true);
  expect(request).toHaveBeenCalledWith('handoff.start', {
    sessionId: 'a',
    agent: 'codex',
    text: '## Objetivo\nX',
    model: 'm',
  });
  expect(useApp.getState().activeSessionId).toBe('b');
  expect(useApp.getState().sessionIds).toContain('b');
  expect(sessionStore('a')?.getState().info.handedTo).toBe('b');
  // O nome fica o do objetivo: a primeira mensagem é só o aviso.
  expect(sessionStore('b')?.getState().info.title).toBe('Executar a fase 1');
  expect(sessionStore('b')?.getState().turns).toHaveLength(1);
});

it('um erro do motor fica na sessão de origem', async () => {
  open();
  vi.stubGlobal('window', {
    solline: {
      request: vi.fn(async () => {
        throw new Error('Espera que o agente acabe');
      }),
    },
  });
  expect(await actions.startHandoff('a', 'codex', 'x')).toBe(false);
  expect(sessionStore('a')?.getState().actionError).toBe('Espera que o agente acabe');
  expect(await actions.draftHandoff('a', 'codex', 'x')).toBeNull();
  expect(await actions.resumeHandoff('a')).toBe(false);
});

it('resumeHandoff tira o handedTo a uma sessão e põe-no na outra', async () => {
  restoreSnapshot(
    {
      version: 1,
      epoch: 'handoff-resume',
      sequence: 0,
      sessions: [saved(info('a', { handedTo: 'b' })), saved(info('b'))],
      races: [],
      operations: [],
      durability: { status: 'saved' },
    },
    { version: 1, revision: 0, drafts: {} },
  );
  vi.stubGlobal('window', {
    solline: {
      request: vi.fn(async () => ({
        session: info('a'),
        paused: info('b', { handedTo: 'a' }),
      })),
    },
  });
  expect(await actions.resumeHandoff('a')).toBe(true);
  expect(sessionStore('a')?.getState().info).not.toHaveProperty('handedTo');
  expect(sessionStore('b')?.getState().info.handedTo).toBe('a');
});
