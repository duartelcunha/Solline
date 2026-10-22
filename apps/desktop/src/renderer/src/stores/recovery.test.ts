import { afterEach, expect, it, vi } from 'vitest';
import type { EngineEvent, EngineSnapshot } from '@solline/protocol';
import { actions, connectRecovery, restoreSnapshot, sessionStore, useApp } from './app.ts';

vi.mock('../lib/morph.ts', () => ({
  morphUpdate: (apply: () => void) => apply(),
  morphs: () => false,
}));

function snapshot(sequence = 0, epoch = 'first'): EngineSnapshot {
  return {
    version: 1,
    epoch,
    sequence,
    races: [],
    operations: [],
    durability: { status: 'saved' },
    sessions: [
      {
        session: {
          id: 'session',
          projectId: 'project',
          agent: 'claude',
          cwd: 'C:/fixture',
          title: 'Restored',
          state: 'idle',
          settings: { model: null, effort: null, mode: null },
          agentSessionId: null,
        },
        capabilities: null,
        turns: [],
        usage: { costUsd: null, models: [], context: null, tokens: null },
        queue: { items: [], paused: true },
        timeline: null,
        quality: null,
        checks: null,
        conflicts: null,
        interrupted: false,
        error: null,
      },
    ],
  };
}
const ui = { version: 1 as const, revision: 0, drafts: {} };
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function bridge(read: () => Promise<EngineSnapshot>) {
  vi.stubGlobal('document', Object.assign(new EventTarget(), { getElementById: () => null }));
  let listener: ((event: EngineEvent) => void) | undefined;
  const closeHooks = new Set<unknown>();
  const subscribeClose = (callback: unknown) => {
    closeHooks.add(callback);
    return () => {
      closeHooks.delete(callback);
    };
  };
  const request = vi.fn((command: string) => {
    if (command !== 'engine.snapshot') throw new Error(`Unexpected command ${command}`);
    return read();
  });
  vi.stubGlobal('window', {
    solline: {
      request,
      recovery: { ui: async () => ui, saveDraft: async () => 1 },
      onEvent: (receive: typeof listener) => {
        listener = receive;
        return () => {
          listener = undefined;
        };
      },
      window: { onPrepareClose: subscribeClose, onCloseCancelled: subscribeClose },
    },
  });
  restoreSnapshot({ ...snapshot(), sessions: [] }, ui);
  useApp.setState({ recoveryStatus: 'loading' });
  return { request, closeHooks, emit: (event: EngineEvent) => listener?.(event) };
}

it('applies only events after the snapshot watermark, exactly once', async () => {
  let release!: (value: EngineSnapshot) => void;
  const pending = new Promise<EngineSnapshot>((resolve) => {
    release = resolve;
  });
  const fake = bridge(() => pending);
  stop = connectRecovery();
  const event = (sequence: number, state: 'idle' | 'running'): EngineEvent => ({
    kind: 'event',
    type: 'session.state',
    sessionId: 'session',
    epoch: 'first',
    sequence,
    state,
  });
  fake.emit(event(2, 'idle'));
  fake.emit(event(3, 'running'));
  release(snapshot(2));
  await vi.waitFor(() => expect(useApp.getState().recoveryStatus).toBe('ready'));
  expect(sessionStore('session')?.getState().info.state).toBe('running');
  fake.emit(event(2, 'idle'));
  expect(sessionStore('session')?.getState().info.state).toBe('running');
});

it('resnapshots gaps instead of accepting an out-of-order event', async () => {
  const read = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValue(snapshot(3));
  const fake = bridge(read);
  stop = connectRecovery();
  await vi.waitFor(() => expect(useApp.getState().recoveryStatus).toBe('ready'));
  fake.emit({
    kind: 'event',
    type: 'session.state',
    sessionId: 'session',
    epoch: 'first',
    sequence: 3,
    state: 'running',
  });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(useApp.getState().recoveryStatus).toBe('ready'));
  expect(sessionStore('session')?.getState().info.state).toBe('idle');
});

it('cannot overwrite a new epoch with a snapshot already in flight', async () => {
  let release!: (value: EngineSnapshot) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<EngineSnapshot>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(snapshot(1, 'second'));
  const fake = bridge(read);
  stop = connectRecovery();
  fake.emit({
    kind: 'event',
    type: 'session.state',
    sessionId: 'session',
    epoch: 'second',
    sequence: 1,
    state: 'running',
  });
  release(snapshot());
  await vi.waitFor(() => expect(useApp.getState().recoveryStatus).toBe('ready'));
  expect(read).toHaveBeenCalledTimes(2);
  fake.emit({
    kind: 'event',
    type: 'session.state',
    sessionId: 'session',
    epoch: 'second',
    sequence: 2,
    state: 'needs-you',
  });
  expect(sessionStore('session')?.getState().info.state).toBe('needs-you');
});

