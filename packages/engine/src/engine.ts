import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  RecoveryOperationDetails,
  RequestEnvelope,
  engineCommandSchemas,
  type AgentId,
  type EngineCommandName,
  type EngineEvent,
  type EngineSnapshot,
  type RecoveryOperation,
  type ResponseEnvelope,
} from '@solline/protocol';
import type { AgentAdapterFactory } from './adapters/types.ts';
import type { LoginManager } from './agents/login.ts';
import type { AgentRegistry } from './agents/registry.ts';
import { fileAgentSettings, memoryAgentSettings, type AgentSettings } from './agents/settings.ts';
import type { BrainOptions } from './brain/brain.ts';
import { CheckpointStore, type CheckpointStoreOptions } from './checkpoints/store.ts';
import type { ConsultManager } from './consult/manager.ts';
import type { Drafter } from './handoff/drafter.ts';
import { claudeDrafter } from './handoff/drafter.ts';
import { CircuitRegistry } from './kernel/circuit-breaker.ts';
import { EngineEventBus } from './kernel/event-bus.ts';
import { EngineKernel } from './kernel/kernel.ts';
import { mcpCatalog, type McpCatalog } from './mcp/catalog.ts';
import type { McpSecretReader } from './mcp/secrets.ts';
import type { UserCatalogOptions, UserMcpCatalog } from './mcp/user-catalog.ts';
import type { MemoryService } from './memory/manager.ts';
import {
  AGENT_REGISTRY,
  ANALYSIS_MANAGER,
  CONSULT_MANAGER,
  ISSUE_SERVICE,
  LOGIN_MANAGER,
  MEMORY_SERVICE,
  PULL_SERVICE,
  RACE_MANAGER,
  RACE_REGISTRY,
  RULES_MANAGER,
  SESSION_MANAGER,
  SPACES_MANAGER,
  SPLIT_MANAGER,
  USER_MCP,
  agentsModule,
  analysisModule,
  brainModule,
  consultModule,
  mcpModule,
  memoryModule,
  pullModule,
  racesModule,
  recoveryModule,
  rulesModule,
  sessionsModule,
  spacesModule,
  splitsModule,
  type EngineRuntime,
} from './modules/index.ts';
import type { IssueService } from './pull/issues.ts';
import type { PullService } from './pull/pull.ts';
import { codexAvailability } from './quality/codex-reviewer.ts';
import { claudeReviewer, type Reviewer } from './quality/reviewer.ts';
import { routeReviewer, type ReviewerPicker } from './quality/routing.ts';
import type { Planner } from './races/planner.ts';
import { claudePlanner } from './races/planner.ts';
import type { RaceManager } from './races/race-manager.ts';
import type { RaceRegistry } from './races/race-registry.ts';
import type { SplitManager } from './races/split-manager.ts';
import { DurableJournal } from './recovery/journal.ts';
import { RecoveryRecord, replay } from './recovery/records.ts';
import type { RecoveryState } from './recovery/state.ts';
import type { RulesManager } from './rules/manager.ts';
import type { ChecksOptions, SessionManager } from './session-manager.ts';
import type { AnalysisRunner, SpaceAnalysis } from './spaces/analysis.ts';
import type { SpaceManager } from './spaces/manager.ts';
import { WorktreeManager } from './worktrees/worktrees.ts';

