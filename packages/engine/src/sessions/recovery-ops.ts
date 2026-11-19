import {
  applyDelta,
  type EngineEvent,
  type RecoverySession,
  type SetupSpec,
} from '@solline/protocol';
import { ProjectChecks } from '../checks/project-checks.ts';
import { SessionLedger } from '../ledger/ledger.ts';
import { SessionQuality } from '../quality/session-quality.ts';
import { interruptedAdapter } from '../recovery/interrupted-adapter.ts';
import type { SavedSession } from '../recovery/state.ts';
import { createTaskState, syncTaskState } from './task-state.ts';
import type { SessionHost, SessionMemory } from './types.ts';

/**
 * Coordena captura de vista canónica de recuperação (`observeRecovery`), serialização no diário e
 * restauração após reinício ou falha sem nunca retomar trabalho ou abrir processos de agente.
 */
export class SessionRecoveryCoordinator {
  readonly #host: SessionHost;

  constructor(host: SessionHost) {
    this.#host = host;
  }

  /** The UI projection also captures events which adapters do not put into their transcript. */
  observeRecovery(event: EngineEvent): void {
    if (!('sessionId' in event) || !event.sessionId) return;
    const id = event.sessionId;
    const entry = this.#host.sessions.get(id);
    const memory = this.#host.memory.get(id);
    if (!entry || !memory) return;
    let view = this.#host.recoveryViews.get(id);
    if (!view) {
      view = {
        session: structuredClone(entry.info),
        capabilities: null,
        turns: [],
        usage: { costUsd: null, models: [], context: null, tokens: null },
        queue: memory.cycle.queue,
        timeline: null,
        quality: null,
        checks: null,
        conflicts: null,
        interrupted: false,
        error: null,
      };
      this.#host.recoveryViews.set(id, view);
    }
    if (event.type === 'session.event') {
      const delta = event.delta;
      if (delta.type === 'usage') view.usage = { ...view.usage, ...delta.usage };
      if (delta.type === 'capabilities') view.capabilities = delta.capabilities;
    } else if (event.type === 'permission.request') {
      memory.turns = applyDelta(memory.turns, {
        type: 'block.upsert',
        turnId: event.turnId,
        block: event.request,
      });
      memory.taskState = syncTaskState(memory.taskState, { turns: memory.turns });
    } else if (event.type === 'session.timeline') {
      view.timeline = event.timeline;
      memory.taskState = syncTaskState(memory.taskState, {
        checkpointTurnIds: event.timeline.checkpoints
          .filter((c) => c.state === 'done')
          .map((c) => c.turnId),
      });
    } else if (event.type === 'session.checks') {
      view.checks = event.checks;
      memory.taskState = syncTaskState(memory.taskState, {
        checks: event.checks,
        repairFixes: this.#host.repairs.get(id)?.view().fixes,
      });
    } else if (event.type === 'session.quality') view.quality = event.quality;
    else if (event.type === 'session.state') view.error = event.error ?? null;
  }

