import { basename } from 'node:path';
import {
  applyDelta,
  findModel,
  type AgentCapabilities,
  type BudgetLimits,
  type CanonicalTaskState,
  type CheckSpec,
  type Checks,
  type ConversationRewind,
  type DiffScope,
  type EngineCommandResult,
  type EngineEvent,
  type FileDiff,
  type HandoffDraftedBy,
  type Orphan,
  type PermissionAnswer,
  type Quality,
  type RecoverySession,
  type ReviewAction,
  type ReviewComment,
  type ReviewScope,
  type ReviewTrigger,
  type SessionInfo,
  type SessionQueue,
  type SessionStartPayload,
  type SetupSpec,
  type Timeline,
  type Turn,
  type Workspace,
} from '@solline/protocol';
import { safestMode } from './adapters/acp/capabilities.ts';
import type { AdapterSink, AgentAdapter, McpServerLaunch } from './adapters/types.ts';
import type { AgentDefinition, AgentRegistry } from './agents/registry.ts';
import type { Brain, BrainBinding } from './brain/brain.ts';
import type { ProjectChecks } from './checks/project-checks.ts';
import type { SessionCheckpoints } from './checkpoints/session-checkpoints.ts';
import type { CheckpointStore } from './checkpoints/store.ts';
import type { RawFile } from './checkpoints/unified-diff.ts';
import type { ConsultManager, ConsultSource } from './consult/manager.ts';
import { isDelegateDigest } from './consult/messages.ts';
import { CONSULT_TOOL_NAMES } from './consult/names.ts';
import { readOnlyModeOf } from './consult/modes.ts';
import { SECRET_NAME, agentEnv } from './env.ts';
import { draftFilesOf, type DraftFile } from './handoff/drafter.ts';
import { CircuitOpenError, CircuitRegistry } from './kernel/circuit-breaker.ts';
import { SessionLedger, reportFromUsage } from './ledger/ledger.ts';
import type { McpCatalog } from './mcp/catalog.ts';
import { McpLaunchError } from './mcp/launch.ts';
import { currentTurn, turnText } from './memory/external.ts';
import type { MemoryService } from './memory/manager.ts';
import type { Reviewer } from './quality/reviewer.ts';
import type { ReviewerPicker } from './quality/routing.ts';
import { SessionQuality } from './quality/session-quality.ts';
import type { SavedSession } from './recovery/state.ts';
import type { RepairLoop } from './repair/loop.ts';
import { assistantText, commentsMessage, summaryOf, textOf } from './review.ts';
import { matchesAny } from './rules/glob.ts';
import type { RulesManager } from './rules/manager.ts';
import { renderStart, renderTouched } from './rules/render.ts';
import { SessionTurns, type How, type Submitted } from './session-turns.ts';
import { SessionHandoffCoordinator } from './sessions/handoff-fork.ts';
import { SessionQualityCoordinator } from './sessions/quality-checks.ts';
import { SessionRecoveryCoordinator } from './sessions/recovery-ops.ts';
import { createTaskState, syncTaskState, trimTaskStateToTurn } from './sessions/task-state.ts';
import {
  DISABLED_TIMELINE,
  MAX_MCP,
  NO_PROJECT_MCP,
  NO_STATS,
  READ_ONLY_DENIAL,
  RESTRICTED_RISKS,
  defaultCheckCwd,
  isConsult,
  keepsTitle,
  opensFromConsult,
  restrict,
  withBrain,
  type ChecksOptions,
  type CloseSessionResult,
  type SessionEntry,
  type SessionHost,
  type SessionMemory,
  type SessionResult,
} from './sessions/types.ts';
import { SessionWorkspaceCoordinator } from './sessions/workspace-ops.ts';
import type { CheckVerdict } from './verify/verify.ts';
import { PortAllocator } from './workspace/ports.ts';
import type { Worktree, WorktreeManager } from './worktrees/worktrees.ts';

export type { ChecksOptions } from './sessions/types.ts';

const ADAPTER_START_THRESHOLD = 3;
const ADAPTER_START_RESET_MS = 45_000;

function shouldTripAdapterStart(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  const message = error instanceof Error ? error.message : String(error);
  return !/login|autentica|inicia sessão|sign in|api key|untrusted|confian[çc]a|permiss[aã]o|cancelad|abortad|modo|modelo/i.test(
    message,
  );
}

/**
 * Todas as conversas vivas do motor. Cada uma tem o seu adaptador; o que o adaptador
 * conta passa a eventos da Ponte com o id da sessão.
 * A projeção canónica e os checkpoints podem ser guardados pelo motor. Recuperar esta
 * projeção nunca cria um adaptador nem retoma uma ação por iniciativa própria.
 */
export class SessionManager {
  #stopping = false;
  readonly #recoveryViews = new Map<string, RecoverySession>();
  readonly #ledgers = new Map<string, SessionLedger>();
  readonly #repairs = new Map<string, RepairLoop>();
  readonly #unavailableHistory = new Map<string, SavedSession>();
  readonly #unresolvedWorktrees = new Set<string>();
  readonly #beforeEffect: (command: string, sessionId: string, text?: string) => () => void;
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #memory = new Map<string, SessionMemory>();
  readonly #emit: (event: EngineEvent) => void;
  readonly #registry: AgentRegistry;
  readonly #mcp: McpCatalog | undefined;
  readonly #brain: Brain | undefined;
  readonly #consult: Pick<ConsultManager, 'interrupted' | 'sessionClosed' | 'stop'> | undefined;
  readonly #rules: RulesManager | undefined;
  readonly #memories: Pick<MemoryService, 'startBlock'> | undefined;
  readonly #checkCwd: (cwd: string) => Promise<void>;
  readonly #store: CheckpointStore | undefined;
  readonly #keysFor: (agent: string) => Promise<readonly string[]>;
  readonly #reviewer: Reviewer | undefined;
  readonly #pickReviewer: ReviewerPicker | undefined;
  readonly #checksOptions: ChecksOptions | undefined;
  readonly #circuits: CircuitRegistry;
  readonly #checks = new Map<string, ProjectChecks>();
  readonly #checkProjects = new Map<string, string>();
  readonly #worktrees: WorktreeManager | undefined;
  readonly #placing = new Set<string>();
  readonly #ports = new PortAllocator();
  readonly #setups = new Map<string, SetupSpec | null>();
  #claimed: () => readonly string[] = () => [];
  readonly #handingOff = new Set<string>();
  readonly #anchors = new Map<string, Worktree>();

  readonly #workspace: SessionWorkspaceCoordinator;
  readonly #quality: SessionQualityCoordinator;
  readonly #handoff: SessionHandoffCoordinator;
  readonly #recovery: SessionRecoveryCoordinator;

