import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  EngineEvent,
  commandSchemas,
  type EngineSnapshot,
  type Race,
  type SessionInfo,
  type SplitPart,
} from '@solline/protocol';
import { capabilities } from '../../../../qa/fixtures';
import { actions, dispatch, restoreSnapshot, sessionStore, useApp } from './app.ts';

vi.mock('../lib/morph.ts', () => ({
  morphUpdate: (apply: () => void) => apply(),
  morphs: () => false,
}));

afterEach(() => vi.unstubAllGlobals());

const part = (title: string, zero = false): SplitPart => ({
  title,
  goal: `Fazer ${title}`,
  allowed: [`src/${title}/**`],
  forbidden: [],
  interfaces: '',
  expected: '',
  check: 'typecheck',
  zero,
});

const info = (id: string): SessionInfo => ({
  id,
  projectId: 'project',
  agent: 'claude',
  cwd: `C:/fixture/${id}`,
  title: id,
  state: 'idle',
  settings: { model: 'sonnet', effort: null, mode: null },
  agentSessionId: null,
});

const lane = (id: string, title: string, zero = false) => ({
  sessionId: id,
  agent: 'claude',
  model: 'sonnet',
  state: 'running' as const,
  part: part(title, zero),
});

const race = (lanes: Race['lanes'], extra: Partial<Race> = {}): Race => ({
  kind: 'split',
  id: 'split',
  projectId: 'project',
  text: 'Fazer o pedido grande',
  phase: 'running',
  lanes,
  ...extra,
});

const created = (id: string) => ({ session: info(id), capabilities });

function reset() {
  restoreSnapshot(
    {
      version: 1,
      epoch: 'split',
      sequence: 0,
      sessions: [],
      races: [],
      operations: [],
      durability: { status: 'saved' },
    },
    { version: 1, revision: 0, drafts: {} },
  );
  useApp.setState({ notice: null, view: 'desk', activeRaceId: null });
}

beforeEach(reset);

const snapshotWith = (ids: string[], sequence: number): EngineSnapshot =>
  commandSchemas['engine.snapshot'].result.parse({
    version: 1,
    epoch: 'split',
    sequence,
    sessions: ids.map((id) => ({
      session: { ...info(id), state: 'running' },
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
    })),
    races: [],
    operations: [],
    durability: { status: 'saved' },
  });

const ONE = race([lane('zero', 'Base', true)], {
  split: { pending: [], warnings: [] },
});

it('startSplit manda as partes, adota as sessões e abre a vista da repartição', async () => {
  const parts = [part('Base', true), part('Ecra')].map((p) => ({ part: p, agent: 'claude' }));
  const request = vi.fn(async (command: string, payload: unknown) => {
    expect(command).toBe('split.start');
    expect(commandSchemas['split.start'].payload.parse(payload)).toEqual({
      projectId: 'project',
      text: 'Fazer o pedido grande',
      parts,
    });
    return commandSchemas['split.start'].result.parse({
      race: ONE,
      sessions: [created('zero')],
    });
  });
  vi.stubGlobal('window', { solline: { request } });
  expect(await actions.startSplit('project', 'Fazer o pedido grande', parts)).toBe(true);
  expect(sessionStore('zero')).toBeDefined();
  expect(useApp.getState()).toMatchObject({
    view: 'race',
    activeRaceId: 'split',
    sessionIds: ['zero'],
  });
  expect(useApp.getState().races.split).toEqual(ONE);
});

it('startSplit falha com um aviso calmo e sem mudar de vista', async () => {
  const request = vi.fn(async () => {
    throw new Error('Nenhuma parte tem uma verificação válida');
  });
  vi.stubGlobal('window', { solline: { request } });
  const parts = [part('A', true), part('B')].map((p) => ({ part: p, agent: 'claude' }));
  expect(await actions.startSplit('project', 'x', parts)).toBe(false);
  expect(useApp.getState().notice).toContain('A repartição não arrancou');
  expect(useApp.getState().view).toBe('desk');
});

it('uma parte que arranca depois da zero ganha loja a partir do snapshot, sem repetir eventos', async () => {
  const request = vi.fn(async (command: string) => {
    if (command === 'split.start')
      return commandSchemas['split.start'].result.parse({ race: ONE, sessions: [created('zero')] });
    if (command === 'engine.snapshot') return snapshotWith(['zero', 'late'], 5);
    throw new Error(`Inesperado ${command}`);
  });
  vi.stubGlobal('window', { solline: { request } });
  await actions.startSplit(
    'project',
    'x',
    [part('Base', true), part('Ecra')].map((p) => ({ part: p, agent: 'claude' })),
  );
  expect(request).toHaveBeenCalledTimes(1);

  const next = race([lane('zero', 'Base', true), lane('late', 'Ecra')], {
    split: { pending: [], warnings: [] },
  });
  // Um evento anterior ao snapshot (já nele) e outro posterior (por aplicar).
  dispatch(
    EngineEvent.parse({
      kind: 'event',
      type: 'session.state',
      sessionId: 'late',
      state: 'idle',
      sequence: 3,
    }),
  );
  dispatch(EngineEvent.parse({ kind: 'event', type: 'race.state', race: next }));
  dispatch(
    EngineEvent.parse({
      kind: 'event',
      type: 'session.state',
      sessionId: 'late',
      state: 'needs-you',
      sequence: 7,
    }),
  );
  await vi.waitFor(() => expect(sessionStore('late')).toBeDefined());
  expect(request).toHaveBeenCalledTimes(2);
  expect(sessionStore('late')?.getState().info.state).toBe('needs-you');
  expect(useApp.getState().sessionIds).toContain('late');
  expect(useApp.getState().view).toBe('race');

  // Uma segunda notícia da mesma corrida não volta a pedir o snapshot.
  dispatch(EngineEvent.parse({ kind: 'event', type: 'race.state', race: next }));
  expect(request).toHaveBeenCalledTimes(2);
});

