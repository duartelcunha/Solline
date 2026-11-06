import { z } from 'zod';
import { EngineEvent, RecoveryOperation, applyDelta } from '@solline/protocol';
import { RecoveryState, SavedSession } from './state.ts';

export const RecoveryRecord = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), state: RecoveryState }).strict(),
  z
    .object({ kind: z.literal('event'), event: EngineEvent, session: SavedSession.optional() })
    .strict(),
  z.object({ kind: z.literal('operation'), operation: RecoveryOperation }).strict(),
]);
export type RecoveryRecord = z.infer<typeof RecoveryRecord>;

export function replay(records: readonly RecoveryRecord[], initial: RecoveryState): RecoveryState {
  let state = structuredClone(initial);
  for (const record of records) {
    if (record.kind === 'snapshot') {
      state = structuredClone(record.state);
      continue;
    }
    if (record.kind === 'operation') {
      state.snapshot.operations = state.snapshot.operations.filter(
        (op) => op.id !== record.operation.id,
      );
      state.snapshot.operations.push(record.operation);
      continue;
    }
    const { event } = record;
    state.snapshot.sequence = event.sequence ?? state.snapshot.sequence;
    state.snapshot.epoch = event.epoch ?? state.snapshot.epoch;
    if (event.type === 'spaces.changed') state.snapshot.spaces = structuredClone(event.spaces);
    if (event.type === 'rules.changed') state.snapshot.rules = structuredClone(event.rules);
    if (event.type === 'race.state') {
      state.snapshot.races = state.snapshot.races.filter((race) => race.id !== event.race.id);
      state.snapshot.races.push(event.race);
    }
    if (record.session) {
      state.sessions = state.sessions.filter(
        (session) => session.view.session.id !== record.session?.view.session.id,
      );
      state.sessions.push(structuredClone(record.session));
      // The captured session already includes this event.
      continue;
    }
    if (!('sessionId' in event)) continue;
    const saved = state.sessions.find((session) => session.view.session.id === event.sessionId);
    if (!saved) continue;
    const view = saved.view;
    switch (event.type) {
      case 'session.event': {
        const delta = event.delta;
        view.turns = applyDelta(view.turns, delta);
        if (delta.type === 'usage') view.usage = { ...view.usage, ...delta.usage };
        if (delta.type === 'settings')
          view.session.settings = { ...view.session.settings, ...delta.settings };
        if (delta.type === 'meta') view.session.agentSessionId = delta.agentSessionId;
        if (delta.type === 'capabilities') view.capabilities = delta.capabilities;
        break;
      }
      case 'permission.request':
        view.turns = applyDelta(view.turns, {
          type: 'block.upsert',
          turnId: event.turnId,
          block: event.request,
        });
        break;
      case 'session.state':
        view.session.state = event.state;
        view.error = event.error ?? null;
        break;
      case 'session.queue':
        view.queue = event.queue;
        break;
      case 'session.timeline':
        view.timeline = event.timeline;
        break;
      case 'session.quality':
        view.quality = event.quality;
        break;
      case 'session.checks':
        view.checks = event.checks;
        break;
      case 'session.setup':
        view.session.setup = event.setup;
        break;
      case 'session.workspace':
        view.session.workspace = event.workspace;
        break;
      case 'session.handoff':
        if (event.handedTo) view.session.handedTo = event.handedTo;
        else delete view.session.handedTo;
        break;
      case 'session.archived':
        view.session.archived = true;
        break;
    }
  }
  state.snapshot.sessions = state.sessions.map((session) => session.view);
  state.snapshot.operations = state.snapshot.operations.map((operation) =>
    operation.state === 'prepared' ? { ...operation, state: 'unknown' } : operation,
  );
  return state;
}