export interface EngineOptions {
  spaceAnalyzer?: AnalysisRunner;
  /** Main supplies this in memory over MessagePort; never environment, argv or plaintext disk. */
  recoveryKey?: Uint8Array | undefined;
  claudeExecutable?: string | undefined;
  /** Pasta de dados da app (perfis de fornecedor guardam lá a config do Claude Code). */
  dataDir?: string | undefined;
  /** A correr da app instalada. */
  packaged?: boolean | undefined;
  /** Para onde vão os eventos (no utilityProcess, a MessagePort). */
  emit?: (event: EngineEvent) => void;
  /** Sem definições do utilizador nem do projeto (testes e smoke). */
  isolated?: boolean;
  /** Para testes: troca o adaptador de alguns agentes (o resto da definição fica). */
  adapters?: Partial<Record<AgentId, AgentAdapterFactory>>;
  /** Para testes: troca o registo inteiro. */
  registry?: AgentRegistry;
  /** Para testes: troca o catálogo fixo de servidores MCP (o do utilizador fica ao lado). */
  mcp?: McpCatalog;
  /**
   * De onde o motor tira os valores dos segredos dos servidores do catálogo, no momento de os
   * arrancar (a sonda ou a entrega a uma sessão). No app, é pedido ao main; sem isto, um servidor
   * com variáveis secretas não arranca.
   */
  mcpSecrets?: McpSecretReader | undefined;
  /** Para testes: o registo oficial, a sonda e a procura de programas do catálogo do utilizador. */
  mcpUser?: Pick<UserCatalogOptions, 'registry' | 'probe' | 'probeTimeoutMs' | 'node' | 'pathEnv'>;
  /**
   * As ferramentas da Solline para os agentes (o servidor MCP "solline"). Sem isto, nenhuma sessão
   * as tem. O shim para o Codex e os agentes ACP vem de `shim` (a app instalada diz onde está).
   */
  brain?: BrainOptions | undefined;
  /** Checkpoints por turno (por omissão na pasta de dados); false desliga-os. */
  checkpoints?: CheckpointStoreOptions | false;
  /** A segunda opinião no fim de cada turno (por omissão um Claude só de leitura); false desliga. */
  reviewer?: Reviewer | false;
  /**
   * Os revisores por fabricante: a sessão de um agente é revista pelo oposto (Claude pelo Codex;
   * Codex e ACP pelo Claude) e, sem o outro, pelo mesmo. Por omissão o Claude só de leitura e o
   * Codex se estiver pronto (instalado, com login e sandbox); codex: false desliga o Codex.
   * Tem de ser dado sem `reviewer`, que revê tudo com um só.
   */
  reviewers?: { claude?: Reviewer; codex?: Reviewer | false };
  /** Quem corta um pedido em partes (por omissão um Claude só de leitura); false desliga. */
  planner?: Planner | false;
  /**
   * Quem escreve o rascunho de uma passagem de testemunho (por omissão um Claude só de leitura,
   * menos isolado); sem ele, o rascunho sai mecânico. false desliga.
   */
  drafter?: Drafter | false;
  /** As verificações do projeto no fim de cada turno (por omissão ligadas, menos isolado); false desliga. */
  checks?: ChecksOptions | false;
  /** Worktrees para as sessões a mais de um projeto (por omissão na pasta de dados); false desliga. */
  worktrees?: WorktreeManager | false;
  /** Para testes: troca onde ficam as variáveis escolhidas para cada agente. */
  settings?: AgentSettings;
  /** Para testes: o ambiente onde se procuram nomes de segredos. */
  env?: NodeJS.ProcessEnv;
  /** A lista de issues. Nos testes, um `gh` injectado; sem isto, o `gh` do PATH. */
  issues?: IssueService;
  /** O PR e a CI. Nos testes, um `gh` injectado. */
  pulls?: PullService;
}

function reviewersFor(options: EngineOptions): {
  manager: { reviewer?: Reviewer; reviewerFor?: ReviewerPicker };
  integration: Reviewer | undefined;
} {
  if (options.reviewer === false) return { manager: {}, integration: undefined };
  if (options.reviewer)
    return { manager: { reviewer: options.reviewer }, integration: options.reviewer };
  if (options.isolated && !options.reviewers) return { manager: {}, integration: undefined };
  const claude =
    options.reviewers?.claude ?? claudeReviewer({ claudeExecutable: options.claudeExecutable });
  const given = options.reviewers?.codex;
  const codex =
    given === false
      ? undefined
      : given
        ? () => Promise.resolve(given)
        : options.isolated
          ? undefined
          : codexAvailability({ packaged: options.packaged });
  return {
    manager: { reviewerFor: routeReviewer({ claude, codex }) },
    integration: claude,
  };
}

/** O motor recebe envelopes de pedido e devolve envelopes de resposta. Não sabe do Electron. */
export class Engine {
  readonly kernel: EngineKernel;
  readonly circuits: CircuitRegistry;
  readonly spaces: SpaceManager;
  readonly rules: RulesManager;
  readonly memory: MemoryService;
  readonly consult: ConsultManager;
  readonly analysis: SpaceAnalysis;
  readonly sessions: SessionManager;
  readonly issues: IssueService;
  readonly pulls: PullService;
  readonly mcp: UserMcpCatalog;
  readonly races: RaceManager;
  readonly splits: SplitManager;
  readonly registry: RaceRegistry;
  readonly logins: LoginManager;
  readonly #checkpoints: CheckpointStore | undefined;
  readonly #drafts = new Map<string, AbortController>();
  readonly #epoch = randomUUID();
  readonly #journal: DurableJournal<RecoveryRecord> | undefined;
  readonly #operations = new Map<string, RecoveryOperation>();
  readonly #recordedSessions = new Set<string>();
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #ready: Promise<void>;
  #sequence = 0;
  #persistenceError: Error | undefined;
  #stopping = false;
  #disposed = false;

