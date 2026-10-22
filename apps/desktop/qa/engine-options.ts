import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  registryOf,
  userTurnDelta,
  type AgentAdapterFactory,
  type EngineOptions,
} from '@solline/engine';
import type { PermissionBlock } from '@solline/protocol';
import { capabilities } from './fixtures';

// Only the test build imports this factory. No real registry, SDK or network fallback.
const qaCapabilities = {
  ...capabilities,
  features: { ...capabilities.features, cost: false, context: false, steer: false },
};
const create: AgentAdapterFactory = (options, sink) => {
  let completed = options.fork ? Number(options.fork) : 0;
  if (!Number.isSafeInteger(completed) || completed < 0)
    throw new Error('QA: invalid rewind point');
  let pending: { turnId: string; request: PermissionBlock; text: string } | null = null;
  let closed = false;
  const settings = {
    model: options.model ?? 'sonnet',
    effort: options.effort ?? 'high',
    mode: options.mode ?? 'default',
  };
  return {
    async start() {
      return { capabilities: qaCapabilities, settings };
    },
    capabilities: () => qaCapabilities,
    agentSessionId: () => 'solline-scripted-qa-agent',
    rewindPoint: () => (completed ? String(completed) : null),
    async send(text, sendOptions) {
      if (closed || pending) throw new Error('QA: unexpected concurrent send');
      const id = sendOptions?.turnId;
      if (!id) throw new Error('QA: engine must assign the user turn id');
      sink.delta(userTurnDelta(id, text));
      sink.state('running');
      if (text === 'QA: falha numa pista' && settings.model === 'opus') {
        sink.state('error', 'QA: falha determinística do agente opus');
        return id;
      }
      const turnId = `${id}:answer`;
      sink.delta({ type: 'turn.start', turn: { id: turnId, role: 'assistant', blocks: [] } });
      const request: PermissionBlock = {
        kind: 'permission',
        id: `${id}:permission`,
        title: 'Atualizar notes.txt',
        toolName: 'Edit',
        toolUseId: `${id}:edit`,
        input: { path: 'notes.txt' },
        canAlwaysAllow: false,
        defaultToNo: false,
        status: 'pending',
      };
      pending = { turnId, request, text };
      sink.ask(turnId, request);
      sink.state('needs-you');
      return id;
    },
    answerPermission(id, answer) {
      if (id !== pending?.request.id || closed) return false;
      const current = pending;
      pending = null;
      const allowed = answer.decision === 'allow-once' || answer.decision === 'allow-always';
      // Explicit scenarios produce distinct real patches/check outcomes per model.
      const content =
        current.text === 'QA: corrida com empate'
          ? `Solução ${settings.model}.\n`
          : current.text === 'QA: corrida com falha' && settings.model === 'opus'
            ? 'BROKEN\n'
            : 'Alteração revista.\n';
      if (allowed) writeFileSync(join(options.cwd, 'notes.txt'), content);
      sink.delta({
        type: 'block.upsert',
        turnId: current.turnId,
        block: { ...current.request, status: allowed ? 'allowed' : 'denied' },
      });
      sink.delta({ type: 'turn.end', turnId: current.turnId, outcome: 'done' });
      completed += 1;
      sink.state('idle');
      return true;
    },
    async interrupt() {
      if (pending) {
        sink.delta({
          type: 'block.upsert',
          turnId: pending.turnId,
          block: { ...pending.request, status: 'denied' },
        });
        sink.delta({ type: 'turn.end', turnId: pending.turnId, outcome: 'interrupted' });
        pending = null;
      }
      sink.state('idle');
    },
    async setModel(model) {
      settings.model = model;
      sink.delta({ type: 'settings', settings: { model } });
    },
    async setMode(mode) {
      settings.mode = mode;
      sink.delta({ type: 'settings', settings: { mode } });
    },
    async setEffort(effort) {
      settings.effort = effort;
      sink.delta({ type: 'settings', settings: { effort } });
    },
    async close() {
      closed = true;
      pending = null;
    },
  };
};

export function engineOptions(): EngineOptions {
  return {
    dataDir: process.env.SOLLINE_DATA_DIR,
    isolated: true,
    reviewer: false,
    checks: {},
    registry: registryOf([
      {
        id: 'claude',
        label: 'Claude QA',
        transport: 'claude-sdk',
        envPolicy: { base: 'no-secrets', keys: [] },
        defaultMode: 'default',
        staticModes: qaCapabilities.modes,
        untrustedProjects: 'allowed',
        detect: async () => ({ status: 'ready' }),
        create,
      },
    ]),
  };
}
