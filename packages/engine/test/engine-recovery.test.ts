import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EngineSnapshot,
  SpacesState,
  RecoveryOperationDetails,
  type AgentCapabilities,
  type EngineEvent,
} from '@solline/protocol';
import { Engine, type EngineOptions } from '../src/engine.ts';
import { SessionCheckpoints } from '../src/checkpoints/session-checkpoints.ts';
import { SessionQuality } from '../src/quality/session-quality.ts';
import { registryOf } from '../src/agents/registry.ts';
import type { AdapterSink, AgentStartOptions } from '../src/adapters/types.ts';
import { RaceManager } from '../src/races/race-manager.ts';

const key = Buffer.alloc(32, 11);
const roots: string[] = [];
const engines: Engine[] = [];
const capabilities: AgentCapabilities = {
  models: [],
  modes: [],
  effort: false,
  effortOrder: [],
  features: { cost: false, context: false, resume: true, rewind: false },
};
function gate() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let id = 0;
async function request(engine: Engine, command: string, payload: unknown = {}) {
  const result = await engine.handle({ kind: 'request', id: `recovery-${++id}`, command, payload });
  if (!result.ok) throw new Error(result.error.message);
  return result.result;
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'solline-engine-recovery-'));
  roots.push(root);
  const project = path.join(root, 'project');
  mkdirSync(project);
  const dataDir = path.join(root, 'data');
  const controls = {
    starts: [] as AgentStartOptions[],
    sends: [] as string[],
    sinks: [] as AdapterSink[],
    failAfterEffect: false,
    beforeTurnEvent: undefined as (() => Promise<void>) | undefined,
    beforeClose: undefined as (() => Promise<void>) | undefined,
    beforeStart: undefined as (() => Promise<void>) | undefined,
    active: false,
  };
  const registry = registryOf([
    {
      id: 'scripted',
      label: 'Scripted',
      transport: 'acp',
      defaultMode: null,
      staticModes: [],
      untrustedProjects: 'allowed',
      envPolicy: { base: 'no-secrets', keys: [] },
      detect: async () => ({ status: 'ready' }),
      create: (options, sink) => {
        controls.sinks.push(sink);
        return {
          start: async () => {
            controls.starts.push(options);
            await controls.beforeStart?.();
            controls.active = true;
            sink.delta({ type: 'meta', agentSessionId: 'provider-history' });
            return { capabilities, settings: { model: null, effort: null, mode: null } };
          },
          send: async (text, options) => {
            controls.sends.push(text);
            await controls.beforeTurnEvent?.();
            const turnId = options?.turnId ?? 'turn';
            sink.delta({
              type: 'turn.start',
              turn: {
                id: turnId,
                role: 'user',
                blocks: [{ kind: 'text', id: 'text', text, parentToolId: null }],
              },
            });
            sink.state('running');
            if (controls.failAfterEffect) throw new Error('response lost after provider accepted');
            return turnId;
          },
          interrupt: async () => sink.state('idle'),
          close: async () => {
            await controls.beforeClose?.();
            controls.active = false;
          },
          setMode: async () => undefined,
          setModel: async () => undefined,
          answerPermission: () => false,
          capabilities: () => capabilities,
          agentSessionId: () => 'provider-history',
        };
      },
    },
  ]);
  function open(
    directory = dataDir,
    checkpoints = false,
    reviewer: EngineOptions['reviewer'] = false,
  ) {
    const events: EngineEvent[] = [];
    const engine = new Engine({
      registry,
      dataDir: directory,
      recoveryKey: key,
      isolated: true,
      checkpoints: checkpoints ? {} : false,
      checks: false,
      reviewer,
      worktrees: false,
      emit: (event) => events.push(event),
    });
    engines.push(engine);
    return { engine, events };
  }
  return { root, project, dataDir, controls, open };
}
async function start(engine: Engine, cwd: string) {
  const result = (await request(engine, 'session.start', {
    projectId: 'project',
    cwd,
    agent: 'scripted',
    trusted: true,
  })) as { session: { id: string } };
  return result.session.id;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable engine recovery', () => {
  it('guarda o resultado e a conversa da tarefa mesmo depois de fechar a sessão', async () => {
    const f = fixture();
    const { engine } = f.open();
    await request(engine, 'spaces.syncProjects', {
      projects: [{ id: 'project', path: f.project, name: 'Projeto', trusted: true, addedAt: 0 }],
      generalCwd: f.project,
    });
    const task = (await request(engine, 'spaces.taskCreate', {
      projectId: 'project',
      title: 'Conservar o resultado',
      description: '',
    })) as { id: string };
    await request(engine, 'spaces.dispatch', {
      id: task.id,
      requestId: crypto.randomUUID(),
      target: { kind: 'new', agent: 'scripted' },
      text: 'Conservar o resultado',
      memoryIds: [],
      start: { projectId: 'project', cwd: f.project, trusted: true, agent: 'scripted' },
    });
    const sink = f.controls.sinks[0];
    if (!sink) throw new Error('Sem agente');
    sink.delta({
      type: 'turn.start',
      turn: {
        id: 'answer',
        role: 'assistant',
        blocks: [
          {
            kind: 'text',
            id: 'answer-text',
            text: 'A navegação ficou pronta.',
            parentToolId: null,
          },
        ],
      },
    });
    sink.delta({ type: 'turn.end', turnId: 'answer', outcome: 'done' });
    sink.state('idle');
    const before = SpacesState.parse(await request(engine, 'spaces.snapshot'));
    expect(before.tasks[0]?.status).toBe('review');
    const sessionId = before.tasks[0]?.attempts[0]?.sessionId;
    await request(engine, 'session.closeNow', { sessionId });
    const after = SpacesState.parse(await request(engine, 'spaces.snapshot'));
    expect(after.tasks[0]?.attempts[0]?.result).toBe('A navegação ficou pronta.');
    expect(after.tasks[0]?.attempts[0]?.conversation?.map((t) => t.role)).toEqual([
      'user',
      'assistant',
    ]);
  });
  it('preserva tarefas, memórias e delegações sem repetir envios ao reiniciar', async () => {
    const f = fixture();
    const { engine } = f.open();
    await request(engine, 'spaces.syncProjects', {
      projects: [{ id: 'project', path: f.project, name: 'Projeto', trusted: true, addedAt: 0 }],
      generalCwd: f.project,
    });
    const task = (await request(engine, 'spaces.taskCreate', {
      projectId: 'project',
      title: 'Uma tarefa durável',
      description: 'Preservar o contexto.',
    })) as { id: string };
    await request(engine, 'spaces.memorySave', {
      projectId: 'project',
      text: 'Preferir respostas curtas.',
      source: 'Duarte',
      state: 'active',
    });
    const payload = {
      id: task.id,
      requestId: crypto.randomUUID(),
      target: { kind: 'new', agent: 'scripted' },
      text: 'Uma tarefa durável',
      memoryIds: [],
      start: { projectId: 'project', cwd: f.project, trusted: true, agent: 'scripted' },
    };
    await request(engine, 'spaces.dispatch', payload);
    await expect(request(engine, 'spaces.dispatch', payload)).rejects.toThrow('já foi recebida');
    expect(f.controls.sends).toEqual(['Uma tarefa durável']);
    await engine.dispose();
    const restored = f.open().engine;
    const snapshot = EngineSnapshot.parse(await request(restored, 'engine.snapshot'));
    expect(snapshot.spaces?.tasks[0]?.title).toBe('Uma tarefa durável');
    expect(snapshot.spaces?.tasks[0]?.attempts[0]?.state).toBe('unknown');
    expect(snapshot.spaces?.memories[0]?.text).toBe('Preferir respostas curtas.');
    expect(f.controls.sends).toEqual(['Uma tarefa durável']);
  });
  it('restores interrupted races without automatically ranking or creating lanes', () => {
    const refused = async (): Promise<never> => {
      throw new Error('must not run on restore');
    };
    const events: EngineEvent[] = [];
    const races = new RaceManager({
      sessions: { create: refused, send: refused, close: refused, outcome: refused },
      emit: (event) => events.push(event),
      judge: refused,
    });
    races.restoreRecovery([
      {
        id: 'race',
        projectId: 'project',
        text: 'compare',
        phase: 'ranking',
        lanes: [
          { sessionId: 'one', agent: 'scripted', model: null, state: 'running' },
          { sessionId: 'two', agent: 'scripted', model: null, state: 'idle' },
        ],
      },
    ]);
    expect(races.get('race')).toMatchObject({
      phase: 'done',
      lanes: [{ state: 'error' }, { state: 'error' }],
    });
    expect(events).toEqual([]);
  });
  it('rehydrates canonical history and a paused queue without launching providers or replaying asks', async () => {
    const f = fixture();
    const { engine, events } = f.open();
    const sessionId = await start(engine, f.project);
    await request(engine, 'session.send', { sessionId, text: 'saved first message' });
    await request(engine, 'session.send', { sessionId, text: 'queued second message' });
    const sink = f.controls.sinks[0]!;
    const before = EngineSnapshot.parse(await request(engine, 'engine.snapshot'));
    sink.ask(before.sessions[0]!.turns[0]!.id, {
      kind: 'question',
      id: 'old-question',
      questions: [],
      status: 'pending',
    });
    await request(engine, 'engine.flush');
    const copy = path.join(f.root, 'crash-copy');
    cpSync(f.dataDir, copy, { recursive: true });
    // The copy is an isolated crash image, not another writer to the live data directory.
    rmSync(path.join(copy, 'recovery', 'engine-v1', 'writer.lock'));
    const next = f.open(copy).engine;
    const snapshot = EngineSnapshot.parse(await request(next, 'engine.snapshot'));
    expect(f.controls.starts).toHaveLength(1);
    expect(f.controls.sends).toEqual(['saved first message']);
    expect(snapshot.epoch).not.toBe(before.epoch);
    expect(snapshot.sessions[0]).toMatchObject({
      interrupted: true,
      session: { id: sessionId, state: 'error', agentSessionId: 'provider-history' },
      queue: { paused: true, items: [{ text: 'queued second message' }] },
    });
    expect(snapshot.sessions[0]!.turns[0]!.blocks).toContainEqual(
      expect.objectContaining({ id: 'old-question', status: 'cancelled' }),
    );
    await expect(request(next, 'session.resumeQueue', { sessionId })).rejects.toThrow('Retoma');
    await request(next, 'session.resume', { sessionId });
    expect(f.controls.starts).toHaveLength(2);
    expect(f.controls.starts[1]!.resume).toBe('provider-history');
    expect(f.controls.sends).toEqual(['saved first message']);
    await request(next, 'session.resumeQueue', { sessionId });
    expect(f.controls.sends).toEqual(['saved first message', 'queued second message']);
    expect(
      events.filter((event) => event.sequence !== undefined).map((event) => event.sequence),
    ).toEqual(events.filter((event) => event.sequence !== undefined).map((_, index) => index + 1));
  });
  it('restores an ambiguous provider side effect as unknown, without automatic resend', async () => {
    const f = fixture();
    const { engine } = f.open();
    const sessionId = await start(engine, f.project);
    f.controls.failAfterEffect = true;
    await expect(
      request(engine, 'session.send', { sessionId, text: 'accepted but response lost' }),
    ).rejects.toThrow('response lost');
    const copy = path.join(f.root, 'ambiguous-copy');
    cpSync(f.dataDir, copy, { recursive: true });
    rmSync(path.join(copy, 'recovery', 'engine-v1', 'writer.lock'));
    const snapshot = EngineSnapshot.parse(await request(f.open(copy).engine, 'engine.snapshot'));
    expect(snapshot.operations).toContainEqual(
      expect.objectContaining({
        command: 'session.turn',
        text: 'accepted but response lost',
        state: 'unknown',
      }),
    );
    expect(snapshot.sessions[0]!.turns[0]!.blocks[0]).toMatchObject({
      text: 'accepted but response lost',
    });
    expect(f.controls.sends).toHaveLength(1);
    expect(f.controls.starts).toHaveLength(1);
  });
  it('refuses side effects before dispatch if durable intent cannot be written', async () => {
    const f = fixture();
    const { engine } = f.open();
    const sessionId = await start(engine, f.project);
    const journal = path.join(f.dataDir, 'recovery', 'engine-v1', 'journal.ndjson');
    rmSync(journal);
    mkdirSync(journal);
    await expect(
      request(engine, 'session.send', { sessionId, text: 'must not dispatch' }),
    ).rejects.toThrow('Não foi possível guardar');
    expect(f.controls.sends).toEqual([]);
    expect(EngineSnapshot.parse(await request(engine, 'engine.snapshot')).durability.status).toBe(
      'failed',
    );
  });
  it('preserves dequeued text as an unknown intent when the process dies before turn.start', async () => {
    const f = fixture();
    const { engine } = f.open();
    const sessionId = await start(engine, f.project);
    await request(engine, 'session.send', { sessionId, text: 'first' });
    await request(engine, 'session.send', {
      sessionId,
      text: 'dequeued but not yet in transcript',
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.controls.beforeTurnEvent = () => held;
    try {
      f.controls.sinks[0]!.state('idle');
      const live = EngineSnapshot.parse(await request(engine, 'engine.snapshot'));
      expect(live.sessions[0]!.queue.items).toEqual([]);
      expect(JSON.stringify(live.sessions[0]!.turns)).not.toContain(
        'dequeued but not yet in transcript',
      );
      const copy = path.join(f.root, 'dequeued-crash-copy');
      cpSync(f.dataDir, copy, { recursive: true });
      rmSync(path.join(copy, 'recovery', 'engine-v1', 'writer.lock'));
      const snapshot = EngineSnapshot.parse(await request(f.open(copy).engine, 'engine.snapshot'));
      expect(snapshot.operations).toContainEqual(
        expect.objectContaining({
          command: 'session.turn',
          sessionId,
          text: 'dequeued but not yet in transcript',
          state: 'unknown',
        }),
      );
      expect(snapshot.sessions[0]!.queue).toEqual({ items: [], paused: true });
      expect(f.controls.starts).toHaveLength(1);
      expect(f.controls.sends).toEqual(['first', 'dequeued but not yet in transcript']);
    } finally {
      release();
    }
  });
  it('records review targets for human inspection while stripping credentials and environment', async () => {
    const f = fixture();
    const { engine } = f.open();
    const sessionId = await start(engine, f.project);
    // With checkpoints disabled this action fails, leaving intent but never mutating disk.
    await expect(
      request(engine, 'review.apply', {
        sessionId,
        action: 'reject',
        path: 'notes.txt',
        hunkId: 'hunk-1',
      }),
    ).rejects.toThrow();
    const live = EngineSnapshot.parse(await request(engine, 'engine.snapshot'));
    expect(live.operations).toContainEqual(
      expect.objectContaining({
        command: 'review.apply',
        sessionId,
        details: { action: 'reject', path: 'notes.txt', hunkId: 'hunk-1' },
      }),
    );
    expect(
      RecoveryOperationDetails.parse({
        agent: 'scripted',
        keys: { TOKEN: 'never persist' },
        env: { SECRET: 'never persist' },
      }),
    ).toEqual({ agent: 'scripted' });
  });
  it('does not start an automatic review when an end-turn checkpoint finishes during shutdown', async () => {
    const f = fixture();
    writeFileSync(path.join(f.project, 'notes.txt'), 'before\n');
    const reviewer = vi.fn(async () => []);
    const { engine } = f.open(f.dataDir, true, reviewer);
    const sessionId = await start(engine, f.project);
    await request(engine, 'session.send', { sessionId, text: 'edit' });
    writeFileSync(path.join(f.project, 'notes.txt'), 'after\n');
    const endGate = gate();
    const closeGate = gate();
    const closing = gate();
    const checkpointReady = gate();
    const original = SessionCheckpoints.prototype.endTurn;
    let end: Promise<void> = Promise.resolve();
    vi.spyOn(SessionCheckpoints.prototype, 'endTurn').mockImplementation(function (
      this: SessionCheckpoints,
      turnId,
    ) {
      end = original.call(this, turnId).then(async () => {
        checkpointReady.resolve();
        await endGate.promise;
      });
      return end;
    });
    const review = vi.spyOn(SessionQuality.prototype, 'review');
    f.controls.beforeClose = async () => {
      closing.resolve();
      await closeGate.promise;
    };
    f.controls.sinks[0]!.state('idle');
    await checkpointReady.promise;
    const shutdown = engine.shutdown();
    try {
      await closing.promise;
      endGate.resolve();
      await end;
      expect(review).not.toHaveBeenCalled();
      expect(reviewer).not.toHaveBeenCalled();
    } finally {
      endGate.resolve();
      closeGate.resolve();
      await shutdown;
    }
  }, 30_000);
  it('waits for an accepted session start before confirming shutdown and closes its late adapter', async () => {
    const f = fixture();
    const { engine } = f.open();
    const starting = gate();
    const release = gate();
    f.controls.beforeStart = async () => {
      starting.resolve();
      await release.promise;
    };
    const pending = start(engine, f.project);
    // Observe rejection immediately too: the assertion must never leak an unhandled promise.
    const result = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await starting.promise;
    let closed = false;
    const shutdown = engine.shutdown().then(() => {
      closed = true;
    });
    try {
      await setImmediate();
      expect(closed).toBe(false);
      expect(EngineSnapshot.parse(await request(engine, 'engine.snapshot')).lifecycle).toBe(
        'stopping',
      );
    } finally {
      release.resolve();
      await result;
      await shutdown;
    }
    expect(f.controls.active).toBe(false);
    expect(EngineSnapshot.parse(await request(engine, 'engine.snapshot')).lifecycle).toBe(
      'stopped',
    );
    const restored = EngineSnapshot.parse(
      await request(f.open(f.dataDir).engine, 'engine.snapshot'),
    );
    expect(restored.lifecycle).toBe('running');
    expect(restored.sessions).toHaveLength(1);
  });
  it('preserves real Git checkpoints through normal shutdown and never restores over external edits', async () => {
    const f = fixture();
    const file = path.join(f.project, 'notes.txt');
    writeFileSync(file, 'original\n');
    const { engine } = f.open(f.dataDir, true);
    const sessionId = await start(engine, f.project);
    await request(engine, 'session.send', { sessionId, text: 'edit notes' });
    writeFileSync(file, 'agent edit\n');
    f.controls.sinks[0]!.state('idle');
    await request(engine, 'engine.flush');
    const before = EngineSnapshot.parse(await request(engine, 'engine.snapshot'));
    expect(before.sessions[0]!.timeline?.checkpoints).toHaveLength(1);
    await request(engine, 'engine.shutdown');
    writeFileSync(file, 'external edit after shutdown\n');
    const next = f.open(f.dataDir, true).engine;
    const after = EngineSnapshot.parse(await request(next, 'engine.snapshot'));
    expect(after.sessions[0]!.timeline?.checkpoints).toEqual(
      before.sessions[0]!.timeline?.checkpoints,
    );
    expect(readFileSync(file, 'utf8')).toBe('external edit after shutdown\n');
    const diff = await request(next, 'review.diff', { sessionId, scope: { kind: 'session' } });
    expect(JSON.stringify(diff)).toContain('external edit after shutdown');
    expect(JSON.stringify(diff)).toContain('original');
  }, 30_000);
  it('requires an in-memory protection key for persistent engines', () => {
    const f = fixture();
    expect(() => new Engine({ dataDir: f.dataDir })).toThrow('chave protegida');
  });
});
