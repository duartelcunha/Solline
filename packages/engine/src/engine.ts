import { stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  RequestEnvelope,
  RecoveryOperationDetails,
  engineCommandSchemas,
  type AgentId,
  type EngineCommandName,
  type EngineCommandPayload,
  type EngineCommandResult,
  type EngineEvent,
  type ResponseEnvelope,
  type EngineSnapshot,
  type RecoveryOperation,
} from '@solline/protocol';
import { DurableJournal } from './recovery/journal.ts';
import { RecoveryRecord, replay } from './recovery/records.ts';
import type { RecoveryState } from './recovery/state.ts';
import type { AgentAdapterFactory } from './adapters/types.ts';
import { LoginManager } from './agents/login.ts';
import { builtinRegistry, withFactories, type AgentRegistry } from './agents/registry.ts';
import { CheckpointStore, type CheckpointStoreOptions } from './checkpoints/store.ts';
import { fileAgentSettings, memoryAgentSettings, type AgentSettings } from './agents/settings.ts';
import { SECRET_NAME } from './env.ts';
import { mcpCatalog, type McpCatalog } from './mcp/catalog.ts';
import { claudeReviewer, type Reviewer } from './quality/reviewer.ts';
import { codexAvailability } from './quality/codex-reviewer.ts';
import { routeReviewer, type ReviewerPicker } from './quality/routing.ts';
import { SessionManager, type ChecksOptions } from './session-manager.ts';
import { Assembler } from './races/assembler.ts';
import { RaceManager } from './races/race-manager.ts';
import { RaceRegistry } from './races/race-registry.ts';
import { SplitManager } from './races/split-manager.ts';
import { claudeJudge } from './verify/judge.ts';
import { claudePlanner, type Planner } from './races/planner.ts';
import { reviewPlan } from './races/split-review.ts';
import { claudeDrafter, draftHandoff, type Drafter } from './handoff/drafter.ts';
import { summaryOf } from './review.ts';
import { detectChecks } from './checks/detect.ts';
import { detectSetup } from './workspace/setup.ts';
import { WorktreeManager } from './worktrees/worktrees.ts';
import { ENGINE_VERSION } from './version.ts';
import { Brain, sourceShimPath, type BrainOptions } from './brain/brain.ts';
import { contextTool } from './brain/tools/context.ts';
import { exportRules, readNativeFiles } from './rules/files.ts';
import { RulesManager } from './rules/manager.ts';
import { rulesTools } from './rules/tools.ts';
import { MemoryService } from './memory/manager.ts';
import { memoryTools } from './memory/tools.ts';
import { SpaceManager } from './spaces/manager.ts';
import { SpaceAnalysis, type AnalysisRunner } from './spaces/analysis.ts';
import { claudeAnalysis } from './spaces/claude-analysis.ts';

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
  /** Para testes: troca o catálogo de servidores MCP. */
  mcp?: McpCatalog;
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
}

