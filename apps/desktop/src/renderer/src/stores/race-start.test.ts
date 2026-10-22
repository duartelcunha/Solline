import { afterEach, expect, it, vi } from 'vitest';
import { commandSchemas, EngineEvent, type Race } from '@solline/protocol';
import { capabilities } from '../../../../qa/fixtures';
import { actions, dispatch, restoreSnapshot, sessionStore, useApp } from './app.ts';

vi.mock('../lib/morph.ts', () => ({
  morphUpdate: (apply: () => void) => apply(),
  morphs: () => false,
}));

afterEach(() => vi.unstubAllGlobals());

function heldStart() {
  restoreSnapshot(
    {
      version: 1,
      epoch: 'race-start',
      sequence: 0,
      sessions: [],
      races: [],
      operations: [],
      durability: { status: 'saved' },
    },
    { version: 1, revision: 0, drafts: {} },
  );
  const race: Race = {
    id: 'race',
    projectId: 'project',
    text: 'Compare these changes',
    phase: 'running',
    lanes: ['sonnet', 'opus'].map((model) => ({
      sessionId: model,
      agent: 'claude',
      model,
      state: 'idle',
    })),
  };
  const response = commandSchemas['race.start'].result.parse({
    race,
    sessions: race.lanes.map((lane) => ({
      session: {
        id: lane.sessionId,
        projectId: race.projectId,
        agent: lane.agent,
        cwd: `C:/fixture/${lane.sessionId}`,
        title: lane.model,
        state: 'idle',
        settings: { model: lane.model, effort: null, mode: null },
        agentSessionId: null,
      },
      capabilities,
    })),
  });
  let release!: () => void;
  const pending = new Promise<typeof response>((resolve) => {
    release = () => resolve(response);
  });
  const request = vi.fn((command: string, payload: unknown) => {
    if (command !== 'race.start') throw new Error(`Unexpected command ${command}`);
    expect(commandSchemas['race.start'].payload.parse(payload)).toEqual({
      projectId: race.projectId,
      text: race.text,
      lanes: race.lanes.map(({ agent, model }) => ({ agent, model })),
    });
    return pending;
  });
  vi.stubGlobal('window', { solline: { request } });
  const start = () =>
    actions.startRace(
      race.projectId,
      race.text,
      race.lanes.map(({ agent, model }) => ({ agent, model: model ?? undefined })),
    );
  return { race, release, start, request };
}

it.each(['error', 'needs-you'] as const)(
  'preserves early %s lane events when the durable race.start reply arrives later',
  async (state) => {
    const fixture = heldStart();
    const started = fixture.start();
    // Main has captured the response, but its durable acknowledgement is still pending.
    // Subsequent events are already delivered to the renderer through the normal reducer.
    dispatch(EngineEvent.parse({ kind: 'event', type: 'race.state', race: fixture.race }));
    const latest: Race = {
      ...fixture.race,
      lanes: fixture.race.lanes.map((lane) => ({
        ...lane,
        state: lane.model === 'opus' ? state : 'needs-you',
      })),
    };
    dispatch(EngineEvent.parse({ kind: 'event', type: 'race.state', race: latest }));
    for (const lane of latest.lanes)
      dispatch(
        EngineEvent.parse({
          kind: 'event',
          type: 'session.state',
          sessionId: lane.sessionId,
          state: lane.state,
          ...(lane.state === 'error' ? { error: 'Scripted lane failure' } : {}),
        }),
      );
    expect(useApp.getState().races.race).toEqual(latest);
    fixture.release();
    expect(await started).toBe(true);
    expect(useApp.getState().races.race).toEqual(latest);
    expect(sessionStore('opus')?.getState().info.state).toBe(state);
    expect(sessionStore('sonnet')?.getState().info.state).toBe('needs-you');
    expect(useApp.getState()).toMatchObject({
      view: 'race',
      activeRaceId: 'race',
      sessionIds: ['sonnet', 'opus'],
    });
    expect(fixture.request).toHaveBeenCalledTimes(1);
  },
);

it('uses the response when no race event preceded it, then accepts later events', async () => {
  const fixture = heldStart();
  const started = fixture.start();
  fixture.release();
  expect(await started).toBe(true);
  expect(useApp.getState().races.race).toEqual(fixture.race);
  const later: Race = { ...fixture.race, phase: 'done' };
  dispatch(EngineEvent.parse({ kind: 'event', type: 'race.state', race: later }));
  expect(useApp.getState().races.race).toEqual(later);
});