  constructor(options: {
    beforeEffect?: (command: string, sessionId: string, text?: string) => () => void;
    emit: (event: EngineEvent) => void;
    registry: AgentRegistry;
    mcp?: McpCatalog | undefined;
    brain?: Brain | undefined;
    consult?: Pick<ConsultManager, 'interrupted' | 'sessionClosed' | 'stop'> | undefined;
    rules?: RulesManager | undefined;
    memories?: Pick<MemoryService, 'startBlock'> | undefined;
    checkCwd?: (cwd: string) => Promise<void>;
    checkpoints?: CheckpointStore | undefined;
    keysFor?: (agent: string) => Promise<readonly string[]>;
    reviewer?: Reviewer | undefined;
    reviewerFor?: ReviewerPicker | undefined;
    checks?: ChecksOptions | undefined;
    worktrees?: WorktreeManager | undefined;
    circuits?: CircuitRegistry | undefined;
  }) {
    this.#emit = options.emit;
    this.#beforeEffect = options.beforeEffect ?? (() => () => undefined);
    this.#registry = options.registry;
    this.#mcp = options.mcp;
    this.#brain = options.brain;
    this.#consult = options.consult;
    this.#rules = options.rules;
    this.#memories = options.memories;
    this.#checkCwd = options.checkCwd ?? defaultCheckCwd;
    this.#store = options.checkpoints;
    this.#keysFor = options.keysFor ?? (async () => []);
    this.#reviewer = options.reviewer;
    this.#pickReviewer = options.reviewerFor;
    this.#checksOptions = options.checks;
    this.#worktrees = options.worktrees;
    this.#circuits = options.circuits ?? new CircuitRegistry();

    const host = this.#createHost();
    this.#workspace = new SessionWorkspaceCoordinator(host);
    this.#quality = new SessionQualityCoordinator(host);
    this.#handoff = new SessionHandoffCoordinator(host, (id) => this.#workspace.emitWorkspace(id));
    this.#workspace.bindHandedTo((id, to) => this.#handoff.setHandedTo(id, to));
    this.#recovery = new SessionRecoveryCoordinator(host);
  }

