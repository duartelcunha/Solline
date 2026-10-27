import { afterEach, expect, it, vi } from 'vitest';
import type { Quality, SessionInfo } from '@solline/protocol';
import { capabilities } from '../../../../qa/fixtures';
import { actions, restoreSnapshot, sessionStore, useApp } from './app.ts';

vi.mock('../lib/morph.ts', () => ({
  morphUpdate: (apply: () => void) => apply(),
  morphs: () => false,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  useApp.setState({ bringFor: null, handoffFor: null, mapOpen: false });
});

const info = (id: string): SessionInfo => ({
  id,
  projectId: 'project',
  agent: 'claude',
  cwd: '/project',
  title: `Sessão ${id}`,
  state: 'idle',
  settings: { model: null, effort: null, mode: null },
  agentSessionId: null,
});

const quality = (over: Partial<Quality> = {}): Quality => ({
  available: true,
  enabled: true,
  review: { state: 'done', turnId: 't1', findings: [], error: null },
  stats: { fixed: 0, dismissed: 0, total: 0 },
  ...over,
});

function open(q: Quality | null) {
  restoreSnapshot(
    {
      version: 1,
      epoch: 'second-opinion',
      sequence: 0,
      sessions: [
        {
          session: info('a'),
          capabilities,
          turns: [],
          usage: { costUsd: null, models: [], context: null, tokens: null },
          queue: { items: [], paused: false },
          timeline: null,
          quality: q,
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

it('"Trazer" abre a confirmação e pede já a revisão de toda a sessão, antes de trazer', () => {
  open(quality());
  const request = vi.fn(async () => quality());
  vi.stubGlobal('window', { solline: { request } });
  actions.askBring('a');
  expect(useApp.getState().bringFor).toBe('a');
  expect(request).toHaveBeenCalledWith('quality.review', {
    sessionId: 'a',
    trigger: 'bring',
    scope: 'session',
  });
  actions.closeBring();
  expect(useApp.getState().bringFor).toBeNull();
});

it('com o revisor desligado, indisponível ou já a rever, confirma sem pedir outra revisão', () => {
  for (const q of [
    quality({ enabled: false }),
    quality({ available: false }),
    quality({ review: { state: 'running', turnId: 't1', findings: [], error: null } }),
    null,
  ]) {
    open(q);
    const request = vi.fn(async () => quality());
    vi.stubGlobal('window', { solline: { request } });
    actions.askBring('a');
    expect(useApp.getState().bringFor).toBe('a');
    expect(request).not.toHaveBeenCalled();
    actions.closeBring();
  }
});

it('uma revisão que o motor recusa não impede a confirmação de abrir', async () => {
  open(quality());
  const request = vi.fn(async () => {
    throw new Error('Ainda não há nenhum turno acabado');
  });
  vi.stubGlobal('window', { solline: { request } });
  actions.askBring('a');
  await Promise.resolve();
  expect(useApp.getState().bringFor).toBe('a');
  expect(sessionStore('a')?.getState().actionError).toBeNull();
});

it('a segunda opinião a pedido leva o âmbito escolhido', async () => {
  open(quality());
  const request = vi.fn(async () => quality());
  vi.stubGlobal('window', { solline: { request } });
  expect(await actions.secondOpinion('a', 'session')).toBe(true);
  expect(await actions.secondOpinion('a', 'turn')).toBe(true);
  expect(request.mock.calls).toEqual([
    ['quality.review', { sessionId: 'a', trigger: 'manual', scope: 'session' }],
    ['quality.review', { sessionId: 'a', trigger: 'manual', scope: 'turn' }],
  ]);
});

it('um erro do motor na segunda opinião fica na sessão', async () => {
  open(quality());
  vi.stubGlobal('window', {
    solline: {
      request: vi.fn(async () => {
        throw new Error('Espera que o agente acabe');
      }),
    },
  });
  expect(await actions.secondOpinion('a', 'turn')).toBe(false);
  expect(sessionStore('a')?.getState().actionError).toBe('Espera que o agente acabe');
});

it('dispensar guarda o estado novo e os contadores que o motor devolve', async () => {
  open(
    quality({
      review: {
        state: 'done',
        turnId: 't1',
        error: null,
        findings: [
          {
            id: 'f1',
            path: 'a.ts',
            line: 1,
            severity: 'bug',
            priority: 0,
            confidence: 0.9,
            status: 'open',
            title: 'x',
            detail: '',
          },
        ],
      },
    }),
  );
  const next = quality({
    stats: { fixed: 0, dismissed: 1, total: 1 },
    review: {
      state: 'done',
      turnId: 't1',
      error: null,
      findings: [
        {
          id: 'f1',
          path: 'a.ts',
          line: 1,
          severity: 'bug',
          priority: 0,
          confidence: 0.9,
          status: 'dismissed',
          title: 'x',
          detail: '',
        },
      ],
    },
  });
  const request = vi.fn(async () => next);
  vi.stubGlobal('window', { solline: { request } });
  expect(await actions.dismissFindings('a', ['f1'])).toBe(true);
  expect(request).toHaveBeenCalledWith('quality.dismiss', { sessionId: 'a', ids: ['f1'] });
  expect(sessionStore('a')?.getState().quality?.stats.dismissed).toBe(1);
});

it('abrir e fechar o diálogo "Passar a…" e o Mapa', () => {
  actions.openHandoff('a');
  expect(useApp.getState().handoffFor).toBe('a');
  actions.closeHandoff();
  expect(useApp.getState().handoffFor).toBeNull();
  actions.openMap();
  expect(useApp.getState().mapOpen).toBe(true);
  actions.closeMap();
  expect(useApp.getState().mapOpen).toBe(false);
});