it('restores uncertain text and review scratch without issuing an effect', () => {
  const fake = bridge(async () => snapshot());
  const review = {
    scope: { kind: 'session' as const },
    comments: [],
    note: 'Keep this note',
    editing: { path: 'notes.txt', side: 'new' as const, line: 1, text: 'Still typing' },
  };
  restoreSnapshot(snapshot(), {
    ...ui,
    drafts: { session: { text: 'next thought', pendingSend: 'unknown result', review } },
  });
  expect(sessionStore('session')?.getState()).toMatchObject({
    composerText: 'unknown result\nnext thought',
    pendingSend: null,
    reviewDraft: review,
  });
  expect(fake.request).not.toHaveBeenCalled();
  actions.editComposer('session', 'edited');
  expect(sessionStore('session')?.getState().reviewDraft).toEqual(review);
});

it('new idle-engine ready watermark resnapshots before enabling old stores', async () => {
  let release!: (value: EngineSnapshot) => void;
  const read = vi
    .fn()
    .mockResolvedValueOnce(snapshot())
    .mockImplementationOnce(
      () =>
        new Promise<EngineSnapshot>((resolve) => {
          release = resolve;
        }),
    );
  const fake = bridge(read);
  stop = connectRecovery();
  await vi.waitFor(() => expect(useApp.getState().recoveryStatus).toBe('ready'));
  fake.emit({ kind: 'event', type: 'engine.error', message: 'Previous engine exited' });
  fake.emit({
    kind: 'event',
    type: 'engine.ready',
    engineVersion: 'test',
    pid: 2,
    epoch: 'second',
    sequence: 0,
  });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(useApp.getState()).toMatchObject({ recoveryStatus: 'loading', engineOffline: true });
  const restored = snapshot(0, 'second');
  const session = restored.sessions[0];
  if (!session) throw new Error('Recovery fixture session missing');
  session.interrupted = true;
  session.session.title = 'Authoritative restarted engine';
  release(restored);
  await vi.waitFor(() => expect(useApp.getState().recoveryStatus).toBe('ready'));
  expect(useApp.getState().engineOffline).toBe(false);
  expect(sessionStore('session')?.getState().info.title).toBe('Authoritative restarted engine');
});

it('failed resnapshot after restarted-engine ready keeps old stores offline', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(snapshot())
    .mockRejectedValueOnce(new Error('Read failed'));
  const fake = bridge(read);
  stop = connectRecovery();
  await vi.waitFor(() => expect(useApp.getState().recoveryStatus).toBe('ready'));
  fake.emit({ kind: 'event', type: 'engine.error', message: 'Previous engine exited' });
  fake.emit({
    kind: 'event',
    type: 'engine.ready',
    engineVersion: 'test',
    pid: 2,
    epoch: 'second',
    sequence: 0,
  });
  await vi.waitFor(() => expect(useApp.getState().recoveryStatus).toBe('failed'));
  expect(useApp.getState().engineOffline).toBe(true);
  expect(sessionStore('session')?.getState().info.title).toBe('Restored');
});

it('fails closed when no consistent snapshot is available and detaches listeners', async () => {
  const fake = bridge(async () => {
    throw new Error('disk full');
  });
  stop = connectRecovery();
  await vi.waitFor(() => expect(useApp.getState().recoveryStatus).toBe('failed'));
  expect(useApp.getState().notice).toContain('disk full');
  expect(fake.closeHooks.size).toBe(2);
  stop();
  expect(fake.closeHooks.size).toBe(0);
  fake.emit({
    kind: 'event',
    type: 'engine.ready',
    engineVersion: 'test',
    pid: 1,
    epoch: 'second',
    sequence: 1,
  });
  expect(fake.request).toHaveBeenCalledTimes(1);
});

it('keeps a dequeued message visible when the effect outcome is unknown and no turn exists', () => {
  const fake = bridge(async () => snapshot());
  const state = snapshot();
  state.operations = [
    {
      id: 'queued-intent',
      command: 'session.turn',
      sessionId: 'session',
      text: 'Previously accepted queue text',
      state: 'unknown',
      at: 1,
    },
  ];
  restoreSnapshot(state, ui);
  expect(sessionStore('session')?.getState().queue?.items).toEqual([]);
  expect(sessionStore('session')?.getState().turns).toEqual([]);
  expect(useApp.getState().recoveryOperations).toEqual(state.operations);
  expect(fake.request).not.toHaveBeenCalled();
});