  #createHost(): SessionHost {
    return {
      sessions: this.#sessions,
      memory: this.#memory,
      recoveryViews: this.#recoveryViews,
      ledgers: this.#ledgers,
      repairs: this.#repairs,
      checks: this.#checks,
      checkProjects: this.#checkProjects,
      unavailableHistory: this.#unavailableHistory,
      unresolvedWorktrees: this.#unresolvedWorktrees,
      setups: this.#setups,
      handingOff: this.#handingOff,
      placing: this.#placing,
      anchors: this.#anchors,
      ports: this.#ports,
      worktrees: this.#worktrees,
      store: this.#store,
      registry: this.#registry,
      checksOptions: this.#checksOptions,
      circuits: this.#circuits,
      reviewer: this.#reviewer,
      pickReviewer: this.#pickReviewer,
      rules: this.#rules,
      consult: this.#consult,
      claimed: () => this.#claimed(),
      isStopping: () => this.#stopping,
      emit: (event) => this.#emit(event),
      beforeEffect: (cmd, id, text) => this.#beforeEffect(cmd, id, text),
      get: (id) => this.#get(id),
      memoryOf: (id) => this.#memoryOf(id),
      checkpoints: (id) => this.#checkpoints(id),
      rewindKind: (id) => this.#rewindKind(id),
      emitTimeline: (id, timeline) => this.#emitTimeline(id, timeline),
      emitRepair: (id) => this.#quality.emitRepair(id),
      repairOf: (id) => this.#quality.repairOf(id),
      requireWritable: (entry) => this.#requireWritable(entry),
      requireActive: (entry) => this.#requireActive(entry),
      requireIdle: (entry, memory, what) => this.#requireIdle(entry, memory, what),
      mcpFor: (def, ids) => this.#mcpFor(def, ids),
      startAdapter: (info, def, trusted, mcp, resume, requested, fork) =>
        this.#start(info, def, trusted, mcp, resume, requested, fork),
      deltaFor: (info, memory) => this.#deltaFor(info, memory),
      turnsFor: (info) => this.#turnsFor(info),
      create: (payload, inherit, forked) => this.create(payload, inherit, forked),
      send: (id, text, how, submissionId) => this.send(id, text, how, submissionId),
      close: (id, choice, dropQueue) => this.close(id, choice, dropQueue),
      backgroundFailure: (id, error) => this.#backgroundFailure(id, error),
      check: (id, turnId) => this.#quality.check(id, turnId),
      review: (id, turnId, how) => this.#quality.review(id, turnId, how),
      bring: (id) => this.#workspace.bring(id),
      closeSession: (id, choice, dropQueue) => this.#workspace.close(id, choice, dropQueue),
      checksFor: (projectId, cwd, trusted, saved, port) =>
        this.#quality.checksFor(projectId, cwd, trusted, saved, port),
      maybeRepair: (id, state) => this.#quality.maybeRepair(id, state),
      setClaimed: (paths) => {
        this.#claimed = paths;
      },
      markStopping: () => {
        this.#stopping = true;
      },
    };
  }

  get #hasReviewer(): boolean {
    return Boolean(this.#reviewer ?? this.#pickReviewer);
  }

  async create(
    payload: SessionStartPayload,
    inherit?: { workspace: Workspace },
    forked?: { worktree: Worktree; point?: string | undefined; named?: boolean },
  ): Promise<SessionResult> {
    const definition = this.#registry.get(payload.agent);
    if (!definition) throw new Error(`Agente desconhecido: ${payload.agent}`);
    if (!payload.trusted && definition.untrustedProjects === 'refused') {
      throw new Error(`O ${definition.label} só corre em projetos de confiança`);
    }
    await this.#checkCwd(payload.cwd);
    const known = definition.staticModes;
    if (payload.mode && known.length > 0 && !known.some((m) => m.id === payload.mode)) {
      throw new Error(`Modo desconhecido para este agente: ${payload.mode}`);
    }
    const asking = isConsult({ origin: payload.origin });
    if (
      asking &&
      payload.mode &&
      !definition.staticModes.some(
        (m) => m.id === payload.mode && (m.risk === 'read-only' || m.risk === 'plan'),
      )
    )
      throw new Error('Uma consulta só abre num modo de leitura');
    const explicit = [...new Set(payload.mcpServerIds ?? [])];
    const requested = await this.#mcpFor(definition, explicit);
    const restricted = requested.some((s) => s.executesCode);
    const risk = known.find((m) => m.id === payload.mode)?.risk;
    if (restricted && risk && RESTRICTED_RISKS.has(risk)) {
      throw new Error(
        'Com um servidor MCP que corre programas, escolhe um modo que pergunte antes',
      );
    }
    const chosen = await this.#projectMcp(definition, payload, explicit, requested.length, risk);
    const mcp = [...requested, ...chosen.launches];
    const mcpIds = [...explicit, ...chosen.ids];
    const place: { cwd: string; workspace: Workspace; worktree?: Worktree; key: string } = forked
      ? {
          cwd: forked.worktree.cwd,
          workspace: { kind: 'worktree', branch: forked.worktree.branch, stats: NO_STATS },
          worktree: forked.worktree,
          key: '',
        }
      : inherit
        ? { cwd: payload.cwd, workspace: structuredClone(inherit.workspace), key: '' }
        : await this.#workspace.placeFor(
            payload.projectId,
            payload.cwd,
            payload.worktree === 'always',
            payload.startAfter,
          );
    if (payload.setup !== undefined) this.#setups.set(payload.projectId, payload.setup);
    const sessionId = crypto.randomUUID();
    const port = await this.#ports.reserve(sessionId).catch(() => undefined);
    const prepares = Boolean(place.worktree && payload.trusted && this.#checksOptions);
    const info: SessionInfo = {
      id: sessionId,
      ...(payload.raceId ? { raceId: payload.raceId } : {}),
      ...(payload.origin ? { origin: payload.origin } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(prepares ? { setup: { state: 'running' as const, tail: null, durationMs: null } } : {}),
      projectId: payload.projectId,
      agent: payload.agent,
      cwd: place.cwd,
      workspace: place.workspace,
      title: payload.title ?? 'Nova sessão',
      state: 'starting',
      settings: {
        model: payload.model ?? null,
        effort: payload.effort ?? null,
        mode: payload.mode ?? definition.defaultMode,
      },
      agentSessionId: null,
      ...(mcp.length ? { mcpServers: mcpIds } : {}),
      ...(chosen.skipped.length ? { mcpSkipped: chosen.skipped } : {}),
    };
    const startupRuleIds =
      definition.rules && this.#rules
        ? this.#rules
            .deliver(payload.projectId)
            .filter((r) => r.globs.length === 0)
            .map((r) => r.id)
        : [];
    const memory: SessionMemory = {
      turns: [],
      checkpoints: undefined,
      points: new Map(),
      openTurn: null,
      cycle: this.#turnsFor(() => info),
      context: undefined,
      intro: undefined,
      rules: { delivered: new Set(), scanned: new Set() },
      startupRuleIds,
      usedMemoryIds: new Set(),
      taskState: createTaskState({
        sessionId: info.id,
        originalIntent: '',
        activeRuleIds: startupRuleIds,
      }),
      quality:
        this.#hasReviewer && !asking
          ? new SessionQuality({
              reviewer: this.#reviewer,
              enabled: true,
              emit: (quality) =>
                this.#emit({ kind: 'event', type: 'session.quality', sessionId: info.id, quality }),
            })
          : undefined,
      worktree: place.worktree,
      named: forked?.named === true,
      bornTitled: Boolean(payload.title),
      naming: undefined,
      bringing: undefined,
      preparing: undefined,
      closing: false,
    };
    this.#memory.set(info.id, memory);
    let result: SessionResult;
    try {
      result = await this.#start(
        info,
        definition,
        payload.trusted,
        mcp,
        undefined,
        { model: payload.model, effort: payload.effort },
        forked?.point,
      );
    } catch (error) {
      this.#memory.delete(info.id);
      this.#ports.release(info.id);
      if (place.worktree)
        await this.#worktrees?.remove(place.worktree, 'always').catch(() => undefined);
      throw error;
    } finally {
      this.#placing.delete(place.key);
    }
    this.#quality.checksFor(info.projectId, info.cwd, payload.trusted, payload.checks ?? null, port);
    if (prepares && place.worktree) {
      memory.cycle.hold();
      void this.#workspace.prepare(info.id, payload.cwd, place.worktree.cwd);
    }
    const checkpoints = asking
      ? undefined
      : this.#store?.open(info.id, info.cwd, () => this.#rewindKind(info.id));
    memory.checkpoints = checkpoints;
    void checkpoints?.ready.then(() => this.#emitTimeline(info.id));
    return result;
  }

  taskState(sessionId: string): CanonicalTaskState {
    this.#get(sessionId);
    return structuredClone(this.#memoryOf(sessionId).taskState);
  }

  recordMemoryUsed(sessionId: string, ids: readonly string[]): void {
    const memory = this.#memory.get(sessionId);
    if (!memory || ids.length === 0) return;
    let changed = false;
    for (const id of ids) {
      if (!memory.usedMemoryIds.has(id)) {
        memory.usedMemoryIds.add(id);
        changed = true;
      }
    }
    if (changed) {
      memory.taskState = syncTaskState(memory.taskState, {
        usedMemoryIds: [...memory.usedMemoryIds],
      });
    }
  }

  setProjectTrust(projectId: string, trusted: boolean): void {
    this.#quality.setProjectTrust(projectId, trusted);
  }

  async setProjectChecks(projectId: string, checks: CheckSpec[] | null): Promise<void> {
    await this.#quality.setProjectChecks(projectId, checks);
  }

  checks(sessionId: string): Checks {
    return this.#quality.checks(sessionId);
  }

  async runChecks(sessionId: string): Promise<Checks> {
    return this.#quality.runChecks(sessionId);
  }

  async fixCheck(sessionId: string, id: string): Promise<string> {
    return this.#quality.fixCheck(sessionId, id);
  }

  async resume(sessionId: string): Promise<SessionResult> {
    const entry = this.#get(sessionId);
    this.#requireWritable(entry);
    await this.#checkCwd(entry.info.cwd);
    if (!entry.adapter.capabilities().features.resume)
      throw new Error('Este agente não permite retomar esta sessão. O histórico foi preservado.');
    const resumeId = entry.adapter.agentSessionId();
    if (!resumeId) throw new Error('Esta sessão ainda não tem histórico no agente para retomar');
    await entry.adapter.close();
    const result = await this.#start(
      entry.info,
      entry.definition,
      entry.trusted,
      await this.#mcpFor(entry.definition, entry.info.mcpServers ?? []),
      resumeId,
    );
    const view = this.#recoveryViews.get(sessionId);
    if (view) {
      view.interrupted = false;
      view.error = null;
    }
    this.#memoryOf(sessionId).cycle.release();
    return result;
  }

  async send(
    sessionId: string,
    text: string,
    how: How = 'queue',
    submissionId?: string,
  ): Promise<Submitted> {
    this.#requireActive(this.#get(sessionId));
    if (this.#recoveryViews.get(sessionId)?.interrupted)
      throw new Error('Retoma a sessão recuperada antes de enviar.');
    return this.#memoryOf(sessionId).cycle.submit(text, how, submissionId);
  }

  async #startTurn(sessionId: string, text: string, submissionId?: string): Promise<string> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    const ledger = this.#ledgerOf(sessionId);
    const gate = ledger.gate(Date.now());
    if (!gate.ok) {
      this.#emitLedger(sessionId);
      throw new Error(gate.text);
    }
    ledger.noteTurn(Date.now());
    this.#emitLedger(sessionId);
    const completed = this.#beforeEffect('session.turn', sessionId, text);
    this.#checks.get(entry.info.cwd)?.cancel();
    const turnId = submissionId ?? crypto.randomUUID();
    const point = entry.adapter.rewindPoint?.();
    const checkpoints = memory.checkpoints;
    const touched = await this.#touchedRules(entry, memory);
    if (checkpoints) {
      const { staged, done } = checkpoints.beginTurn(turnId, text);
      await staged;
      memory.openTurn = turnId;
      void done.then(() => {
        if (memory.openTurn === turnId) this.#emitTimeline(sessionId);
      });
    }
    const context =
      [memory.intro, memory.context, touched?.text].filter(Boolean).join('\n\n') || undefined;
    let sent: string;
    try {
      sent = await entry.adapter.send(text, { turnId, ...(context ? { context } : {}) });
    } catch (error) {
      if (checkpoints) {
        memory.openTurn = null;
        await checkpoints.truncate(turnId);
        this.#emitTimeline(sessionId);
      }
      throw error;
    }
    memory.context = undefined;
    memory.intro = undefined;
    for (const id of touched?.ids ?? []) memory.rules.delivered.add(id);
    for (const id of touched?.turns ?? []) memory.rules.scanned.add(id);
    if (touched?.ids.length) {
      memory.taskState = syncTaskState(memory.taskState, {
        activeRuleIds: [...memory.startupRuleIds, ...memory.rules.delivered],
      });
    }
    if (point !== undefined) memory.points.set(sent, point);
    if (memory.worktree && !memory.named) {
      memory.named = true;
      memory.naming = this.#workspace.nameBranch(sessionId, text);
    }
    completed();
    return sent;
  }

  #turnsFor(info: () => SessionInfo): SessionTurns {
    return new SessionTurns({
      start: (text, turnId) => this.#startTurn(info().id, text, turnId),
      steer: (text, id) => {
        const adapter = this.#sessions.get(info().id)?.adapter;
        return adapter?.steer ? adapter.steer(text, id) : Promise.resolve('too-late' as const);
      },
      running: () => {
        const state = this.#sessions.get(info().id)?.info.state;
        return state === 'running' || state === 'needs-you' || state === 'starting';
      },
      emit: (queue) =>
        this.#emit({ kind: 'event', type: 'session.queue', sessionId: info().id, queue }),
      failed: (error) =>
        this.#emit({
          kind: 'event',
          type: 'engine.error',
          sessionId: info().id,
          message: `A mensagem da fila não seguiu: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
  }

  queue(sessionId: string): SessionQueue {
    this.#get(sessionId);
    return this.#memoryOf(sessionId).cycle.queue;
  }

  unqueue(sessionId: string, id: string): boolean {
    this.#get(sessionId);
    return this.#memoryOf(sessionId).cycle.unqueue(id);
  }

  reorder(sessionId: string, ids: readonly string[]): void {
    this.#get(sessionId);
    this.#memoryOf(sessionId).cycle.reorder(ids);
  }

  resumeQueue(sessionId: string): void {
    this.#get(sessionId);
    if (this.#recoveryViews.get(sessionId)?.interrupted)
      throw new Error('Retoma a sessão recuperada antes de continuar a fila.');
    this.#memoryOf(sessionId).cycle.resume();
  }

  async timeline(sessionId: string): Promise<Timeline> {
    this.#get(sessionId);
    const checkpoints = this.#memoryOf(sessionId).checkpoints;
    if (!checkpoints) return DISABLED_TIMELINE(this.#rewindKind(sessionId));
    await checkpoints.ready;
    return checkpoints.refresh();
  }

  diff(sessionId: string, scope: DiffScope): Promise<FileDiff[]> {
    return this.#checkpoints(sessionId).diff(scope);
  }

  async review(
    sessionId: string,
    action: ReviewAction,
    path?: string,
    hunkId?: string,
  ): Promise<Timeline> {
    if (action === 'reject') {
      this.#requireActive(this.#get(sessionId));
      this.#requireIdle(this.#get(sessionId), this.#memoryOf(sessionId), 'rejeitar');
    }
    const checkpoints = this.#checkpoints(sessionId);
    const timeline = await checkpoints.apply(action, path, hunkId);
    if (action === 'reject' && checkpoints.available) {
      const files = draftFilesOf(await checkpoints.diff({ kind: 'session' }).catch(() => []));
      const memory = this.#memoryOf(sessionId);
      memory.taskState = syncTaskState(memory.taskState, { files });
    }
    this.#emitTimeline(sessionId, timeline);
    return timeline;
  }

  async undo(sessionId: string): Promise<Timeline> {
    this.#requireActive(this.#get(sessionId));
    this.#requireIdle(this.#get(sessionId), this.#memoryOf(sessionId), 'desfazer');
    const checkpoints = this.#checkpoints(sessionId);
    const timeline = await checkpoints.undo();
    this.#checks.get(this.#get(sessionId).info.cwd)?.reset();
    const memory = this.#memoryOf(sessionId);
    const files = checkpoints.available
      ? draftFilesOf(await checkpoints.diff({ kind: 'session' }).catch(() => []))
      : [];
    memory.taskState = syncTaskState(memory.taskState, {
      files,
      checkpointTurnIds: timeline.checkpoints.filter((c) => c.state === 'done').map((c) => c.turnId),
    });
    this.#emitTimeline(sessionId, timeline);
    return timeline;
  }

  async comment(sessionId: string, comments: ReviewComment[], note?: string): Promise<string> {
    const checkpoints = this.#memoryOf(sessionId).checkpoints;
    const files = checkpoints?.available ? await checkpoints.diff({ kind: 'review' }) : [];
    return (await this.send(sessionId, commentsMessage(comments, files, note))).turnId;
  }

  async rewind(
    sessionId: string,
    turnId: string,
    options: { files: boolean; conversation: boolean },
  ): Promise<{ timeline: Timeline; text: string | null; conversation: ConversationRewind | null }> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    if (options.files) this.#requireActive(entry);
    return memory.cycle.exclusive('rebobinar', () => this.#rewind(entry, memory, turnId, options));
  }

  async #rewind(
    entry: SessionEntry,
    memory: SessionMemory,
    turnId: string,
    options: { files: boolean; conversation: boolean },
  ): Promise<{ timeline: Timeline; text: string | null; conversation: ConversationRewind | null }> {
    const sessionId = entry.info.id;
    const index = memory.turns.findIndex((t) => t.id === turnId && t.role === 'user');
    if (index === -1) throw new Error('Este turno já não está na conversa');
    memory.quality?.reset();
    this.#checks.get(entry.info.cwd)?.reset();
    const userTurn = memory.turns[index];
    if (options.files) {
      const checkpoints = this.#checkpoints(sessionId);
      if (!checkpoints.has(turnId)) throw new Error('Este turno não tem checkpoint');
      await checkpoints.rewindFiles(turnId);
    }
    let kind: ConversationRewind | null = null;
    if (options.conversation) {
      const point = memory.points.get(turnId);
      kind = point !== undefined && entry.adapter.rewindPoint ? 'agent' : 'summary';
      const kept = memory.turns.slice(0, index);
      const dropped = memory.turns.slice(index).map((t) => t.id);
      await entry.adapter.close();
      const previous = entry.info.agentSessionId;
      entry.info.agentSessionId = null;
      try {
        await this.#start(
          entry.info,
          entry.definition,
          entry.trusted,
          await this.#mcpFor(entry.definition, entry.info.mcpServers ?? []),
          undefined,
          undefined,
          kind === 'agent' && point ? point : undefined,
        );
      } catch (error) {
        entry.info.agentSessionId = previous;
        throw error;
      }
      memory.context = kind === 'summary' ? summaryOf(kept) : undefined;
      if (kind === 'summary') {
        memory.rules.delivered.clear();
        memory.rules.scanned.clear();
      }
      this.#deltaFor(entry.info, memory)({ type: 'rewind', turnId });
      for (const id of dropped) memory.points.delete(id);
      await memory.checkpoints?.truncate(turnId);
      memory.taskState = trimTaskStateToTurn(
        memory.taskState,
        memory.turns,
        memory.checkpoints?.timeline().checkpoints.map((c) => c.turnId) ?? [],
      );
    }
    if (memory.checkpoints?.available) {
      const files = draftFilesOf(
        await memory.checkpoints.diff({ kind: 'session' }).catch(() => []),
      );
      memory.taskState = syncTaskState(memory.taskState, { files });
    }
    const timeline = memory.checkpoints
      ? memory.checkpoints.timeline()
      : DISABLED_TIMELINE(this.#rewindKind(sessionId));
    this.#emitTimeline(sessionId, timeline);
    return {
      timeline,
      text: options.conversation && userTurn ? textOf(userTurn) : null,
      conversation: kind,
    };
  }

  archive(sessionId: string): boolean {
    const entry = this.#sessions.get(sessionId);
    if (!entry || entry.info.archived) return false;
    entry.info.archived = true;
    const memory = this.#memory.get(sessionId);
    memory?.cycle.hold();
    memory?.cycle.interrupted();
    if (entry.info.state === 'running' || entry.info.state === 'needs-you') {
      void entry.adapter.interrupt().catch(() => undefined);
    }
    this.#emit({ kind: 'event', type: 'session.archived', sessionId });
    return true;
  }

  interrupt(sessionId: string): Promise<void> {
    const entry = this.#get(sessionId);
    this.#memory.get(sessionId)?.cycle.interrupted();
    this.#consult?.interrupted(sessionId);
    return entry.adapter.interrupt();
  }

  async setMode(sessionId: string, mode: string): Promise<void> {
    const entry = this.#get(sessionId);
    this.#requireWritable(entry);
    const { adapter, mcp, info } = entry;
    if (isConsult(info)) throw new Error('Esta é uma consulta só de leitura: o modo não muda.');
    const modes = restrict(
      adapter.capabilities(),
      mcp.some((s) => s.executesCode),
    ).modes;
    if (!modes.some((m) => m.id === mode)) {
      throw new Error(`Modo desconhecido para este agente: ${mode}`);
    }
    await adapter.setMode(mode);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const entry = this.#get(sessionId);
    this.#requireWritable(entry);
    const { adapter } = entry;
    if (!findModel(adapter.capabilities().models, model)) {
      throw new Error(`Modelo desconhecido para este agente: ${model}`);
    }
    await adapter.setModel(model);
  }

  async setEffort(sessionId: string, effort: string): Promise<void> {
    const entry = this.#get(sessionId);
    this.#requireWritable(entry);
    const { adapter, info } = entry;
    const capabilities = adapter.capabilities();
    if (!adapter.setEffort || !capabilities.effort) {
      throw new Error('Este agente não tem níveis de effort');
    }
    const model = findModel(capabilities.models, info.settings.model);
    const allowed = model ? model.efforts : capabilities.models.flatMap((m) => m.efforts);
    if (!allowed.includes(effort)) {
      throw new Error(`Este modelo não tem o effort ${effort}`);
    }
    await adapter.setEffort(effort);
  }

  answer(sessionId: string, requestId: string, answer: PermissionAnswer): void {
    const entry = this.#get(sessionId);
    this.#requireWritable(entry);
    const answered = entry.adapter.answerPermission(requestId, answer);
    if (!answered) throw new Error('Este pedido já não está à espera de resposta');
  }

  async disposeAll(alreadyStopped = false): Promise<void> {
    const entries = [...this.#sessions.values()];
    const memories = [...this.#memory.values()];
    this.#sessions.clear();
    this.#memory.clear();
    this.#consult?.stop();
    for (const entry of entries) entry.brain?.revoke();
    if (!alreadyStopped) await Promise.all(entries.map((entry) => entry.adapter.close()));
    for (const m of memories) m.quality?.dispose();
    for (const c of this.#checks.values()) c.dispose();
    this.#checks.clear();
    this.#checkProjects.clear();
    await Promise.all(memories.map((m) => m.checkpoints?.dispose()));
  }

  observeRecovery(event: EngineEvent): void {
    this.#recovery.observeRecovery(event);
  }

  recovery(): SavedSession[] {
    return this.#recovery.recovery();
  }

  recoverySetups(): [string, SetupSpec | null][] {
    return this.#recovery.recoverySetups();
  }

  restoreRecovery(records: SavedSession[], setups: [string, SetupSpec | null][]): void {
    this.#recovery.restoreRecovery(records, setups);
  }

  async preserveRecovery(): Promise<void> {
    await this.#recovery.preserveRecovery();
  }

  async reconcileRecovery(): Promise<void> {
    await this.#recovery.reconcileRecovery();
  }

  assertRecoveryReady(sessionId: string): void {
    this.#recovery.assertRecoveryReady(sessionId);
  }

  async stopForRecovery(): Promise<void> {
    await this.#recovery.stopForRecovery();
  }

  #memoryOf(sessionId: string): SessionMemory {
    const memory = this.#memory.get(sessionId);
    if (!memory) throw new Error('Sessão desconhecida (o motor pode ter reiniciado)');
    return memory;
  }

  #checkpoints(sessionId: string): SessionCheckpoints {
    this.#get(sessionId);
    const checkpoints = this.#memoryOf(sessionId).checkpoints;
    if (!checkpoints) throw new Error('Os checkpoints estão desligados');
    return checkpoints;
  }

  #rewindKind(sessionId: string): ConversationRewind {
    return this.#sessions.get(sessionId)?.adapter.rewindPoint ? 'agent' : 'summary';
  }

  #emitTimeline(sessionId: string, timeline?: Timeline): void {
    const memory = this.#memory.get(sessionId);
    if (!memory?.checkpoints) return;
    this.#emit({
      kind: 'event',
      type: 'session.timeline',
      sessionId,
      timeline: timeline ?? memory.checkpoints.timeline(),
    });
  }

  #turnSettled(sessionId: string): void {
    const memory = this.#memory.get(sessionId);
    const turnId = memory?.openTurn;
    if (!memory?.checkpoints || !turnId) return;
    memory.openTurn = null;
    const checkpoints = memory.checkpoints;
    void checkpoints.endTurn(turnId).then(async () => {
      const timeline = checkpoints.timeline();
      const checkpointTurnIds = timeline.checkpoints
        .filter((c) => c.state === 'done')
        .map((c) => c.turnId);
      const files = checkpoints.available
        ? draftFilesOf(await checkpoints.diff({ kind: 'session' }).catch(() => []))
        : undefined;
      memory.taskState = syncTaskState(memory.taskState, {
        checkpointTurnIds,
        ...(files ? { files } : {}),
      });
      this.#emitTimeline(sessionId, timeline);
      if (this.#stopping) return;
      if (memory.quality?.state.enabled)
        void this.#quality
          .review(sessionId, turnId)
          .catch((error) => this.#backgroundFailure(sessionId, error));
      void this.#quality
        .check(sessionId, turnId)
        .catch((error) => this.#backgroundFailure(sessionId, error));
      if (memory.worktree) void this.#workspace.emitWorkspace(sessionId);
    });
  }

  #backgroundFailure(sessionId: string, error: unknown): void {
    this.#emit({
      kind: 'event',
      type: 'engine.error',
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  async outcome(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ cwd: string; files: RawFile[]; checks: CheckVerdict[] }> {
    return this.#workspace.outcome(sessionId, this.checkContext(sessionId), signal);
  }

  laneDigest(sessionId: string): string {
    this.#get(sessionId);
    const last = this.#memoryOf(sessionId).turns.findLast((t) => t.role === 'assistant');
    return last ? assistantText(last) : '';
  }

  costOf(sessionId: string): number | null {
    return this.#recoveryViews.get(sessionId)?.usage.costUsd ?? null;
  }

  anchor(key: string, worktree: Worktree): void {
    this.#anchors.set(key, worktree);
  }

  unanchor(key: string): void {
    this.#anchors.delete(key);
  }

  worktreeOf(sessionId: string): Worktree | undefined {
    return this.#workspace.worktreeOf(sessionId);
  }

  checkContext(sessionId: string) {
    return this.#quality.checkContext(sessionId);
  }

  async saveCommit(sessionId: string, message: string): Promise<{ sha: string | null }> {
    return this.#workspace.saveCommit(sessionId, message);
  }

  async pullTarget(sessionId: string): Promise<{ repo: string; branch: string }> {
    return this.#workspace.pullTarget(sessionId);
  }

  async pushPull(sessionId: string): Promise<{ cwd: string; branch: string }> {
    return this.#workspace.pushPull(sessionId);
  }

  async bring(sessionId: string): Promise<{ merged: boolean; conflicts: string[]; into: string }> {
    return this.#workspace.bring(sessionId);
  }

  async close(
    sessionId: string,
    choice?: 'bring' | 'keep' | 'discard',
    dropQueue = false,
  ): Promise<CloseSessionResult> {
    return this.#workspace.close(sessionId, choice, dropQueue);
  }

  claimWorktrees(paths: () => readonly string[]): void {
    this.#claimed = paths;
  }

  async orphans(): Promise<Orphan[]> {
    return this.#workspace.orphans();
  }

  async bringOrphan(id: string): Promise<{ merged: boolean; conflicts: string[]; into: string }> {
    return this.#workspace.bringOrphan(id);
  }

  async discardOrphan(id: string): Promise<void> {
    await this.#workspace.discardOrphan(id);
  }

  async retrySetup(sessionId: string): Promise<void> {
    await this.#workspace.retrySetup(sessionId);
  }

  setProjectSetup(projectId: string, setup: SetupSpec | null): void {
    this.#setups.set(projectId, setup);
  }

  quality(sessionId: string): Quality {
    return this.#quality.quality(sessionId);
  }

  setQualityEnabled(sessionId: string, enabled: boolean): Quality {
    return this.#quality.setQualityEnabled(sessionId, enabled);
  }

  async reviewNow(
    sessionId: string,
    how: { trigger?: ReviewTrigger | undefined; scope?: ReviewScope | undefined } = {},
  ): Promise<Quality> {
    return this.#quality.reviewNow(sessionId, how);
  }

  async fix(sessionId: string, ids: readonly string[]): Promise<string> {
    return this.#quality.fix(sessionId, ids);
  }

  dismiss(sessionId: string, ids: readonly string[]): Quality {
    return this.#quality.dismiss(sessionId, ids);
  }

  #requireWritable(entry: SessionEntry): void {
    if (entry.info.archived) throw new Error('O PR entrou. Esta sessão fica para ler.');
  }

  #requireActive(entry: SessionEntry): void {
    this.#requireWritable(entry);
    const to = entry.info.handedTo;
    if (to) {
      const title = this.#sessions.get(to)?.info.title ?? 'outra sessão';
      throw new Error(
        `Esta sessão passou o testemunho a ${title}. Usa "Retomar aqui" para voltar a trabalhar nela.`,
      );
    }
    if (this.#handingOff.has(entry.info.id))
      throw new Error('A passagem de testemunho está a meio: espera que acabe.');
  }

  async handoffSource(sessionId: string): Promise<{
    cwd: string;
    label: string;
    title: string;
    turns: readonly Turn[];
    lastRequest: string;
    files: DraftFile[];
    filesNote?: string;
  }> {
    return this.#handoff.handoffSource(sessionId);
  }

  async handoff(
    sourceId: string,
    request: {
      agent: string;
      model?: string | undefined;
      effort?: string | undefined;
      text: string;
      goal?: string | undefined;
      draftedBy?: HandoffDraftedBy | undefined;
    },
  ): Promise<SessionResult & { turnId: string }> {
    return this.#handoff.handoff(sourceId, request);
  }

  async resumeHere(
    sessionId: string,
  ): Promise<{ session: SessionInfo; paused: SessionInfo | undefined }> {
    return this.#handoff.resumeHere(sessionId);
  }

  async fork(sourceId: string, turnId: string): Promise<EngineCommandResult<'session.fork'>> {
    return this.#handoff.fork(sourceId, turnId);
  }

  #requireIdle(entry: SessionEntry, memory: SessionMemory, what: string): void {
    this.#requireWritable(entry);
    const state = entry.info.state;
    if (
      memory.cycle.busy ||
      memory.cycle.queue.items.length > 0 ||
      (state !== 'idle' && state !== 'error')
    ) {
      throw new Error(`Espera que o agente acabe (ou interrompe-o) antes de ${what}`);
    }
  }

  async #mcpFor(definition: AgentDefinition, ids: readonly string[]): Promise<McpServerLaunch[]> {
    if (ids.length === 0) return [];
    if (!definition.mcp)
      throw new Error(`O ${definition.label} ainda não aceita servidores MCP por sessão`);
    if (!this.#mcp) throw new Error('Não há servidores MCP configurados');
    const catalog = this.#mcp;
    return Promise.all(
      [...new Set(ids)].map(async (id) => {
        const s = await catalog.launch(id);
        return {
          name: s.name,
          command: s.command,
          args: s.args,
          env: s.env,
          executesCode: s.executesCode,
        };
      }),
    );
  }

  async #projectMcp(
    definition: AgentDefinition,
    payload: SessionStartPayload,
    explicit: readonly string[],
    taken: number,
    risk: string | undefined,
  ): Promise<{
    ids: string[];
    launches: McpServerLaunch[];
    skipped: NonNullable<SessionInfo['mcpSkipped']>;
  }> {
    const none = { ids: [], launches: [], skipped: [] };
    const kind = payload.origin?.kind;
    const catalog = this.#mcp;
    const chosenFor = catalog?.projectServers?.bind(catalog);
    if (
      !catalog ||
      !chosenFor ||
      !definition.mcp ||
      payload.raceId ||
      (kind && NO_PROJECT_MCP.has(kind))
    )
      return none;
    const wanted = chosenFor(payload.projectId).filter((id) => !explicit.includes(id));
    if (wanted.length === 0) return none;
    const runsCode = new Map((await catalog.list()).map((d) => [d.id, d.executesCode]));
    const restrictedMode = risk !== undefined && RESTRICTED_RISKS.has(risk);
    const skipped: NonNullable<SessionInfo['mcpSkipped']> = [];
    const attempts = await Promise.all(
      wanted.map(async (id) => {
        if (restrictedMode && (runsCode.get(id) ?? true))
          return { id, skip: 'restricted-mode' as const };
        try {
          const s = await catalog.launch(id);
          return {
            id,
            launch: {
              name: s.name,
              command: s.command,
              args: s.args,
              env: s.env,
              executesCode: s.executesCode,
            },
          };
        } catch (error) {
          return {
            id,
            skip: error instanceof McpLaunchError ? error.reason : ('error' as const),
          };
        }
      }),
    );
    const ids: string[] = [];
    const launches: McpServerLaunch[] = [];
    for (const attempt of attempts) {
      if (attempt.skip) skipped.push({ id: attempt.id, reason: attempt.skip });
      else if (!attempt.launch || taken + launches.length >= MAX_MCP)
        skipped.push({ id: attempt.id, reason: 'limit' });
      else {
        ids.push(attempt.id);
        launches.push(attempt.launch);
      }
    }
    return { ids, launches, skipped };
  }

  async #bindBrain(
    info: SessionInfo,
    definition: AgentDefinition,
  ): Promise<BrainBinding | undefined> {
    if (!this.#brain || !definition.brain || !definition.mcp) return undefined;
    if (info.raceId || info.origin?.kind === 'lane' || info.origin?.kind === 'part')
      return undefined;
    const binding = await this.#brain.bind(
      {
        id: info.id,
        projectId: info.projectId,
        agent: info.agent,
        describe: () => ({ title: info.title, folder: basename(info.cwd), cwd: info.cwd }),
        turn: () =>
          currentTurn(this.#memory.get(info.id)?.turns ?? [], {
            fromAgent: (turn) => isDelegateDigest(turnText(turn)),
            external: opensFromConsult(info),
          }),
        ...(opensFromConsult(info) ? { withhold: CONSULT_TOOL_NAMES } : {}),
      },
      definition.brain,
    );
    if (binding.available) return binding;
    binding.revoke();
    return undefined;
  }

  async #ruleBlock(
    info: SessionInfo,
    definition: AgentDefinition,
    _trusted: boolean,
    readTool: boolean,
  ): Promise<{ instructions?: string; intro?: string } | undefined> {
    const channel = definition.rules;
    if (!this.#rules || !channel) return undefined;
    const text = renderStart(this.#rules.deliver(info.projectId), {
      target: channel.via,
      readTool,
    });
    if (!text) return undefined;
    return channel.via === 'instructions' ? { instructions: text } : { intro: text };
  }

  async #memoryBlock(
    info: SessionInfo,
    definition: AgentDefinition,
    readTool: boolean,
  ): Promise<{ instructions?: string; intro?: string } | undefined> {
    const channel = definition.rules;
    if (!this.#memories || !channel) return undefined;
    const text = await this.#memories.startBlock(info.projectId, {
      target: channel.via,
      readTool,
    });
    if (!text) return undefined;
    return channel.via === 'instructions' ? { instructions: text } : { intro: text };
  }

  async #touchedRules(
    entry: SessionEntry,
    memory: SessionMemory,
  ): Promise<{ text: string; ids: string[]; turns: string[] } | undefined> {
    const checkpoints = memory.checkpoints;
    if (!this.#rules || !checkpoints || !entry.definition.rules) return undefined;
    const pending = this.#rules
      .deliver(entry.info.projectId)
      .filter((rule) => rule.globs.length > 0 && !memory.rules.delivered.has(rule.id));
    if (pending.length === 0) return undefined;
    const turns = checkpoints
      .timeline()
      .checkpoints.filter(
        (c) => c.state === 'done' && c.stats.files > 0 && !memory.rules.scanned.has(c.turnId),
      )
      .map((c) => c.turnId);
    const hit = new Set<string>();
    const seen: string[] = [];
    for (const turnId of turns) {
      try {
        const paths = await checkpoints.changedPaths(turnId);
        for (const rule of pending)
          if (paths.some((p) => matchesAny(rule.globs, p))) hit.add(rule.id);
        seen.push(turnId);
      } catch {
        // Sem este turno por agora: tenta-se outra vez na próxima mensagem.
      }
    }
    const matched = pending.filter((rule) => hit.has(rule.id));
    const text = renderTouched(matched);
    if (!text) {
      for (const id of seen) memory.rules.scanned.add(id);
      return undefined;
    }
    return { text, ids: matched.map((rule) => rule.id), turns: seen };
  }

  async #start(
    info: SessionInfo,
    definition: AgentDefinition,
    trusted: boolean,
    mcp: readonly McpServerLaunch[],
    resume?: string,
    requested?: { model?: string | undefined; effort?: string | undefined },
    fork?: string,
  ): Promise<SessionResult> {
    if (!trusted && definition.untrustedProjects === 'refused') {
      throw new Error(`O ${definition.label} só corre em projetos de confiança`);
    }
    const { model, effort, mode } = info.settings;
    const entry: Partial<SessionEntry> = {};
    const policy = definition.configurableKeys
      ? {
          ...definition.envPolicy,
          keys: [...(definition.envPolicy.keys ?? []), ...(await this.#keysFor(definition.id))],
        }
      : definition.envPolicy;
    const env = {
      ...agentEnv(policy),
      ...(info.port !== undefined ? PortAllocator.env(info.port) : {}),
    };
    this.#sessions.get(info.id)?.brain?.revoke();
    const brain = await this.#bindBrain(info, definition);
    const ruleBlock = await this.#ruleBlock(info, definition, trusted, Boolean(brain));
    const memoryBlock = await this.#memoryBlock(info, definition, Boolean(brain));
    const joined = (key: 'instructions' | 'intro') =>
      [ruleBlock?.[key], memoryBlock?.[key]].filter(Boolean).join('\n\n') || undefined;
    const rules = { instructions: joined('instructions'), intro: joined('intro') };
    const servers = [
      ...mcp.map((s) => withoutSecrets(s, env)),
      ...(brain?.launch ? [brain.launch] : []),
    ];
    const adapter = definition.create(
      {
        cwd: info.cwd,
        model: model ?? undefined,
        effort: effort ?? undefined,
        mode,
        resume,
        ...(fork ? { fork } : {}),
        projectTrusted: trusted,
        env,
        ...(servers.length ? { mcpServers: servers } : {}),
        ...(brain?.transport === 'in-process' ? { brain } : {}),
        ...(rules?.instructions ? { instructions: rules.instructions } : {}),
        ...(isConsult(info) ? { readOnly: true } : {}),
      },
      this.#sinkFor(
        info,
        () => entry.adapter,
        mcp.some((s) => s.executesCode),
        Boolean(brain),
      ),
    );
    entry.adapter = adapter;
    const isNew = !this.#sessions.has(info.id);
    const bare = mcp.map((s) => ({ ...s, env: {} }));
    this.#sessions.set(info.id, { info, adapter, definition, trusted, mcp: bare, brain });
    const restricted = mcp.some((s) => s.executesCode);
    let started: Awaited<ReturnType<AgentAdapter['start']>> | undefined;
    try {
      const breaker = this.#circuits.getOrCreate(`adapter-start:${definition.id}`, {
        threshold: ADAPTER_START_THRESHOLD,
        resetMs: ADAPTER_START_RESET_MS,
      });
      try {
        started = await breaker.execute(() => adapter.start(), { tripOn: shouldTripAdapterStart });
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          throw new Error(
            `O ${definition.label} falhou a arrancar várias vezes seguidas; aguarda um pouco ou atualiza os agentes.`,
            { cause: error },
          );
        }
        throw error;
      }
      info.agentSessionId = adapter.agentSessionId() ?? info.agentSessionId;
      if (requested) checkRequested(started.capabilities, requested);
      info.settings = started.settings;
      info.state = 'idle';
      const own = this.#memory.get(info.id);
      if (own && rules?.intro && !resume) own.intro = rules.intro;
      const fallback = definition.defaultMode;
      const visible = withBrain(restrict(started.capabilities, restricted), Boolean(brain));
      const modes = visible.modes;
      if (info.settings.mode && !modes.some((m) => m.id === info.settings.mode)) {
        const target =
          fallback && modes.some((m) => m.id === fallback) ? fallback : safestMode(modes)?.id;
        if (target && target !== info.settings.mode) {
          await adapter.setMode(target);
          info.settings = { ...info.settings, mode: target };
        } else if (restricted && !target) {
          throw new Error('Este agente não tem um modo que pergunte antes; tira o servidor MCP');
        }
      }
      if (isConsult(info)) {
        const safe = readOnlyModeOf(modes, info.settings.mode);
        if (!safe)
          throw new Error('Este agente não tem um modo só de leitura: não responde a consultas');
        if (safe.id !== info.settings.mode) {
          await adapter.setMode(safe.id);
          info.settings = { ...info.settings, mode: safe.id };
        }
      }
      return { session: { ...info }, capabilities: visible };
    } catch (error) {
      brain?.revoke();
      if (started) await adapter.close().catch(() => undefined);
      if (isNew) this.#sessions.delete(info.id);
      throw error;
    }
  }

  #sinkFor(
    info: SessionInfo,
    adapter: () => AgentAdapter | undefined,
    restricted: boolean,
    brain: boolean,
  ): AdapterSink {
    const emit = this.#emit;
    const forward = this.#deltaFor(info, this.#memory.get(info.id));
    return {
      delta: (raw) => {
        const cleaned = withoutUnreportedCost(raw, adapter());
        forward(
          cleaned.type === 'capabilities'
            ? {
                ...cleaned,
                capabilities: withBrain(restrict(cleaned.capabilities, restricted), brain),
              }
            : cleaned,
        );
      },
      state: (state, error) => {
        info.state = state;
        if (state === 'idle' || state === 'error') this.#turnSettled(info.id);
        if (state === 'idle' && this.#memory.get(info.id)?.cycle.settled()) return;
        emit({
          kind: 'event',
          type: 'session.state',
          sessionId: info.id,
          state,
          ...(error ? { error } : {}),
        });
      },
      ask: (turnId, request) => {
        if (isConsult(info) && request.kind !== 'question') {
          queueMicrotask(() => {
            adapter()?.answerPermission(request.id, {
              decision: 'deny',
              message: READ_ONLY_DENIAL,
            });
          });
          return;
        }
        emit({ kind: 'event', type: 'permission.request', sessionId: info.id, turnId, request });
      },
    };
  }

  #deltaFor(
    info: SessionInfo,
    memory: SessionMemory | undefined,
  ): (delta: Parameters<AdapterSink['delta']>[0]) => void {
    return (delta) => {
      if (delta.type === 'settings') info.settings = { ...info.settings, ...delta.settings };
      if (delta.type === 'meta') info.agentSessionId = delta.agentSessionId;
      if (
        memory &&
        delta.type === 'turn.start' &&
        delta.turn.role === 'user' &&
        memory.awaitingHandoffTurn
      ) {
        memory.awaitingHandoffTurn = false;
        memory.taskState = { ...memory.taskState, handoffTurnId: delta.turn.id };
      }
      if (
        memory &&
        delta.type === 'turn.start' &&
        delta.turn.role === 'user' &&
        memory.turns.length === 0 &&
        !keepsTitle(info) &&
        !memory.bornTitled
      ) {
        const text = delta.turn.blocks.find((block) => block.kind === 'text');
        if (text?.kind === 'text')
          info.title = text.text.replace(/\s+/g, ' ').trim().slice(0, 80) || info.title;
      }
      if (memory) {
        memory.turns = applyDelta(memory.turns, delta);
        if (
          delta.type === 'turn.start' ||
          delta.type === 'block.upsert' ||
          delta.type === 'turn.end' ||
          delta.type === 'rewind'
        ) {
          memory.taskState = syncTaskState(memory.taskState, { turns: memory.turns });
        }
      }
      if (delta.type === 'usage') {
        this.#ledgerOf(info.id).observe(reportFromUsage(delta.usage));
        this.#emitLedger(info.id);
      }
      this.#emit({ kind: 'event', type: 'session.event', sessionId: info.id, delta });
    };
  }

  consultSource(sessionId: string): ConsultSource | undefined {
    const entry = this.#sessions.get(sessionId);
    if (!entry) return undefined;
    const { info } = entry;
    return {
      id: info.id,
      projectId: info.projectId,
      agent: info.agent,
      cwd: info.cwd,
      trusted: entry.trusted,
      title: info.title,
      mode: info.settings.mode,
      origin: info.origin,
      workspace: info.workspace,
      handedTo: info.handedTo,
    };
  }

  setRepair(sessionId: string, enabled: boolean): ReturnType<RepairLoop['view']> {
    return this.#quality.setRepair(sessionId, enabled);
  }

  cancelRepair(sessionId: string): ReturnType<RepairLoop['view']> {
    return this.#quality.cancelRepair(sessionId);
  }

  ledger(sessionId: string): ReturnType<SessionLedger['view']> {
    this.#get(sessionId);
    return this.#ledgerOf(sessionId).view();
  }

  setBudget(sessionId: string, limits: BudgetLimits): ReturnType<SessionLedger['view']> {
    this.#get(sessionId);
    const ledger = this.#ledgerOf(sessionId);
    ledger.setBudget(limits);
    this.#emitLedger(sessionId);
    return ledger.view();
  }

  #ledgerOf(sessionId: string): SessionLedger {
    const existing = this.#ledgers.get(sessionId);
    if (existing) return existing;
    const created = new SessionLedger();
    this.#ledgers.set(sessionId, created);
    return created;
  }

  #emitLedger(sessionId: string): void {
    const ledger = this.#ledgers.get(sessionId);
    if (!ledger) return;
    this.#emit({ kind: 'event', type: 'session.ledger', sessionId, ledger: ledger.view() });
  }

  #get(sessionId: string): SessionEntry {
    const entry = this.#sessions.get(sessionId);
    if (!entry) throw new Error('Sessão desconhecida (o motor pode ter reiniciado)');
    return entry;
  }
}

function withoutUnreportedCost(
  delta: Parameters<AdapterSink['delta']>[0],
  adapter: AgentAdapter | undefined,
): Parameters<AdapterSink['delta']>[0] {
  if (delta.type !== 'usage' || !adapter) return delta;
  let reportsCost: boolean;
  try {
    reportsCost = adapter.capabilities().features.cost;
  } catch {
    return delta;
  }
  if (reportsCost) return delta;
  const { costUsd: _cost, ...usage } = delta.usage;
  return {
    type: 'usage',
    usage: {
      ...usage,
      ...(usage.models ? { models: usage.models.map((m) => ({ ...m, costUsd: null })) } : {}),
    },
  };
}

function checkRequested(
  capabilities: AgentCapabilities,
  requested: { model?: string | undefined; effort?: string | undefined },
): void {
  const model = requested.model ? findModel(capabilities.models, requested.model) : undefined;
  if (requested.model && !model) {
    throw new Error(`Modelo desconhecido para este agente: ${requested.model}`);
  }
  if (!requested.effort) return;
  const allowed = model ? model.efforts : capabilities.models.flatMap((m) => m.efforts);
  if (!capabilities.effort || !allowed.includes(requested.effort)) {
    throw new Error(`Este modelo não tem o effort ${requested.effort}`);
  }
}

function withoutSecrets(
  server: McpServerLaunch,
  agentEnvironment: Record<string, string | undefined>,
): McpServerLaunch {
  const blanks = Object.keys(agentEnvironment).filter(
    (key) => SECRET_NAME.test(key) || /^ANTHROPIC_/i.test(key),
  );
  return { ...server, env: { ...Object.fromEntries(blanks.map((k) => [k, ''])), ...server.env } };
}
