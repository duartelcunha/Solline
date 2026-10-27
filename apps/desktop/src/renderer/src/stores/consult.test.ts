import { afterEach, expect, it, vi } from 'vitest';
import {
  commandSchemas,
  type ConsultRequest,
  type EngineEvent,
  type SessionInfo,
} from '@solline/protocol';
import { capabilities } from '../../../../qa/fixtures';
import { actions, dispatch, restoreSnapshot, sessionStore } from './app.ts';

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
  state: 'running',
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

const request = (over: Partial<ConsultRequest> = {}): ConsultRequest => ({
  id: 'c1',
  kind: 'ask',
  sessionId: 'a',
  from: 'claude',
  to: 'codex',
  summary: 'O Claude quer perguntar ao Codex',
  text: 'Onde está o parser?',
  createdAt: 1,
  ...over,
});

const requested = (r: ConsultRequest): EngineEvent => ({
  kind: 'event',
  type: 'consult.request',
  sessionId: r.sessionId,
  request: r,
});

function open(consults?: ConsultRequest[]) {
  restoreSnapshot(
    {
      version: 1,
      epoch: 'consult',
      sequence: 0,
      sessions: [saved(info('a')), saved(info('b'))],
      races: [],
      operations: [],
      ...(consults ? { consults } : {}),
      durability: { status: 'saved' },
    },
    { version: 1, revision: 0, drafts: {} },
  );
}

it('um pedido chega à sessão que perguntou e sai quando é decidido ou cancelado', () => {
  open();
  expect(sessionStore('a')?.getState().consults).toEqual([]);
  dispatch(requested(request()));
  dispatch(requested(request({ id: 'c2', kind: 'delegate', text: 'faz isto' })));
  expect(
    sessionStore('a')
      ?.getState()
      .consults.map((c) => c.id),
  ).toEqual(['c1', 'c2']);
  // O mesmo pedido outra vez não duplica.
  dispatch(requested(request()));
  expect(sessionStore('a')?.getState().consults).toHaveLength(2);
  expect(sessionStore('b')?.getState().consults).toEqual([]);
  dispatch({
    kind: 'event',
    type: 'consult.settled',
    sessionId: 'a',
    requestId: 'c1',
    outcome: 'allow',
  });
  expect(
    sessionStore('a')
      ?.getState()
      .consults.map((c) => c.id),
  ).toEqual(['c2']);
  dispatch({
    kind: 'event',
    type: 'consult.settled',
    sessionId: 'a',
    requestId: 'c2',
    outcome: 'cancelled',
  });
  expect(sessionStore('a')?.getState().consults).toEqual([]);
});

it('os pedidos pendentes vêm no snapshot, cada um na sua sessão', () => {
  open([request(), request({ id: 'c9', sessionId: 'b' })]);
  expect(
    sessionStore('a')
      ?.getState()
      .consults.map((c) => c.id),
  ).toEqual(['c1']);
  expect(
    sessionStore('b')
      ?.getState()
      .consults.map((c) => c.id),
  ).toEqual(['c9']);
  // Depois de reiniciar o motor o snapshot já não os traz.
  open();
  expect(sessionStore('a')?.getState().consults).toEqual([]);
});

it('uma consulta ou delegação nasce com o título que lhe deram', () => {
  restoreSnapshot(
    {
      version: 1,
      epoch: 'titles',
      sequence: 0,
      sessions: [
        saved(
          info('q', { title: 'Pergunta de Claude: x', origin: { kind: 'ask', sessionId: 'a' } }),
        ),
        saved(info('d', { title: 'A nota', origin: { kind: 'delegate', sessionId: 'a' } })),
      ],
      races: [],
      operations: [],
      durability: { status: 'saved' },
    },
    { version: 1, revision: 0, drafts: {} },
  );
  for (const id of ['q', 'd'])
    dispatch({
      kind: 'event',
      type: 'session.event',
      sessionId: id,
      delta: {
        type: 'turn.start',
        turn: {
          id: 't',
          role: 'user',
          blocks: [
            {
              kind: 'text',
              id: 'x',
              text: 'Isto é uma consulta de outro agente',
              parentToolId: null,
            },
          ],
        },
      },
    });
  expect(sessionStore('q')?.getState().info.title).toBe('Pergunta de Claude: x');
  expect(sessionStore('d')?.getState().info.title).toBe('A nota');
});

it('answerConsult manda a decisão ao motor; um erro fica na sessão', async () => {
  open([request()]);
  const send = vi.fn(async (command: string, payload: unknown) => {
    expect(command).toBe('consult.answer');
    commandSchemas['consult.answer'].payload.parse(payload);
    return {};
  });
  vi.stubGlobal('window', { solline: { request: send } });
  expect(await actions.answerConsult('a', 'c1', 'allowSession')).toBe(true);
  expect(send).toHaveBeenCalledWith('consult.answer', {
    sessionId: 'a',
    requestId: 'c1',
    decision: 'allowSession',
  });
  vi.stubGlobal('window', {
    solline: {
      request: vi.fn(async () => {
        throw new Error('Este pedido já não está à espera de resposta');
      }),
    },
  });
  expect(await actions.answerConsult('a', 'c1', 'deny')).toBe(false);
  expect(sessionStore('a')?.getState().actionError).toBe(
    'Este pedido já não está à espera de resposta',
  );
});