  constructor(options: EngineOptions = {}) {
    if (options.dataDir && !options.recoveryKey)
      throw new Error('A chave protegida de recuperação não está disponível.');
    this.#journal =
      options.dataDir && options.recoveryKey
        ? new DurableJournal(
            path.join(options.dataDir, 'recovery', 'engine-v1'),
            (value) => RecoveryRecord.parse(value),
            options.recoveryKey,
          )
        : undefined;
    const emit = options.emit ?? (() => undefined);
    this.circuits = new CircuitRegistry();
    const bus = new EngineEventBus({
      onError: (error) => {
        emit({
          kind: 'event',
          type: 'engine.error',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });

    const emitAll = (event: EngineEvent) => {
      if (this.#disposed) return;
      this.sessions?.observeRecovery(event);
      const sequenced = { ...event, epoch: this.#epoch, sequence: ++this.#sequence };
      try {
        this.#requirePersistence();
        const sessionId = 'sessionId' in event ? event.sessionId : undefined;
        const capture =
          sessionId &&
          (!this.#recordedSessions.has(sessionId) ||
            event.type === 'session.timeline' ||
            event.type === 'session.workspace' ||
            event.type === 'session.handoff' ||
            event.type === 'session.archived');
        const session = capture
          ? this.sessions?.recovery().find((saved) => saved.view.session.id === sessionId)
          : undefined;
        this.#journal?.append({ kind: 'event', event: sequenced, ...(session ? { session } : {}) });
        if (sessionId && session) this.#recordedSessions.add(sessionId);
      } catch (error) {
        this.#persistenceError = error instanceof Error ? error : new Error(String(error));
        emit({ kind: 'event', type: 'engine.error', message: this.#persistenceError.message });
        if (event.type === 'spaces.changed' || event.type === 'rules.changed')
          throw this.#persistenceError;
        return;
      }
      emit(sequenced);
      this.kernel.bus.emit(sequenced);
    };

    this.kernel = new EngineKernel({ bus, circuits: this.circuits, emitExternal: emitAll });

    this.#checkpoints =
      options.checkpoints === false
        ? undefined
        : new CheckpointStore({
            root: options.dataDir ? path.join(options.dataDir, 'checkpoints') : undefined,
            durable: Boolean(options.dataDir),
            ...options.checkpoints,
          });
    const worktrees =
      options.worktrees === false
        ? undefined
        : (options.worktrees ??
          (options.dataDir
            ? new WorktreeManager({ root: path.join(options.dataDir, 'worktrees') })
            : undefined));

    const runtime: EngineRuntime = {
      options,
      env: options.env ?? process.env,
      settings:
        options.settings ??
        (options.dataDir ? fileAgentSettings(options.dataDir) : memoryAgentSettings()),
      builtinMcp: options.mcp ?? mcpCatalog({ dataDir: options.dataDir }),
      checkpoints: this.#checkpoints,
      worktrees,
      planner:
        options.planner === false
          ? undefined
          : (options.planner ??
            (options.isolated || options.reviewer === false
              ? undefined
              : claudePlanner({ claudeExecutable: options.claudeExecutable }))),
      drafter:
        options.drafter === false
          ? undefined
          : (options.drafter ??
            (options.isolated
              ? undefined
              : claudeDrafter({ claudeExecutable: options.claudeExecutable }))),
      reviewing: reviewersFor(options),
      journal: this.#journal,
      operations: this.#operations,
      recordedSessions: this.#recordedSessions,
      drafts: this.#drafts,
      emit,
      emitAll,
      beforeEffect: (command, input) => this.#prepare(command, input),
      snapshot: () => this.#state().snapshot,
      flush: () => this.flush(),
      shutdown: () => this.shutdown(),
      health: () => this.kernel.health(),
      toggleModule: (id, enabled) => this.kernel.setModuleEnabled(id, enabled),
    };

    for (const mod of [
      recoveryModule(runtime),
      agentsModule(),
      mcpModule(),
      rulesModule(),
      memoryModule(),
      consultModule(),
      brainModule(),
      sessionsModule(),
      racesModule(),
      splitsModule(),
      spacesModule(),
      analysisModule(),
      pullModule(),
    ]) {
      this.kernel.register(mod);
    }

    this.kernel.initSync();

    this.spaces = this.kernel.inject(SPACES_MANAGER);
    this.rules = this.kernel.inject(RULES_MANAGER);
    this.memory = this.kernel.inject(MEMORY_SERVICE);
    this.consult = this.kernel.inject(CONSULT_MANAGER);
    this.analysis = this.kernel.inject(ANALYSIS_MANAGER);
    this.sessions = this.kernel.inject(SESSION_MANAGER);
    this.issues = this.kernel.inject(ISSUE_SERVICE);
    this.pulls = this.kernel.inject(PULL_SERVICE);
    this.mcp = this.kernel.inject(USER_MCP);
    this.races = this.kernel.inject(RACE_MANAGER);
    this.splits = this.kernel.inject(SPLIT_MANAGER);
    this.registry = this.kernel.inject(RACE_REGISTRY);
    this.logins = this.kernel.inject(LOGIN_MANAGER);
    // Garante que `registry` de agentes (se não usado diretamente aqui) ficou inicializado.
    void this.kernel.inject(AGENT_REGISTRY);

    const restored = replay(this.#journal?.records ?? [], this.#state());
    if (this.#journal) this.#journal.records.length = 0;
    this.sessions.restoreRecovery(restored.sessions, restored.setups);
    this.races.restoreRecovery(restored.snapshot.races);
    this.splits.restoreRecovery(restored.snapshot.races);
    this.spaces.restore(restored.snapshot.spaces);
    this.rules.restore(restored.snapshot.rules);
    for (const operation of restored.snapshot.operations)
      this.#operations.set(operation.id, operation);
    for (const saved of restored.sessions) this.#recordedSessions.add(saved.view.session.id);
    this.#ready = this.sessions
      .reconcileRecovery()
      .then(() => this.sessions.preserveRecovery())
      .then(() => {
        if (this.#journal) this.#journal.snapshot({ kind: 'snapshot', state: this.#state() });
      })
      .then(() => this.kernel.start());
    // Startup failure remains observable to every request without an unhandled rejection.
    void this.#ready.catch((error) => {
      this.#persistenceError = error instanceof Error ? error : new Error(String(error));
      emit({ kind: 'event', type: 'engine.error', message: this.#persistenceError.message });
    });
  }

  async handle(raw: unknown): Promise<ResponseEnvelope> {
    const parsed = RequestEnvelope.safeParse(raw);
    if (!parsed.success) {
      const id =
        typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string'
          ? raw.id
          : '';
      return { kind: 'response', id, ok: false, error: { message: 'Pedido inválido' } };
    }
    const { id, payload, command } = parsed.data;
    try {
      await this.#ready;
      if (
        this.#stopping &&
        command !== 'engine.snapshot' &&
        command !== 'engine.flush' &&
        command !== 'engine.shutdown' &&
        command !== 'engine.health'
      )
        throw new Error('O motor está a fechar; o trabalho foi preservado.');
      const schema = engineCommandSchemas[command];
      const input = schema.payload.parse(payload ?? {});
      const readOnly = READ_ONLY.has(command);
      if (!readOnly && command !== 'engine.flush') this.#requirePersistence();
      if (!readOnly && 'sessionId' in input && typeof input.sessionId === 'string')
        this.sessions.assertRecoveryReady(input.sessionId);
      const handler = this.kernel.getCommand(command);
      if (!handler)
        throw new Error(`O comando "${command}" está indisponível porque o módulo não está ativo.`);
      const finish =
        !readOnly && !command.startsWith('engine.') ? this.#prepare(command, input, id) : undefined;
      const execution = (async () => {
        const result = schema.result.parse(await handler(input));
        if (finish) {
          finish();
          await this.flush();
        }
        return result;
      })();
      if (finish) this.#inFlight.add(execution);
      try {
        const result = await execution;
        return { kind: 'response', id, ok: true, result };
      } finally {
        this.#inFlight.delete(execution);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'response', id, ok: false, error: { message } };
    }
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.shutdown();
  }

  #requirePersistence(): void {
    if (this.#persistenceError) throw this.#persistenceError;
    if (this.#journal?.error) throw this.#journal.error;
  }

  #prepare(command: string, payload: unknown, id: string = randomUUID()): () => void {
    if (this.#stopping) throw new Error('O motor está a fechar; nenhuma ação nova foi iniciada.');
    this.#requirePersistence();
    if (this.#operations.has(id))
      throw new Error('Este pedido já foi recebido. Confirma o resultado antes de o repetir.');
    const input = payload as {
      sessionId?: unknown;
      raceId?: unknown;
      projectId?: unknown;
      text?: unknown;
      id?: unknown;
      answer?: { decision?: unknown };
      decision?: unknown;
    };
    const details = RecoveryOperationDetails.parse({
      ...input,
      itemId: typeof input?.id === 'string' ? input.id : undefined,
      decision: input?.answer?.decision ?? input?.decision,
    });
    const operation: RecoveryOperation = {
      id,
      command,
      state: 'prepared',
      at: Date.now(),
      ...(typeof input?.sessionId === 'string' ? { sessionId: input.sessionId } : {}),
      ...(typeof input?.raceId === 'string' ? { raceId: input.raceId } : {}),
      ...(typeof input?.projectId === 'string' ? { projectId: input.projectId } : {}),
      ...(typeof input?.text === 'string' ? { text: input.text } : {}),
      ...(Object.keys(details).length ? { details } : {}),
    };
    this.#journal?.append({ kind: 'operation', operation });
    this.#operations.set(id, operation);
    return () => {
      this.#requirePersistence();
      const completed: RecoveryOperation = { ...operation, state: 'completed' };
      this.#journal?.append({ kind: 'snapshot', state: this.#state() });
      this.#journal?.append({ kind: 'operation', operation: completed });
      this.#operations.set(id, completed);
    };
  }

  #state(): RecoveryState {
    const sessions = this.sessions?.recovery() ?? [];
    const snapshot: EngineSnapshot = {
      version: 1,
      epoch: this.#epoch,
      sequence: this.#sequence,
      lifecycle: this.#disposed ? 'stopped' : this.#stopping ? 'stopping' : 'running',
      sessions: sessions.map((saved) => saved.view),
      races: this.races?.recovery() ?? [],
      ...(this.spaces ? { spaces: this.spaces.snapshot() } : {}),
      ...(this.rules && this.rules.snapshot().revision > 0 ? { rules: this.rules.snapshot() } : {}),
      operations: [...this.#operations.values()],
      durability:
        this.#persistenceError || this.#journal?.error
          ? { status: 'failed', error: (this.#persistenceError ?? this.#journal?.error)?.message }
          : { status: 'saved' },
    };
    return { snapshot, sessions, setups: this.sessions?.recoverySetups() ?? [] };
  }

  async flush(): Promise<void> {
    await this.sessions.preserveRecovery();
    if (this.#journal && (this.#journal.error || this.#persistenceError)) {
      this.#journal.retrySnapshot({ kind: 'snapshot', state: this.#state() });
      this.#persistenceError = undefined;
    }
    this.#requirePersistence();
    this.#journal?.snapshot({ kind: 'snapshot', state: this.#state() });
  }

  async shutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#stopping = true;
    for (const draft of this.#drafts.values()) draft.abort();
    await this.analysis.stop();
    this.races.stopForRecovery();
    this.splits.stopForRecovery();
    await this.logins.cancelAll();
    await this.sessions.stopForRecovery();
    await Promise.allSettled([...this.#inFlight]);
    await this.logins.cancelAll();
    await this.sessions.stopForRecovery();
    await this.flush();
    this.#disposed = true;
    await this.kernel.shutdown();
    await this.#checkpoints?.dispose();
    this.#journal?.close();
  }
}

const READ_ONLY = new Set<EngineCommandName>([
  'rules.list',
  'rules.preview',
  'issues.list',
  'ci.read',
  'pr.preview',
  'spaces.snapshot',
  'spaces.syncProjects',
  'engine.ping',
  'engine.snapshot',
  'engine.health',
  'agents.list',
  'agents.keys',
  'agents.keyCandidates',
  'mcp.list',
  'mcp.catalog',
  'mcp.search',
  'mcp.get',
  'mcp.draft',
  'worktrees.list',
  'race.get',
  'race.proposal',
  'split.planNow',
  'split.review',
  'projects.detectChecks',
  'projects.detectSetup',
  'review.timeline',
  'review.diff',
  'quality.get',
  'checks.get',
  'ledger.get',
  'handoff.draft',
  'handoff.cancelDraft',
  'session.taskState',
]);