it('um evento que o snapshot já contém não se aplica outra vez por cima dele', async () => {
  const request = vi.fn(async () => snapshotWith(['late'], 5));
  vi.stubGlobal('window', { solline: { request } });
  dispatch(
    EngineEvent.parse({
      kind: 'event',
      type: 'session.state',
      sessionId: 'late',
      state: 'idle',
      sequence: 4,
    }),
  );
  dispatch(
    EngineEvent.parse({
      kind: 'event',
      type: 'race.state',
      race: race([lane('late', 'Ecra')], { split: { pending: [], warnings: [] } }),
    }),
  );
  await vi.waitFor(() => expect(sessionStore('late')).toBeDefined());
  expect(sessionStore('late')?.getState().info.state).toBe('running');
});

it('reviewSplit devolve a revisão, ou null quando falha', async () => {
  const review = { sequential: [[0], [1]], dropped: [], hubs: [], costMultiplier: 2, warnings: [] };
  const request = vi.fn(async (command: string) => {
    expect(command).toBe('split.review');
    return review;
  });
  vi.stubGlobal('window', { solline: { request } });
  expect(await actions.reviewSplit([part('A'), part('B')], ['typecheck'])).toEqual(review);
  vi.stubGlobal('window', {
    solline: {
      request: async () => {
        throw new Error('x');
      },
    },
  });
  expect(await actions.reviewSplit([part('A')], [])).toBeNull();
  expect(useApp.getState().notice).toBeNull();
});

it('planSplit passa o texto ao planeador e um erro vira aviso', async () => {
  const result = { plan: { decision: 'keep', reason: 'É pequeno' }, review: {}, cost: null };
  const request = vi.fn(async (_command: string, payload: unknown) => {
    expect(payload).toEqual({ projectId: 'project', text: 'um pedido' });
    return result;
  });
  vi.stubGlobal('window', { solline: { request } });
  expect(await actions.planSplit('project', 'um pedido')).toEqual(result);
  vi.stubGlobal('window', {
    solline: {
      request: async () => {
        throw new Error('Sem rede');
      },
    },
  });
  expect(await actions.planSplit('project', 'um pedido')).toBeNull();
  expect(useApp.getState().notice).toContain('Sem rede');
});

it('resolveSplit adota a sessão de resolução sem mudar de vista, e fechar a repartição limpa-a', async () => {
  useApp.setState({
    view: 'race',
    activeRaceId: 'split',
    races: { split: ONE },
    sessionIds: ['zero'],
  });
  const conflicted = race([lane('zero', 'Base', true)], {
    phase: 'done',
    split: { pending: [], warnings: [] },
  });
  const request = vi.fn(async (command: string) => {
    if (command === 'split.resolve')
      return commandSchemas['split.resolve'].result.parse({
        race: conflicted,
        session: created('fixer'),
      });
    if (command === 'race.close') return { closed: true, race: { ...conflicted, phase: 'closed' } };
    throw new Error('sem resposta');
  });
  vi.stubGlobal('window', { solline: { request } });
  expect(await actions.resolveSplit('split')).toBe('fixer');
  expect(sessionStore('fixer')).toBeDefined();
  expect(useApp.getState()).toMatchObject({ view: 'race', activeRaceId: 'split' });
  expect(useApp.getState().sessionIds).toContain('fixer');

  expect(await actions.closeRace('split')).toBe(true);
  expect(sessionStore('fixer')).toBeUndefined();
  expect(useApp.getState().sessionIds).not.toContain('fixer');
});

it('integrar e continuar guardam a repartição devolvida; um erro vira aviso', async () => {
  const done = race([lane('zero', 'Base', true)], { phase: 'assembling' });
  vi.stubGlobal('window', { solline: { request: vi.fn(async () => done) } });
  expect(await actions.integrateSplit('split')).toBe(true);
  expect(useApp.getState().races.split?.phase).toBe('assembling');
  expect(await actions.continueSplit('split')).toBe(true);

  vi.stubGlobal('window', {
    solline: {
      request: async () => {
        throw new Error('Há partes ainda a trabalhar');
      },
    },
  });
  expect(await actions.integrateSplit('split')).toBe(false);
  expect(useApp.getState().notice).toContain('Há partes ainda a trabalhar');
  expect(await actions.continueSplit('split')).toBe(false);
  expect(await actions.resolveSplit('split')).toBeNull();
});

it('stopSplit guarda a repartição devolvida; um erro vira aviso', async () => {
  const stopped = race([lane('zero', 'Base', true)], {
    split: {
      pending: [],
      warnings: [{ sessionId: '', kind: 'problem', path: '', detail: 'Parada' }],
    },
  });
  const request = vi.fn(async (command: string, payload: unknown) => {
    expect(command).toBe('split.stop');
    expect(payload).toEqual({ raceId: 'split' });
    return stopped;
  });
  vi.stubGlobal('window', { solline: { request } });
  expect(await actions.stopSplit('split')).toBe(true);
  expect(useApp.getState().races.split?.split?.warnings[0]?.kind).toBe('problem');

  vi.stubGlobal('window', {
    solline: {
      request: async () => {
        throw new Error('Não há partes por arrancar para parar.');
      },
    },
  });
  expect(await actions.stopSplit('split')).toBe(false);
  expect(useApp.getState().notice).toContain('Não há partes por arrancar');
});