/** Quem dá a segunda opinião: um só para tudo, ou um por fabricante (o oposto do agente da sessão). */
function reviewersFor(options: EngineOptions): {
  manager: { reviewer?: Reviewer; reviewerFor?: ReviewerPicker };
  /** O revisor do resultado integrado das partes (sem agente de sessão: o Claude). */
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

type Handlers = {
  [C in EngineCommandName]: (payload: EngineCommandPayload<C>) => Promise<EngineCommandResult<C>>;
};

/** O motor recebe envelopes de pedido e devolve envelopes de resposta. Não sabe do Electron. */
export class Engine {
  readonly spaces: SpaceManager;
  /** As regras do projeto escritas na Solline (iguais para todos os agentes). */
  readonly rules: RulesManager;
  readonly memory: MemoryService;
  readonly analysis: SpaceAnalysis;
  readonly sessions: SessionManager;
  readonly races: RaceManager;
  readonly splits: SplitManager;
  /** Onde vivem as corridas e as repartições (um só registo para as duas). */
  readonly registry: RaceRegistry;
  readonly logins: LoginManager;
  readonly #handlers: Handlers;
  readonly #checkpoints: CheckpointStore | undefined;
  readonly #planner: Planner | undefined;
  readonly #drafter: Drafter | undefined;
  readonly #brain: Brain | undefined;
  /** Os rascunhos a escrever (um por sessão de origem): um novo cancela o anterior. */
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
    const base =
      options.registry ??
      builtinRegistry({
        claudeExecutable: options.claudeExecutable,
        isolated: options.isolated,
        dataDir: options.dataDir,
        packaged: options.packaged,
      });
    const registry = options.adapters ? withFactories(base, options.adapters) : base;
    const mcp = options.mcp ?? mcpCatalog({ dataDir: options.dataDir });
    this.#checkpoints =
      options.checkpoints === false
        ? undefined
        : new CheckpointStore({
            root: options.dataDir ? path.join(options.dataDir, 'checkpoints') : undefined,
            durable: Boolean(options.dataDir),
            ...options.checkpoints,
          });
    const emit = options.emit ?? (() => undefined);
    const settings =
      options.settings ??
      (options.dataDir ? fileAgentSettings(options.dataDir) : memoryAgentSettings());
    const env = options.env ?? process.env;
    // As corridas seguem as sessões pelos eventos delas (o estado de cada pista).
    const box: { races?: RaceManager; splits?: SplitManager } = {};
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
            event.type === 'session.handoff');
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
      box.races?.observe(event);
      box.splits?.observe(event);
      this.spaces?.observe(event);
    };
    // Nos testes isolados não se correm comandos do repositório da própria Solline.
    const worktrees =
      options.worktrees === false
        ? undefined
        : (options.worktrees ??
          (options.dataDir
            ? new WorktreeManager({ root: path.join(options.dataDir, 'worktrees') })
            : undefined));
    const reviewing = reviewersFor(options);
    this.rules = new RulesManager({
      save: (rules) => emitAll({ kind: 'event', type: 'rules.changed', rules }),
    });
    // A memória vive no estado dos Espaços (criado mais abaixo): ligam-se na hora de usar.
    this.memory = new MemoryService({
      store: {
        snapshot: () => this.spaces.snapshot(),
        change: (update) => this.spaces.change(update),
        root: (projectId) => this.spaces.projectPath(projectId),
      },
      rules: this.rules,
    });
    this.#brain = options.brain
      ? new Brain({
          ...options.brain,
          tools: options.brain.tools ?? [
            contextTool,
            ...rulesTools(this.rules),
            ...memoryTools(this.memory),
          ],
          shim: options.brain.shim ?? sourceShimPath(),
        })
      : undefined;
    this.sessions = new SessionManager({
      beforeEffect: (command, sessionId, text) =>
        this.#prepare(command, { sessionId, ...(text ? { text } : {}) }),
      emit: emitAll,
      registry,
      mcp,
      brain: this.#brain,
      rules: this.rules,
      memories: this.memory,
      checkpoints: this.#checkpoints,
      keysFor: (agent) => settings.keys(agent),
      // Nos testes isolados não se gasta a subscrição a rever turnos falsos.
      ...reviewing.manager,
      worktrees,
      checks:
        options.checks === false
          ? undefined
          : (options.checks ?? (options.isolated ? undefined : {})),
    });
    this.registry = new RaceRegistry(emitAll);
    this.races = new RaceManager({
      beforeEffect: (command, raceId) => this.#prepare(command, { raceId }),
      sessions: this.sessions,
      emit: emitAll,
      registry: this.registry,
      ...(worktrees ? { assembler: new Assembler({ worktrees }) } : {}),
      // O juiz só desempata; nos testes isolados não se gasta a subscrição com ele.
      ...(options.isolated || options.reviewer === false
        ? {}
        : { judge: claudeJudge({ claudeExecutable: options.claudeExecutable }) }),
    });
    // Como o juiz: nos testes isolados não se gasta a subscrição a planear.
    this.#planner =
      options.planner === false
        ? undefined
        : (options.planner ??
          (options.isolated || options.reviewer === false
            ? undefined
            : claudePlanner({ claudeExecutable: options.claudeExecutable })));
    // Como o planeador: nos testes isolados não se gasta a subscrição a escrever rascunhos.
    this.#drafter =
      options.drafter === false
        ? undefined
        : (options.drafter ??
          (options.isolated
            ? undefined
            : claudeDrafter({ claudeExecutable: options.claudeExecutable })));
    this.splits = new SplitManager({
      sessions: this.sessions,
      emit: emitAll,
      registry: this.registry,
      worktrees,
      // As partes integram-se com as verificações do projeto e, no fim, a mesma segunda opinião.
      ...(worktrees
        ? {
            integration: {
              sessions: this.sessions,
              worktrees,
              reviewer: reviewing.integration,
            },
          }
        : {}),
    });
    box.races = this.races;
    box.splits = this.splits;
    this.sessions.claimWorktrees(() => [
      ...this.races.worktreePaths(),
      ...this.splits.worktreePaths(),
    ]);
    this.spaces = new SpaceManager({
      save: (spaces) => emitAll({ kind: 'event', type: 'spaces.changed', spaces }),
      create: async (start) => (await this.sessions.create(start)).session.id,
      send: (id, text, turnId) => this.sessions.send(id, text, 'queue', turnId),
      projectOf: (id) =>
        this.sessions.recovery().find((s) => s.view.session.id === id)?.view.session.projectId,
      view: (id) => this.sessions.recovery().find((s) => s.view.session.id === id)?.view,
      pending: (id, turnId) =>
        this.sessions
          .recovery()
          .some(
            (s) =>
              s.view.session.id === id && s.view.queue.items.some((item) => item.id === turnId),
          ),
    });
    this.analysis = new SpaceAnalysis({
      manager: this.spaces,
      idle: () =>
        this.sessions
          .recovery()
          .every((s) => s.view.session.state === 'idle' && !s.view.queue.items.length),
      history: () => {
        const tasks = this.spaces.snapshot().tasks.map((t) => ({
          id: `task:${t.id}`,
          projectId: t.projectId,
          text: `${t.title}\n${t.description}\nEstado: ${t.status}`,
        }));
        const turns = this.sessions.recovery().flatMap((s) =>
          s.view.turns
            .filter((t) => t.role === 'user')
            .slice(-10)
            .map((t) => ({
              id: `chat:${s.view.session.id}:${t.id}`,
              projectId:
                s.view.session.projectId === '__general__' ? null : s.view.session.projectId,
              text: t.blocks
                .filter((b) => b.kind === 'text')
                .map((b) => (b.kind === 'text' ? b.text : ''))
                .join('\n'),
            })),
        );
        return [...tasks.slice(0, 50), ...turns.slice(-50)];
      },
      run: async (input) => {
        const detected = await registry.get(input.agent)?.detect({ refresh: true });
        if (detected?.status !== 'ready')
          throw new Error(
            'O agente de análise precisa de atenção: verifica o login e a disponibilidade.',
          );
        if (options.isolated && !options.spaceAnalyzer)
          throw new Error('A análise real está desligada neste ambiente de teste.');
        return (options.spaceAnalyzer ?? claudeAnalysis(options.claudeExecutable))(input);
      },
    });
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
      });
    // Startup failure remains observable to every request without an unhandled rejection.
    void this.#ready.catch((error) => {
      this.#persistenceError = error instanceof Error ? error : new Error(String(error));
      emit({ kind: 'event', type: 'engine.error', message: this.#persistenceError.message });
    });
    this.logins = new LoginManager({
      onChange: (agent, error) =>
        emit({ kind: 'event', type: 'agents.changed', agent, ...(error ? { error } : {}) }),
    });
    const logins = this.logins;
    const definitionOf = (id: string) => {
      const found = registry.get(id);
      if (!found) throw new Error(`Agente desconhecido: ${id}`);
      return found;
    };
    const configurable = (id: string) => {
      const definition = definitionOf(id);
      if (!definition.configurableKeys) throw new Error('Este agente não deixa escolher variáveis');
      return definition;
    };
    const s = this.sessions;
    const ok = {} as Record<string, never>;
    this.#handlers = {
      'spaces.syncProjects': async (p) => {
        const before = JSON.stringify(this.spaces.projects());
        this.spaces.syncProjects(p.projects, p.generalCwd);
        if (before !== JSON.stringify(this.spaces.projects())) this.analysis.cancel();
        return {};
      },
      'spaces.snapshot': async () => {
        // Quem abre a memória vê já o que passou a "a confirmar".
        await this.memory.sweepIfDue();
        return this.spaces.snapshot();
      },
      'spaces.taskCreate': async (p) => this.spaces.createTask(p),
      'spaces.taskUpdate': async (p) => this.spaces.updateTask(p),
      'spaces.dispatch': (p) => this.spaces.delegate(p, p.start),
      'spaces.configure': async (p) => {
        this.analysis.cancel();
        return this.spaces.configure(p);
      },
      'spaces.memorySave': async (p) => {
        const before = p.id
          ? this.spaces.snapshot().memories.find((m) => m.id === p.id)
          : undefined;
        // Ativar uma proposta (ou uma memória a confirmar) é aprová-la: renova a prova e o relógio.
        if (p.id && before && before.state !== 'active' && p.state === 'active') {
          this.spaces.saveMemory({ ...p, state: before.state });
          return this.memory.approve({ ids: [p.id] });
        }
        return this.spaces.saveMemory(p);
      },
      'spaces.memoryDelete': async (p) => this.spaces.deleteMemory(p.id),
      'memory.approve': async (p) => this.memory.approve(p),
      'memory.reject': async (p) => this.spaces.deleteMemories(p.ids),
      'memory.confirm': async (p) => this.memory.confirm(p.ids),
      'memory.toRule': async (p) => this.memory.toRule(p),
      'spaces.insightDecision': async (p) => this.spaces.decideInsight(p.id, p.decision),
      'spaces.analyze': () => this.analysis.analyze(false),
      'spaces.tick': () => this.analysis.analyze(true),
      'rules.list': async (p) => this.rules.view(p.projectId),
      'rules.save': async (p) => this.rules.save(p),
      'rules.delete': async (p) => this.rules.delete(p.projectId, p.id),
      'rules.importNow': async (p) => {
        await assertFolder(p.cwd);
        return this.rules.importFiles(p.projectId, await readNativeFiles(p.cwd, p.path));
      },
      'rules.exportNow': async (p) => {
        await assertFolder(p.cwd);
        const rules = this.rules.enabled(p.projectId);
        if (rules.length === 0) throw new Error('Não há regras ativas para exportar.');
        const result = await exportRules(p.cwd, rules);
        if ('written' in result) this.rules.exported(p.projectId);
        return result;
      },
      'engine.snapshot': async () => this.#state().snapshot,
      'engine.flush': async () => {
        await this.flush();
        return {};
      },
      'engine.shutdown': async () => {
        await this.shutdown();
        return {};
      },
      'engine.ping': async () => ({
        pong: true,
        engineVersion: ENGINE_VERSION,
        pid: process.pid,
        receivedAt: Date.now(),
      }),
      'mcp.list': async () => ({ servers: await mcp.list() }),
      'agents.list': async (p) => ({
        agents: await Promise.all(
          registry.list().map(async (d) => ({
            id: d.id,
            label: d.label,
            transport: d.transport,
            experimental: d.experimental === true,
            untrustedProjects: d.untrustedProjects,
            mcp: d.mcp === true,
            ...(d.login ? { login: { label: d.login.label, pending: logins.pending(d.id) } } : {}),
            ...(d.configurableKeys ? { keys: await settings.keys(d.id) } : {}),
            ...(await d
              .detect({ refresh: p.refresh === true })
              .catch((error: unknown): { status: 'error'; detail: string } => ({
                status: 'error',
                detail: error instanceof Error ? error.message : String(error),
              }))),
          })),
        ),
      }),
      'agents.loginStart': async (p) => {
        const login = definitionOf(p.agent).login;
        if (!login) throw new Error('Este agente não tem login dentro da app');
        return { url: (await logins.start(p.agent, () => login.start())).url };
      },
      'agents.loginCancel': async (p) => (await logins.cancel(p.agent), ok),
      'agents.keys': async (p) => {
        const definition = configurable(p.agent);
        return { label: definition.label, keys: await settings.keys(p.agent) };
      },
      'agents.saveKeys': async (p) => {
        configurable(p.agent);
        await settings.setKeys(p.agent, p.keys);
        emit({ kind: 'event', type: 'agents.changed', agent: p.agent });
        return ok;
      },
      // Só nomes, nunca valores: para o painel sugerir o que escolher.
      'agents.keyCandidates': async () => ({
        names: Object.keys(env)
          .filter((name) => SECRET_NAME.test(name) && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
          .sort(),
      }),
      'session.start': (p) => s.create(p),
      'projects.trustChanged': async (p) => (s.setProjectTrust(p.projectId, p.trusted), ok),
      'projects.detectChecks': async (p) => ({ checks: await detectChecks(p.cwd) }),
      'projects.detectSetup': async (p) => ({ setup: await detectSetup(p.cwd) }),
      'projects.setupChanged': async (p) => (s.setProjectSetup(p.projectId, p.setup), ok),
      'setup.retry': async (p) => (await s.retrySetup(p.sessionId), ok),
      'projects.checksChanged': async (p) => (await s.setProjectChecks(p.projectId, p.checks), ok),
      'session.resume': (p) => s.resume(p.sessionId),
      'session.send': (p) => s.send(p.sessionId, p.text, p.how),
      'session.unqueue': async (p) => {
        const removed = s.unqueue(p.sessionId, p.id);
        if (removed) this.spaces.removeQueued(p.sessionId, p.id);
        return { removed };
      },
      'session.reorder': async (p) => (s.reorder(p.sessionId, p.ids), ok),
      'session.resumeQueue': async (p) => (s.resumeQueue(p.sessionId), ok),
      'session.bring': (p) => s.bring(p.sessionId),
      'race.begin': (p) => this.races.begin(p),
      'split.begin': async ({ cwd, trusted, checks, setup, ...request }) => {
        // As partes só valem com uma verificação do projeto: as guardadas ou as que se encontram.
        // Num projeto sem confiança nada se corre: sem verificações, as partes ficam de fora.
        const specs = trusted ? (checks ?? (await detectChecks(cwd))) : [];
        return this.splits.begin({
          ...request,
          cwd,
          trusted,
          ...(checks !== undefined ? { checks } : {}),
          ...(setup !== undefined ? { setup } : {}),
          checkRefs: specs.filter((c) => c.enabled).map((c) => ({ id: c.id, label: c.label })),
        });
      },
      'split.planNow': async (p) => {
        if (!this.#planner) throw new Error('O planeador não está disponível');
        const { plan, cost } = await this.#planner({
          cwd: p.cwd,
          request: p.text,
          checks: p.checks,
        });
        const checkIds = p.checks.map((c) => c.id);
        // "Não partir" não lança partes: o custo é o de um só agente.
        const review =
          plan.decision === 'split'
            ? reviewPlan(plan.parts, checkIds)
            : { sequential: [], dropped: [], hubs: [], costMultiplier: 1, warnings: [] };
        return { plan, review, cost };
      },
      'split.review': async (p) => reviewPlan(p.parts, p.checkIds),
      'race.get': async (p) => this.registry.get(p.raceId),
      'race.proposal': (p) => this.races.proposal(p.raceId),
      'race.assemble': (p) => this.races.assemble(p.raceId, p.picks),
      'race.bring': (p) =>
        this.registry.get(p.raceId).kind === 'split'
          ? this.splits.bring(p.raceId)
          : this.races.bring(p.raceId),
      'split.integrate': (p) => this.splits.integrate(p.raceId),
      'split.resolveNow': ({ raceId, cwd, trusted, checks, setup }) =>
        this.splits.resolve(raceId, {
          projectId: this.registry.get(raceId).projectId,
          cwd,
          trusted,
          ...(checks !== undefined ? { checks } : {}),
          ...(setup !== undefined ? { setup } : {}),
        }),
      'split.continue': (p) => this.splits.continueIntegration(p.raceId),
      'split.stop': (p) => this.splits.stopLaunching(p.raceId),
      'race.closeNow': (p) =>
        this.registry.get(p.raceId).kind === 'split'
          ? this.splits.close(p.raceId, p.keep)
          : this.races.close(p.raceId, p.keep),
      'worktrees.list': async () => ({ orphans: await s.orphans() }),
      'worktrees.bring': (p) => s.bringOrphan(p.id),
      'worktrees.discardNow': async (p) => (await s.discardOrphan(p.id), ok),
      'session.closeNow': async (p) => {
        this.spaces.capture(p.sessionId);
        const result = await s.close(p.sessionId, p.worktree, p.dropQueue);
        if (result.closed) this.spaces.sessionClosed(p.sessionId);
        return result;
      },
      'session.interrupt': async (p) => (await s.interrupt(p.sessionId), ok),
      'session.setMode': async (p) => (await s.setMode(p.sessionId, p.mode), ok),
      'session.setModel': async (p) => (await s.setModel(p.sessionId, p.model), ok),
      'session.setEffort': async (p) => (await s.setEffort(p.sessionId, p.effort), ok),
      'permission.answer': async (p) => (s.answer(p.sessionId, p.requestId, p.answer), ok),
      'review.timeline': (p) => s.timeline(p.sessionId),
      'review.diff': async (p) => ({ files: await s.diff(p.sessionId, p.scope) }),
      'review.apply': (p) => s.review(p.sessionId, p.action, p.path, p.hunkId),
      'review.undo': (p) => s.undo(p.sessionId),
      'review.comment': async (p) => ({
        turnId: await s.comment(p.sessionId, p.comments, p.note),
      }),
      'session.rewind': (p) =>
        s.rewind(p.sessionId, p.turnId, { files: p.files, conversation: p.conversation }),
      'session.fork': (p) => s.fork(p.sessionId, p.turnId),
      'quality.get': async (p) => s.quality(p.sessionId),
      'quality.setEnabled': async (p) => s.setQualityEnabled(p.sessionId, p.enabled),
      'quality.review': (p) => s.reviewNow(p.sessionId, p),
      'quality.fix': async (p) => ({ turnId: await s.fix(p.sessionId, p.ids) }),
      'quality.dismiss': async (p) => s.dismiss(p.sessionId, p.ids),
      'checks.get': async (p) => s.checks(p.sessionId),
      'checks.run': (p) => s.runChecks(p.sessionId),
      'checks.fix': async (p) => ({ turnId: await s.fixCheck(p.sessionId, p.id) }),
      'handoff.draft': async (p) => {
        const target = definitionOf(p.agent);
        const source = await s.handoffSource(p.sessionId);
        this.#drafts.get(p.sessionId)?.abort();
        const abort = new AbortController();
        this.#drafts.set(p.sessionId, abort);
        try {
          const drafted = await draftHandoff(this.#drafter, {
            cwd: source.cwd,
            goal: p.goal,
            source: { label: source.label, title: source.title },
            target: { label: target.label, model: p.model },
            transcript: summaryOf(
              source.turns,
              'A conversa da sessão anterior, por ordem (as mensagens mais antigas podem ter ficado de fora):',
            ),
            lastRequest: source.lastRequest,
            files: source.files,
            signal: abort.signal,
          });
          const warning = [drafted.warning, source.filesNote].filter(Boolean).join(' ');
          return {
            text: drafted.text,
            drafted: drafted.drafted,
            ...(warning ? { warning } : {}),
            cost: drafted.cost,
          };
        } finally {
          if (this.#drafts.get(p.sessionId) === abort) this.#drafts.delete(p.sessionId);
        }
      },
      'handoff.cancelDraft': async (p) => {
        const draft = this.#drafts.get(p.sessionId);
        draft?.abort();
        return { cancelled: draft !== undefined };
      },
      'handoff.start': (p) =>
        s.handoff(p.sessionId, {
          agent: p.agent,
          model: p.model,
          effort: p.effort,
          text: p.text,
        }),
      'handoff.resume': (p) => s.resumeHere(p.sessionId),
    };
  }

  async handle(raw: unknown): Promise<ResponseEnvelope> {
    // Só passam comandos do motor: os do main e os desconhecidos ficam aqui.
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
        command !== 'engine.shutdown'
      )
        throw new Error('O motor está a fechar; o trabalho foi preservado.');
      const schema = engineCommandSchemas[command];
      const input = schema.payload.parse(payload ?? {});
      const readOnly = READ_ONLY.has(command);
      if (!readOnly && command !== 'engine.flush') this.#requirePersistence();
      if (!readOnly && 'sessionId' in input && typeof input.sessionId === 'string')
        this.sessions.assertRecoveryReady(input.sessionId);
      const finish =
        !readOnly && !command.startsWith('engine.') ? this.#prepare(command, input, id) : undefined;
      const handler = this.#handlers[command] as (payload: unknown) => Promise<unknown>;
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
    };
    // Zod's object strips all non-allowlisted keys, particularly keys/env/provider secrets.
    // This is explanatory metadata only; recovered operations are never executed.
    const details = RecoveryOperationDetails.parse({
      ...input,
      itemId: typeof input?.id === 'string' ? input.id : undefined,
      decision: input?.answer?.decision,
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
    // An accepted start/send/merge can still be awaiting a provider or Git. Its final
    // state must reach the journal before shutdown is acknowledged. A timeout belongs
    // to the caller and must keep the window open, never skip this preservation step.
    await Promise.allSettled([...this.#inFlight]);
    await this.logins.cancelAll();
    await this.sessions.stopForRecovery();
    await this.flush();
    this.#disposed = true;
    await this.sessions.disposeAll(true);
    await this.#brain?.dispose();
    await this.#checkpoints?.dispose();
    this.#journal?.close();
  }
}

/** A pasta do projeto vem do main, mas só se escreve numa pasta absoluta que existe. */
async function assertFolder(cwd: string): Promise<void> {
  const isFolder =
    path.isAbsolute(cwd) &&
    (await stat(cwd).then(
      (s) => s.isDirectory(),
      () => false,
    ));
  if (!isFolder) throw new Error('A pasta do projeto já não existe.');
}

const READ_ONLY = new Set<EngineCommandName>([
  'rules.list',
  'spaces.snapshot',
  'spaces.syncProjects',
  'engine.ping',
  'engine.snapshot',
  'agents.list',
  'agents.keys',
  'agents.keyCandidates',
  'mcp.list',
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
  'handoff.draft',
  'handoff.cancelDraft',
]);