  recovery(): SavedSession[] {
    return [
      ...this.#host.unavailableHistory.values(),
      ...[...this.#host.sessions.values()].map((entry) => {
        const memory = this.#host.memoryOf(entry.info.id);
        const saved = this.#host.recoveryViews.get(entry.info.id);
        let capabilities = saved?.capabilities ?? null;
        try {
          capabilities ??= entry.adapter.capabilities();
        } catch {
          /* Startup has no capabilities yet. */
        }
        const view: RecoverySession = {
          session: entry.info,
          capabilities,
          turns: memory.turns,
          usage: saved?.usage ?? { costUsd: null, models: [], context: null, tokens: null },
          queue: memory.cycle.queue,
          timeline: memory.checkpoints?.timeline() ?? saved?.timeline ?? null,
          quality: memory.quality?.state ?? saved?.quality ?? null,
          checks: this.#host.checks.get(entry.info.cwd)?.state ?? saved?.checks ?? null,
          conflicts: saved?.conflicts ?? null,
          interrupted: saved?.interrupted ?? false,
          error: saved?.error ?? null,
          ...((this.#host.ledgers.get(entry.info.id)?.view() ?? saved?.ledger)
            ? { ledger: this.#host.ledgers.get(entry.info.id)?.view() ?? saved?.ledger }
            : {}),
          taskState: structuredClone(memory.taskState),
        };
        return {
          view,
          trusted: entry.trusted,
          points: [...memory.points],
          ...(memory.context ? { context: memory.context } : {}),
          ...(memory.intro ? { intro: memory.intro } : {}),
          ...(memory.rules.delivered.size ? { rulesDelivered: [...memory.rules.delivered] } : {}),
          named: memory.named,
          ...(memory.worktree ? { worktree: memory.worktree } : {}),
          checkpoints: memory.checkpoints?.recovery() ?? null,
        };
      }),
    ].map((saved) => structuredClone(saved));
  }

  recoverySetups(): [string, SetupSpec | null][] {
    return structuredClone([...this.#host.setups]);
  }

  restoreRecovery(records: SavedSession[], setups: [string, SetupSpec | null][]): void {
    const hasReviewer = Boolean(this.#host.reviewer ?? this.#host.pickReviewer);
    for (const [id, setup] of setups) this.#host.setups.set(id, setup);
    for (const record of structuredClone(records)) {
      const view = record.view;
      view.interrupted = true;
      view.error = 'Sessão recuperada após interrupção. Nenhuma ação foi retomada automaticamente.';
      view.session.state = 'error';
      delete view.session.port;
      if (view.session.setup?.state === 'running')
        view.session.setup = {
          ...view.session.setup,
          state: 'failed',
          tail: 'Preparação interrompida; repete-a explicitamente.',
        };
      view.queue.paused = true;
      for (const turn of view.turns)
        for (const block of turn.blocks) {
          if (
            (block.kind === 'permission' || block.kind === 'plan' || block.kind === 'question') &&
            block.status === 'pending'
          )
            block.status = 'cancelled';
          if (block.kind === 'tool' && block.state === 'running') block.state = 'error';
        }
      if (view.quality?.review.state === 'running')
        view.quality.review = {
          ...view.quality.review,
          state: 'error',
          error: 'Revisão interrompida.',
        };
      if (view.checks)
        for (const result of view.checks.results)
          if (result.state === 'running' || result.state === 'pending') {
            result.state = 'failed';
            result.tail = 'Verificação interrompida; resultado desconhecido.';
          }
      const definition = this.#host.registry.get(view.session.agent);
      if (!definition || !view.capabilities) {
        this.#host.unavailableHistory.set(view.session.id, record);
        continue;
      }
      const info = view.session;
      const cycle = this.#host.turnsFor(() => info);
      cycle.restore(view.queue);
      const deliveredRules = record.rulesDelivered ?? [];
      const checkpoints = record.checkpoints
        ? this.#host.store?.open(
            info.id,
            info.cwd,
            () => this.#host.rewindKind(info.id),
            record.checkpoints,
          )
        : undefined;
      const checkpointTurnIds =
        view.timeline?.checkpoints.filter((c) => c.state === 'done').map((c) => c.turnId) ??
        checkpoints?.timeline().checkpoints.filter((c) => c.state === 'done').map((c) => c.turnId) ??
        [];
      const taskState = view.taskState
        ? syncTaskState(view.taskState, {
            turns: view.turns,
            checkpointTurnIds,
            checks: view.checks,
          })
        : syncTaskState(
            createTaskState({
              sessionId: info.id,
              activeRuleIds: deliveredRules,
            }),
            {
              turns: view.turns,
              checkpointTurnIds,
              checks: view.checks,
            },
          );
      const memory: SessionMemory = {
        turns: view.turns,
        points: new Map(record.points),
        context: record.context,
        intro: record.intro,
        rules: { delivered: new Set(deliveredRules), scanned: new Set() },
        startupRuleIds: [],
        usedMemoryIds: new Set(taskState.usedMemoryIds),
        taskState,
        openTurn: null,
        cycle,
        checkpoints,
        quality: undefined,
        worktree: record.worktree,
        named: record.named,
        bornTitled: false,
        naming: undefined,
        bringing: undefined,
        preparing: undefined,
        closing: false,
      };
      if (hasReviewer && view.quality)
        memory.quality = new SessionQuality({
          reviewer: this.#host.reviewer,
          enabled: view.quality.enabled,
          recovery: view.quality,
          emit: (quality) =>
            this.#host.emit({
              kind: 'event',
              type: 'session.quality',
              sessionId: info.id,
              quality,
            }),
        });
      this.#host.memory.set(info.id, memory);
      this.#host.sessions.set(info.id, {
        info,
        definition,
        trusted: record.trusted,
        mcp: [],
        adapter: interruptedAdapter(view.capabilities, info.agentSessionId),
      });
      this.#host.recoveryViews.set(info.id, view);
      if (view.ledger) this.#host.ledgers.set(info.id, SessionLedger.fromView(view.ledger));
      if (this.#host.checksOptions && view.checks && !this.#host.checks.has(info.cwd)) {
        this.#host.checks.set(
          info.cwd,
          new ProjectChecks({
            cwd: info.cwd,
            saved: view.checks.detected ? null : view.checks.specs,
            trusted: record.trusted,
            recovery: view.checks,
            ...this.#host.checksOptions,
            emit: (checks) => {
              for (const entry of this.#host.sessions.values())
                if (entry.info.cwd === info.cwd)
                  this.#host.emit({
                    kind: 'event',
                    type: 'session.checks',
                    sessionId: entry.info.id,
                    checks,
                  });
            },
          }),
        );
        this.#host.checkProjects.set(info.cwd, info.projectId);
      }
    }
  }

  async preserveRecovery(): Promise<void> {
    await Promise.all(
      [...this.#host.memory.values()].map(async (memory) => {
        await memory.naming;
        await memory.checkpoints?.preserve();
      }),
    );
  }

  async reconcileRecovery(): Promise<void> {
    for (const [id, memory] of this.#host.memory) {
      if (!memory.worktree || !this.#host.worktrees) continue;
      try {
        memory.worktree = await this.#host.worktrees.recover(memory.worktree);
        const entry = this.#host.sessions.get(id);
        if (entry?.info.workspace?.kind === 'worktree')
          entry.info.workspace = { ...entry.info.workspace, branch: memory.worktree.branch };
      } catch (error) {
        this.#host.unresolvedWorktrees.add(id);
        const view = this.#host.recoveryViews.get(id);
        if (view) view.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  assertRecoveryReady(sessionId: string): void {
    if (this.#host.unresolvedWorktrees.has(sessionId))
      throw new Error(
        this.#host.recoveryViews.get(sessionId)?.error ??
          'A worktree recuperada precisa de confirmação manual.',
      );
  }

  async stopForRecovery(): Promise<void> {
    this.#host.markStopping();
    for (const memory of this.#host.memory.values()) {
      memory.cycle.hold();
      memory.cycle.interrupted();
      memory.preparing?.abort();
      memory.quality?.dispose();
    }
    for (const checks of this.#host.checks.values()) checks.dispose();
    this.#host.consult?.stop();
    for (const entry of this.#host.sessions.values()) entry.brain?.revoke();
    await Promise.all([...this.#host.sessions.values()].map((entry) => entry.adapter.close()));
  }
}
