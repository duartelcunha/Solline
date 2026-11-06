import { stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import {
  applyDelta,
  findModel,
  type AgentCapabilities,
  type ConversationRewind,
  type DiffScope,
  type EngineCommandResult,
  type EngineEvent,
  type FileDiff,
  type PermissionAnswer,
  type ReviewAction,
  type ReviewComment,
  type SessionInfo,
  type SessionStartPayload,
  type CheckSpec,
  type Checks,
  type Quality,
  type ReviewScope,
  type ReviewTrigger,
  type Orphan,
  type SetupSpec,
  type SetupState,
  type SessionQueue,
  type Workspace,
  type WorktreeStats,
  type Timeline,
  type Turn,
  type RecoverySession,
} from '@solline/protocol';
import type { SavedSession } from './recovery/state.ts';
import { interruptedAdapter } from './recovery/interrupted-adapter.ts';
import type { AgentAdapter, AdapterSink, McpServerLaunch } from './adapters/types.ts';
import type { SessionCheckpoints } from './checkpoints/session-checkpoints.ts';
import type { CheckpointStore } from './checkpoints/store.ts';
import { assistantText, commentsMessage, summaryOf, textOf } from './review.ts';
import { draftFilesOf, handoffMessage, objectiveOf, type DraftFile } from './handoff/drafter.ts';
import type { Reviewer } from './quality/reviewer.ts';
import type { ReviewerPicker } from './quality/routing.ts';
import { reviewWorth } from './quality/gating.ts';
import { NO_REVIEW, SessionQuality, fixMessage } from './quality/session-quality.ts';
import { ProjectChecks, checkFixMessage } from './checks/project-checks.ts';
import type { RunCommand } from './checks/run.ts';
import { slug, type Worktree, type WorktreeManager } from './worktrees/worktrees.ts';
import { SessionTurns, type How, type Submitted } from './session-turns.ts';
import { PortAllocator } from './workspace/ports.ts';
import { SETUP_TIMEOUT_MS, copyEnvFiles, detectSetup, envFilesIn } from './workspace/setup.ts';
import { runCommand } from './checks/run.ts';
import type { RawFile } from './checkpoints/unified-diff.ts';
import { verify, type CheckVerdict } from './verify/verify.ts';
import type { AgentDefinition, AgentRegistry } from './agents/registry.ts';
import { SECRET_NAME, agentEnv } from './env.ts';
import { safestMode } from './adapters/acp/capabilities.ts';
import type { McpCatalog } from './mcp/catalog.ts';
import { McpLaunchError } from './mcp/launch.ts';
import type { Brain, BrainBinding } from './brain/brain.ts';
import { matchesAny } from './rules/glob.ts';
import type { RulesManager } from './rules/manager.ts';
import type { MemoryService } from './memory/manager.ts';
import { currentTurn, turnText } from './memory/external.ts';
import { isDelegateDigest } from './consult/messages.ts';
import { renderStart, renderTouched } from './rules/render.ts';
import type { ConsultManager, ConsultSource } from './consult/manager.ts';
import { readOnlyModeOf } from './consult/modes.ts';
import { CONSULT_TOOL_NAMES } from './consult/names.ts';

/** Com um servidor MCP que corre programas ligado, nada de modos sem perguntas. */
const RESTRICTED_RISKS = new Set(['auto', 'full']);
/** Origens que ficam sem os servidores que o projeto escolheu (ver #projectMcp). */
const NO_PROJECT_MCP = new Set(['lane', 'part', 'ask', 'delegate']);
const MAX_MCP = 8;

function restrict(capabilities: AgentCapabilities, restricted: boolean): AgentCapabilities {
  if (!restricted) return capabilities;
  return {
    ...capabilities,
    modes: capabilities.modes.filter((m) => !RESTRICTED_RISKS.has(m.risk)),
  };
}

/** features.brain diz à interface se o agente desta sessão tem mesmo as ferramentas da Solline. */
function withBrain(capabilities: AgentCapabilities, brain: boolean): AgentCapabilities {
  return brain
    ? { ...capabilities, features: { ...capabilities.features, brain: true } }
    : capabilities;
}

/** Quem nasceu de uma consulta ou delegação não consulta nem delega (profundidade 1). */
function opensFromConsult(info: Pick<SessionInfo, 'origin'>): boolean {
  return info.origin?.kind === 'ask' || info.origin?.kind === 'delegate';
}

/** Uma consulta só lê: nunca muda o modo, não tem checkpoints nem segunda opinião. */
function isConsult(info: Pick<SessionInfo, 'origin'>): boolean {
  return info.origin?.kind === 'ask';
}

/** Nascem com o título que lhes deram (a primeira mensagem é o aviso ou o enquadramento, não o assunto). */
function keepsTitle(info: Pick<SessionInfo, 'origin'>): boolean {
  const kind = info.origin?.kind;
  return kind === 'handoff' || kind === 'fork' || kind === 'ask' || kind === 'delegate';
}

const READ_ONLY_DENIAL =
  'Esta é uma consulta só de leitura: não podes alterar nada nem pedir permissões. Lê o que precisares e responde.';

type SessionResult = EngineCommandResult<'session.start'>;

/** A pasta tem de ser absoluta e existir; o main já a tirou de um projeto conhecido. */
async function defaultCheckCwd(cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) throw new Error('A pasta da sessão tem de ser um caminho absoluto');
  const isDir = await stat(cwd).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) throw new Error('A pasta do projeto já não existe');
}

/** Para testes: troca como se correm e encontram os comandos. */
export interface ChecksOptions {
  run?: RunCommand;
  detect?: (cwd: string) => Promise<CheckSpec[]>;
}

const NO_STATS: WorktreeStats = { files: 0, additions: 0, deletions: 0 };

interface Entry {
  info: SessionInfo;
  adapter: AgentAdapter;
  definition: AgentDefinition;
  trusted: boolean;
  mcp: readonly McpServerLaunch[];
  /** As ferramentas da Solline desta sessão, até ela fechar ou arrancar de novo. */
  brain?: BrainBinding | undefined;
}

/** O que a sessão guarda para lá do adaptador (sobrevive a retomar e a rebobinar). */
interface Memory {
  /** A conversa como a interface a vê (para o resumo de rebobinar e as citações). */
  turns: Turn[];
  checkpoints: SessionCheckpoints | undefined;
  /** Ponto de rebobinar do agente antes de cada turno do utilizador (null: do zero). */
  points: Map<string, string | null>;
  /** O turno com checkpoint aberto, à espera de o agente parar. */
  openTurn: string | null;
  /** O dono do turno: um de cada vez, a fila e o que não pode coincidir com um turno. */
  cycle: SessionTurns;
  /** Resumo que segue com a próxima mensagem, depois de rebobinar numa sessão nova. */
  context: string | undefined;
  /** As regras do projeto para os agentes sem canal de instruções: seguem com a próxima mensagem. */
  intro: string | undefined;
  /**
   * As regras com padrões: as que já seguiram inteiras (uma vez por sessão) e os turnos de que já
   * se viram os ficheiros mudados.
   */
  rules: { delivered: Set<string>; scanned: Set<string> };
  /** A segunda opinião: um revisor lê o diff de cada turno (sem revisor, não existe). */
  quality: SessionQuality | undefined;
  /** A worktree da sessão (só quando o projeto já tinha uma sessão na pasta). */
  worktree: Worktree | undefined;
  /** O branch já tem o nome da primeira mensagem. */
  named: boolean;
  /** Nasceu com título (uma issue): a primeira mensagem não o substitui. */
  bornTitled: boolean;
  /** A mudança de nome e metadados termina antes de trazer ou remover a worktree. */
  naming: Promise<void> | undefined;
  /** Um "Trazer" a meio: fechar espera por ele. */
  bringing: Promise<unknown> | undefined;
  /** A fechar: "Trazer" recusa. */
  closing: boolean;
  /** A preparação da worktree a correr (fechar cancela-a). */
  preparing: AbortController | undefined;
}

const DISABLED_TIMELINE = (rewind: ConversationRewind): Timeline => ({
  available: false,
  reason: 'os checkpoints estão desligados',
  checkpoints: [],
  pending: { files: 0, additions: 0, deletions: 0 },
  undo: null,
  conversationRewind: rewind,
  rewoundTo: null,
});

/**
 * Todas as conversas vivas do motor. Cada uma tem o seu adaptador; o que o adaptador
 * conta passa a eventos da Ponte com o id da sessão.
 * A projeção canónica e os checkpoints podem ser guardados pelo motor. Recuperar esta
 * projeção nunca cria um adaptador nem retoma uma ação por iniciativa própria.
 */
export class SessionManager {
  #stopping = false;
  readonly #recoveryViews = new Map<string, RecoverySession>();
  readonly #unavailableHistory = new Map<string, SavedSession>();
  readonly #unresolvedWorktrees = new Set<string>();
  readonly #beforeEffect: (command: string, sessionId: string, text?: string) => () => void;
  readonly #sessions = new Map<string, Entry>();
  readonly #memory = new Map<string, Memory>();
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
  /** As verificações de cada pasta de trabalho (por cwd), partilhadas pelas sessões que lá estão. */
  readonly #checks = new Map<string, ProjectChecks>();
  /** O projeto de cada pasta com verificações (para a confiança e a lista do projeto). */
  readonly #checkProjects = new Map<string, string>();
  readonly #worktrees: WorktreeManager | undefined;
  /** Pastas de projeto reservadas por uma sessão a arrancar (duas ao mesmo tempo não a partilham). */
  readonly #placing = new Set<string>();
  readonly #ports = new PortAllocator();
  /** Como se preparam as worktrees de cada projeto (null: a sugestão da Solline). */
  readonly #setups = new Map<string, SetupSpec | null>();
  #claimed: () => readonly string[] = () => [];
  /** Sessões a meio de uma passagem de testemunho (nada lhes envia até acabar). */
  readonly #handingOff = new Set<string>();
  /** Worktrees de que uma sessão nova pode partir sem serem de uma sessão (a ponta de uma integração). */
  readonly #anchors = new Map<string, Worktree>();

  constructor(options: {
    beforeEffect?: (command: string, sessionId: string, text?: string) => () => void;
    emit: (event: EngineEvent) => void;
    /** Os agentes que se podem abrir: modos, ambiente e adaptador de cada um. */
    registry: AgentRegistry;
    /** Servidores MCP que uma sessão pode pedir. */
    mcp?: McpCatalog | undefined;
    /** As ferramentas da Solline para os agentes; sem isto, nenhuma sessão as tem. */
    brain?: Brain | undefined;
    /** Perguntar a outro agente e delegar: os pedidos pendentes caem com a sessão ou o turno. */
    consult?: Pick<ConsultManager, 'interrupted' | 'sessionClosed' | 'stop'> | undefined;
    /** As regras do projeto escritas na Solline; sem isto, nenhuma sessão as recebe. */
    rules?: RulesManager | undefined;
    /** A memória partilhada: o índice das aprovadas segue no arranque, ao lado das regras. */
    memories?: Pick<MemoryService, 'startBlock'> | undefined;
    /** Para testes: troca a verificação da pasta. */
    checkCwd?: (cwd: string) => Promise<void>;
    /** Checkpoints escondidos por turno; sem isto, rever e rebobinar ficheiros ficam desligados. */
    checkpoints?: CheckpointStore | undefined;
    /** As variáveis escolhidas no painel para os agentes com configurableKeys. */
    keysFor?: (agent: string) => Promise<readonly string[]>;
    /** Quem dá a segunda opinião no fim de cada turno que mude ficheiros. */
    reviewer?: Reviewer | undefined;
    /** Quem revê cada sessão, conforme o agente (o fabricante oposto); tem prioridade sobre reviewer. */
    reviewerFor?: ReviewerPicker | undefined;
    /** As verificações do projeto no fim de cada turno que mude ficheiros; sem isto, não há. */
    checks?: ChecksOptions | undefined;
    /** Worktrees para as sessões a mais de um projeto; sem isto, partilham a pasta. */
    worktrees?: WorktreeManager | undefined;
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
  }

  get #hasReviewer(): boolean {
    return Boolean(this.#reviewer ?? this.#pickReviewer);
  }

  /**
   * `inherit`: a sessão nasce na pasta de outra (passagem de testemunho) em vez de ter lugar
   * próprio. Nunca cria worktree nem prepara nada; quem herda decide depois quem fica com a worktree.
   */
  async create(
    payload: SessionStartPayload,
    inherit?: { workspace: Workspace },
    /**
     * Bifurcação: a sessão nasce numa worktree já preparada (com os ficheiros do checkpoint) e,
     * com `point`, o agente continua a conversa desse ponto em vez de começar do zero.
     */
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
    // Os servidores que o projeto escolheu no catálogo; os que não puderem entrar ficam anotados.
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
        : await this.#placeFor(
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
      // O título vem da primeira mensagem, na interface (menos o de quem já nasce com o dele).
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
    const memory: Memory = {
      turns: [],
      checkpoints: undefined,
      points: new Map(),
      openTurn: null,
      cycle: this.#turnsFor(() => info),
      context: undefined,
      intro: undefined,
      rules: { delivered: new Set(), scanned: new Set() },
      // Uma consulta só lê, na pasta de outra sessão: não tem checkpoints nem nada para rever.
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
    this.#checksFor(info.projectId, info.cwd, payload.trusted, payload.checks ?? null, port);
    if (prepares && place.worktree) {
      memory.cycle.hold();
      void this.#prepare(info.id, payload.cwd, place.worktree.cwd);
    }
    // O primeiro checkpoint (o disco antes de tudo) faz-se por trás: a sessão já está pronta.
    const checkpoints = asking
      ? undefined
      : this.#store?.open(info.id, info.cwd, () => this.#rewindKind(info.id));
    memory.checkpoints = checkpoints;
    void checkpoints?.ready.then(() => this.#emitTimeline(info.id));
    return result;
  }

  /**
   * A confiança de um projeto mudou no main. As sessões abertas continuam como arrancaram;
   * a próxima retoma já usa a confiança nova, para os dois lados.
   */
  setProjectTrust(projectId: string, trusted: boolean): void {
    for (const entry of this.#sessions.values()) {
      if (entry.info.projectId === projectId) entry.trusted = trusted;
    }
    // As verificações seguem a confiança já: sem ela, nada corre a partir de agora.
    for (const checks of this.#checksOf(projectId)) checks.setTrusted(trusted);
  }

  /** As verificações de um projeto mudaram no main (já com a tua confirmação). */
  async setProjectChecks(projectId: string, checks: CheckSpec[] | null): Promise<void> {
    await Promise.all(this.#checksOf(projectId).map((c) => c.configure(checks)));
  }

  #checksOf(projectId: string): ProjectChecks[] {
    return [...this.#checks.entries()]
      .filter(([cwd]) => this.#checkProjects.get(cwd) === projectId)
      .map(([, checks]) => checks);
  }

  checks(sessionId: string): Checks {
    return this.#projectChecks(sessionId).state;
  }

  /** Volta a correr as verificações agora; o resultado chega por session.checks. */
  async runChecks(sessionId: string): Promise<Checks> {
    const checks = this.#projectChecks(sessionId);
    if (!checks.state.trusted)
      throw new Error('As verificações só correm em projetos de confiança');
    const last = this.#memoryOf(sessionId).checkpoints?.timeline().checkpoints.at(-1);
    void checks.run(last?.state === 'done' ? last.turnId : null);
    return checks.state;
  }

  /** Manda a falha de uma verificação ao agente da sessão. */
  async fixCheck(sessionId: string, id: string): Promise<string> {
    const failure = this.#projectChecks(sessionId).failure(id);
    if (!failure) throw new Error('Essa verificação já não está a falhar');
    return (await this.send(sessionId, checkFixMessage(failure.spec, failure.result))).turnId;
  }

  #projectChecks(sessionId: string): ProjectChecks {
    const { info } = this.#get(sessionId);
    const checks = this.#checks.get(info.cwd);
    if (!checks) throw new Error('As verificações não estão disponíveis');
    return checks;
  }

  /** Abre (uma vez por pasta) as verificações e espalha cada mudança pelas sessões de lá. */
  #checksFor(
    projectId: string,
    cwd: string,
    trusted: boolean,
    saved: CheckSpec[] | null,
    port?: number,
  ): void {
    if (!this.#checksOptions || this.#checks.has(cwd)) return;
    const checks = new ProjectChecks({
      cwd,
      saved,
      trusted,
      ...(port !== undefined ? { env: PortAllocator.env(port) } : {}),
      ...this.#checksOptions,
      emit: (state) => {
        for (const entry of this.#sessions.values()) {
          if (entry.info.cwd !== cwd) continue;
          this.#emit({
            kind: 'event',
            type: 'session.checks',
            sessionId: entry.info.id,
            checks: state,
          });
        }
      },
    });
    this.#checks.set(cwd, checks);
    this.#checkProjects.set(cwd, projectId);
    void checks.refresh();
  }

  /** Abre de novo uma sessão que caiu, com resume no agente e as mesmas definições. */
  async resume(sessionId: string): Promise<SessionResult> {
    const entry = this.#get(sessionId);
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
    // The queue remains paused until its own explicit continue action.
    this.#memoryOf(sessionId).cycle.release();
    return result;
  }

  /**
   * Antes de a mensagem seguir, o disco fica guardado (o checkpoint deste turno) e o ponto
   * de rebobinar do agente também. Se o checkpoint falhar, a mensagem segue na mesma.
   */
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

  /** Abre um turno: checkpoint do disco, ponto de rebobinar e a mensagem para o agente. */
  async #startTurn(sessionId: string, text: string, submissionId?: string): Promise<string> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    const completed = this.#beforeEffect('session.turn', sessionId, text);
    // Um turno novo muda os ficheiros: a ronda de verificações a meio deixa de valer.
    this.#checks.get(entry.info.cwd)?.cancel();
    {
      const turnId = submissionId ?? crypto.randomUUID();
      const point = entry.adapter.rewindPoint?.();
      const checkpoints = memory.checkpoints;
      // Antes de abrir o turno novo: só entram as regras dos ficheiros que os turnos anteriores mudaram.
      const touched = await this.#touchedRules(entry, memory);
      if (checkpoints) {
        const { staged, done } = checkpoints.beginTurn(turnId, text);
        await staged;
        memory.openTurn = turnId;
        void done.then(() => this.#emitTimeline(sessionId));
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
      if (point !== undefined) memory.points.set(sent, point);
      if (memory.worktree && !memory.named) {
        memory.named = true;
        memory.naming = this.#nameBranch(sessionId, text);
      }
      completed();
      return sent;
    }
  }

  /** O dono do turno de uma sessão, ligado ao adaptador e ao evento da fila. */
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

  /** A linha do tempo, com o "por rever" contado de novo (o disco pode ter mudado por fora). */
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
    // Aceitar só mexe na base; rejeitar escreve no disco e não pode correr com o agente.
    if (action === 'reject') {
      this.#requireActive(this.#get(sessionId));
      this.#requireIdle(this.#get(sessionId), this.#memoryOf(sessionId), 'rejeitar');
    }
    const timeline = await this.#checkpoints(sessionId).apply(action, path, hunkId);
    this.#emitTimeline(sessionId, timeline);
    return timeline;
  }

  async undo(sessionId: string): Promise<Timeline> {
    this.#requireActive(this.#get(sessionId));
    this.#requireIdle(this.#get(sessionId), this.#memoryOf(sessionId), 'desfazer');
    const timeline = await this.#checkpoints(sessionId).undo();
    this.#checks.get(this.#get(sessionId).info.cwd)?.reset();
    this.#emitTimeline(sessionId, timeline);
    return timeline;
  }

  /** Os comentários seguem como a próxima mensagem, com a linha citada de cada um. */
  async comment(sessionId: string, comments: ReviewComment[], note?: string): Promise<string> {
    const checkpoints = this.#memoryOf(sessionId).checkpoints;
    const files = checkpoints?.available ? await checkpoints.diff({ kind: 'review' }) : [];
    return (await this.send(sessionId, commentsMessage(comments, files, note))).turnId;
  }

  /**
   * Volta a antes de um turno. Os ficheiros voltam pelo checkpoint; a conversa volta no
   * agente quando ele sabe (fork no ponto guardado) e, nos outros, numa sessão nova que
   * recebe um resumo do que ficou para trás com a próxima mensagem.
   */
  async rewind(
    sessionId: string,
    turnId: string,
    options: { files: boolean; conversation: boolean },
  ): Promise<{ timeline: Timeline; text: string | null; conversation: ConversationRewind | null }> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    // Rebobinar os ficheiros mexe na pasta, que agora é de outra sessão; só a conversa se pode.
    if (options.files) this.#requireActive(entry);
    return memory.cycle.exclusive('rebobinar', () => this.#rewind(entry, memory, turnId, options));
  }

  async #rewind(
    entry: Entry,
    memory: Memory,
    turnId: string,
    options: { files: boolean; conversation: boolean },
  ): Promise<{ timeline: Timeline; text: string | null; conversation: ConversationRewind | null }> {
    const sessionId = entry.info.id;
    const index = memory.turns.findIndex((t) => t.id === turnId && t.role === 'user');
    if (index === -1) throw new Error('Este turno já não está na conversa');
    // Os achados falavam de código que vai deixar de existir.
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
          // Volta a passar pela aprovação e pelo cofre: nada de reutilizar o que ficou em memória.
          await this.#mcpFor(entry.definition, entry.info.mcpServers ?? []),
          undefined,
          undefined,
          kind === 'agent' && point ? point : undefined,
        );
      } catch (error) {
        // A sessão antiga continua retomável pelo id que tinha.
        entry.info.agentSessionId = previous;
        throw error;
      }
      memory.context = kind === 'summary' ? summaryOf(kept) : undefined;
      // Um agente novo sem o histórico antigo precisa de ver outra vez as regras que já tinham seguido.
      if (kind === 'summary') {
        memory.rules.delivered.clear();
        memory.rules.scanned.clear();
      }
      // Pelo sink, para os turnos guardados aqui e a interface cortarem no mesmo sítio.
      this.#deltaFor(entry.info, memory)({ type: 'rewind', turnId });
      for (const id of dropped) memory.points.delete(id);
      await memory.checkpoints?.truncate(turnId);
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

  interrupt(sessionId: string): Promise<void> {
    const entry = this.#get(sessionId);
    this.#memory.get(sessionId)?.cycle.interrupted();
    // Os pedidos de consulta ou delegação deste turno caem, e as consultas que abriu param.
    this.#consult?.interrupted(sessionId);
    return entry.adapter.interrupt();
  }

  /** Modo, modelo e effort só passam se o agente os anunciou nas capacidades. */
  async setMode(sessionId: string, mode: string): Promise<void> {
    const { adapter, mcp, info } = this.#get(sessionId);
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
    const { adapter } = this.#get(sessionId);
    if (!findModel(adapter.capabilities().models, model)) {
      throw new Error(`Modelo desconhecido para este agente: ${model}`);
    }
    await adapter.setModel(model);
  }

  async setEffort(sessionId: string, effort: string): Promise<void> {
    const { adapter, info } = this.#get(sessionId);
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
    const answered = this.#get(sessionId).adapter.answerPermission(requestId, answer);
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

  /** The UI projection also captures events which adapters do not put into their transcript. */
  observeRecovery(event: EngineEvent): void {
    if (!('sessionId' in event) || !event.sessionId) return;
    const id = event.sessionId;
    const entry = this.#sessions.get(id);
    const memory = this.#memory.get(id);
    if (!entry || !memory) return;
    let view = this.#recoveryViews.get(id);
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
      this.#recoveryViews.set(id, view);
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
    } else if (event.type === 'session.timeline') view.timeline = event.timeline;
    else if (event.type === 'session.checks') view.checks = event.checks;
    else if (event.type === 'session.quality') view.quality = event.quality;
    else if (event.type === 'session.state') view.error = event.error ?? null;
  }

  recovery(): SavedSession[] {
    return [
      ...this.#unavailableHistory.values(),
      ...[...this.#sessions.values()].map((entry) => {
        const memory = this.#memoryOf(entry.info.id);
        const saved = this.#recoveryViews.get(entry.info.id);
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
          checks: this.#checks.get(entry.info.cwd)?.state ?? saved?.checks ?? null,
          conflicts: saved?.conflicts ?? null,
          interrupted: saved?.interrupted ?? false,
          error: saved?.error ?? null,
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
    return structuredClone([...this.#setups]);
  }

  restoreRecovery(records: SavedSession[], setups: [string, SetupSpec | null][]): void {
    for (const [id, setup] of setups) this.#setups.set(id, setup);
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
      const definition = this.#registry.get(view.session.agent);
      if (!definition || !view.capabilities) {
        this.#unavailableHistory.set(view.session.id, record);
        continue;
      }
      const info = view.session;
      const cycle = this.#turnsFor(() => info);
      cycle.restore(view.queue);
      const memory: Memory = {
        turns: view.turns,
        points: new Map(record.points),
        context: record.context,
        intro: record.intro,
        rules: { delivered: new Set(record.rulesDelivered ?? []), scanned: new Set() },
        openTurn: null,
        cycle,
        checkpoints: undefined,
        quality: undefined,
        worktree: record.worktree,
        named: record.named,
        bornTitled: false,
        naming: undefined,
        bringing: undefined,
        preparing: undefined,
        closing: false,
      };
      if (this.#hasReviewer && view.quality)
        memory.quality = new SessionQuality({
          reviewer: this.#reviewer,
          enabled: view.quality.enabled,
          recovery: view.quality,
          emit: (quality) =>
            this.#emit({ kind: 'event', type: 'session.quality', sessionId: info.id, quality }),
        });
      if (record.checkpoints)
        memory.checkpoints = this.#store?.open(
          info.id,
          info.cwd,
          () => this.#rewindKind(info.id),
          record.checkpoints,
        );
      this.#memory.set(info.id, memory);
      this.#sessions.set(info.id, {
        info,
        definition,
        trusted: record.trusted,
        mcp: [],
        adapter: interruptedAdapter(view.capabilities, info.agentSessionId),
      });
      this.#recoveryViews.set(info.id, view);
      if (this.#checksOptions && view.checks && !this.#checks.has(info.cwd)) {
        this.#checks.set(
          info.cwd,
          new ProjectChecks({
            cwd: info.cwd,
            saved: view.checks.detected ? null : view.checks.specs,
            trusted: record.trusted,
            recovery: view.checks,
            ...this.#checksOptions,
            emit: (checks) => {
              for (const entry of this.#sessions.values())
                if (entry.info.cwd === info.cwd)
                  this.#emit({
                    kind: 'event',
                    type: 'session.checks',
                    sessionId: entry.info.id,
                    checks,
                  });
            },
          }),
        );
        this.#checkProjects.set(info.cwd, info.projectId);
      }
    }
  }

  async preserveRecovery(): Promise<void> {
    await Promise.all(
      [...this.#memory.values()].map(async (memory) => {
        await memory.naming;
        await memory.checkpoints?.preserve();
      }),
    );
  }

  async reconcileRecovery(): Promise<void> {
    for (const [id, memory] of this.#memory) {
      if (!memory.worktree || !this.#worktrees) continue;
      try {
        memory.worktree = await this.#worktrees.recover(memory.worktree);
        const entry = this.#sessions.get(id);
        if (entry?.info.workspace?.kind === 'worktree')
          entry.info.workspace = { ...entry.info.workspace, branch: memory.worktree.branch };
      } catch (error) {
        this.#unresolvedWorktrees.add(id);
        const view = this.#recoveryViews.get(id);
        if (view) view.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  assertRecoveryReady(sessionId: string): void {
    if (this.#unresolvedWorktrees.has(sessionId))
      throw new Error(
        this.#recoveryViews.get(sessionId)?.error ??
          'A worktree recuperada precisa de confirmação manual.',
      );
  }

  async stopForRecovery(): Promise<void> {
    this.#stopping = true;
    for (const memory of this.#memory.values()) {
      memory.cycle.hold();
      memory.cycle.interrupted();
      memory.preparing?.abort();
      memory.quality?.dispose();
    }
    for (const checks of this.#checks.values()) checks.dispose();
    this.#consult?.stop();
    for (const entry of this.#sessions.values()) entry.brain?.revoke();
    await Promise.all([...this.#sessions.values()].map((entry) => entry.adapter.close()));
  }

  #memoryOf(sessionId: string): Memory {
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

  /** Fim de turno (o agente voltou a parar): fecha o checkpoint aberto. */
  #turnSettled(sessionId: string): void {
    const memory = this.#memory.get(sessionId);
    const turnId = memory?.openTurn;
    if (!memory?.checkpoints || !turnId) return;
    memory.openTurn = null;
    void memory.checkpoints.endTurn(turnId).then(() => {
      this.#emitTimeline(sessionId);
      if (this.#stopping) return;
      if (memory.quality?.state.enabled)
        void this.#review(sessionId, turnId).catch((error) =>
          this.#backgroundFailure(sessionId, error),
        );
      void this.#check(sessionId, turnId).catch((error) =>
        this.#backgroundFailure(sessionId, error),
      );
      if (memory.worktree) void this.#emitWorkspace(sessionId);
    });
  }

  /**
   * A segunda opinião sobre um turno (ou, com scope 'session', sobre tudo o que a sessão mudou).
   * No fim de um turno só se revê o que vale a pena (20 linhas ou mais, ou um caminho sensível);
   * a pedido e antes de trazer revê-se sempre. Uma falha fica no estado, nunca como "limpo".
   */
  async #review(
    sessionId: string,
    turnId: string,
    how: { trigger: ReviewTrigger; scope: ReviewScope } = { trigger: 'turn', scope: 'turn' },
  ): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    const memory = this.#memory.get(sessionId);
    const checkpoints = memory?.checkpoints;
    if (!entry || !memory?.quality || !checkpoints?.available) return;
    const timeline = checkpoints.timeline().checkpoints;
    const whole = how.scope === 'session';
    if (!whole) {
      const checkpoint = timeline.find((c) => c.turnId === turnId);
      if (!checkpoint || checkpoint.stats.files === 0) return;
    }
    const worktrees = this.#worktrees;
    const worktree = memory.worktree;
    const diffOf = async (): Promise<FileDiff[]> =>
      whole
        ? worktree && worktrees
          ? (await worktrees.diff(worktree)).map((f) => f.diff)
          : checkpoints.diff({ kind: 'session' })
        : checkpoints.diff({ kind: 'turn', turnId });
    // Só os turnos pequenos e banais saem aqui em silêncio (o estado e os achados anteriores ficam).
    // Uma falha ao calcular o diff não se esconde: segue e chega ao estado como erro.
    let ready: { diff: FileDiff[] } | { error: unknown } | undefined;
    if (how.trigger === 'turn') {
      try {
        const diff = await diffOf();
        if (!reviewWorth(diff).worth) return;
        ready = { diff };
      } catch (error) {
        ready = { error };
      }
    }
    const reviewer = await this.#reviewerOf(entry);
    if (!reviewer) return;
    const completed = this.#beforeEffect('quality.run', sessionId);
    const request = this.#requestOf(memory, turnId, whole);
    await memory.quality.review(
      turnId,
      async () => {
        if (ready && 'error' in ready) throw ready.error;
        const diff = ready?.diff ?? (await diffOf());
        if (diff.length === 0) return null;
        const rules = this.#startupRules(entry.info.projectId);
        return { cwd: entry.info.cwd, diff, request, rules };
      },
      {
        trigger: how.trigger,
        ...(reviewer.vendor
          ? {
              reviewer: {
                vendor: reviewer.vendor,
                ...(reviewer.model ? { model: reviewer.model } : {}),
                sameVendor: entry.info.agent === reviewer.vendor,
              },
            }
          : {}),
      },
      reviewer,
    );
    completed();
  }

  /** O revisor desta sessão: o fabricante oposto quando está pronto, senão o mesmo. */
  async #reviewerOf(entry: Entry): Promise<Reviewer | undefined> {
    return this.#pickReviewer
      ? this.#pickReviewer(entry.info.agent, entry.trusted)
      : this.#reviewer;
  }

  /**
   * O que o utilizador pediu: o turno, ou (na sessão toda) os pedidos todos pela ordem. Nunca o
   * que o agente respondeu: o revisor vê o diff e o pedido, não a história que o autor conta.
   */
  #requestOf(memory: Memory, turnId: string, whole: boolean): string {
    if (!whole) {
      const turn = memory.turns.find((t) => t.id === turnId && t.role === 'user');
      return turn ? textOf(turn) : '';
    }
    const requests = memory.turns.filter((t) => t.role === 'user').map((t) => textOf(t));
    return requests.length === 1
      ? (requests[0] ?? '')
      : requests
          .map((text, i) => `${i + 1}. ${text}`)
          .join('\n\n')
          .slice(0, 6_000);
  }

  /** As verificações do projeto depois de um turno que mudou ficheiros. */
  async #check(sessionId: string, turnId: string): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    const checkpoint = this.#memory
      .get(sessionId)
      ?.checkpoints?.timeline()
      .checkpoints.find((c) => c.turnId === turnId);
    // As pistas de uma corrida verificam-se quando a corrida as ordena (com a base ao lado).
    if (!entry || entry.info.raceId || !checkpoint || checkpoint.stats.files === 0) return;
    // Um turno novo pode ter começado enquanto o checkpoint fechava: não verificar a meio dele.
    const memory = this.#memory.get(sessionId);
    if (
      memory?.openTurn ||
      memory?.cycle.busy ||
      memory?.cycle.queue.items.length ||
      entry.info.state !== 'idle'
    )
      return;
    const checks = this.#checks.get(entry.info.cwd);
    if (!checks) return;
    const completed = this.#beforeEffect('checks.autoRun', sessionId);
    await checks.run(turnId);
    completed();
  }

  #backgroundFailure(sessionId: string, error: unknown): void {
    this.#emit({
      kind: 'event',
      type: 'engine.error',
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * Onde trabalha uma sessão nova: a primeira de um projeto na pasta dele; com outra já lá, numa
   * worktree (se o projeto for git) ou na mesma pasta, marcada como partilhada.
   */
  async #placeFor(
    projectId: string,
    projectPath: string,
    always = false,
    after?: string,
  ): Promise<{ cwd: string; workspace: Workspace; worktree?: Worktree; key: string }> {
    if (always) {
      // As pistas de uma corrida: cada uma na sua worktree, sempre (sem git não há corrida).
      // Uma parte que segue outra (repartição) parte do resultado dela, não do HEAD do projeto.
      const sibling = after
        ? (this.#memory.get(after)?.worktree ?? this.#anchors.get(after))
        : undefined;
      if (after && !sibling) throw new Error('A parte anterior já não está disponível.');
      const worktree = sibling
        ? await this.#worktrees?.createAfter(sibling)
        : await this.#worktrees?.create(projectPath, projectId);
      if (!worktree)
        throw new Error('As corridas precisam de um projeto git com pelo menos um commit');
      return {
        cwd: worktree.cwd,
        workspace: { kind: 'worktree', branch: worktree.branch, stats: NO_STATS },
        worktree,
        key: '',
      };
    }
    const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const slot = `${projectId}\0${norm(projectPath)}`;
    const taken =
      this.#placing.has(slot) ||
      [...this.#sessions.values()].some(
        (e) => e.info.projectId === projectId && norm(e.info.cwd) === norm(projectPath),
      );
    if (!taken) {
      // Reservada já, antes de qualquer espera: a segunda sessão a chegar vai para uma worktree.
      this.#placing.add(slot);
      return { cwd: projectPath, workspace: { kind: 'project' }, key: slot };
    }
    const worktree = await this.#worktrees?.create(projectPath, projectId).catch((error) => {
      console.error('[worktrees] não consegui criar a worktree:', error);
      return null;
    });
    if (!worktree) return { cwd: projectPath, workspace: { kind: 'shared' }, key: '' };
    return {
      cwd: worktree.cwd,
      workspace: { kind: 'worktree', branch: worktree.branch, stats: NO_STATS },
      worktree,
      key: '',
    };
  }

  async #nameBranch(sessionId: string, text: string): Promise<void> {
    const memory = this.#memory.get(sessionId);
    if (!memory?.worktree || !this.#worktrees) return;
    try {
      memory.worktree = await this.#worktrees.rename(memory.worktree, text);
      await this.#emitWorkspace(sessionId);
    } catch (error) {
      console.error('[worktrees] não consegui dar nome ao branch:', error);
    }
  }

  async #emitWorkspace(sessionId: string): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    const worktree = this.#memory.get(sessionId)?.worktree;
    if (!entry || !worktree || !this.#worktrees) return;
    const stats = await this.#worktrees.statsOrNone(worktree);
    const workspace: Workspace = { kind: 'worktree', branch: worktree.branch, stats };
    entry.info.workspace = workspace;
    this.#emit({ kind: 'event', type: 'session.workspace', sessionId, workspace });
  }

  /**
   * O resultado de uma pista, para a corrida o ordenar: o que mudou face à base e as verificações
   * do projeto (as que falham voltam a correr na base, para não culpar a pista do que já falhava).
   */
  async outcome(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ cwd: string; files: RawFile[]; checks: CheckVerdict[] }> {
    const { info } = this.#get(sessionId);
    const worktree = this.worktreeOf(sessionId);
    const worktrees = this.#worktrees;
    if (!worktree || !worktrees) throw new Error('Esta sessão não tem worktree');
    const files = await worktrees.diff(worktree);
    const { specs, env, run } = this.checkContext(sessionId);
    const checks =
      files.length === 0 || specs.length === 0
        ? []
        : await verify(info.cwd, {
            specs,
            baseline: () => worktrees.baseline(worktree),
            env,
            ...(run ? { run } : {}),
            ...(signal ? { signal } : {}),
          });
    return { cwd: info.cwd, files, checks };
  }

  /** O que o agente disse no fim do último turno (vazio se ainda não disse nada). */
  laneDigest(sessionId: string): string {
    this.#get(sessionId);
    const last = this.#memoryOf(sessionId).turns.findLast((t) => t.role === 'assistant');
    return last ? assistantText(last) : '';
  }

  /** O último custo total que a sessão comunicou (nunca somado entre turnos), se algum. */
  costOf(sessionId: string): number | null {
    return this.#recoveryViews.get(sessionId)?.usage.costUsd ?? null;
  }

  /**
   * Põe uma worktree à disposição de `startAfter` com esta chave: uma sessão nova parte do
   * resultado dela (a ponta de uma integração), como parte do resultado de outra sessão.
   */
  anchor(key: string, worktree: Worktree): void {
    this.#anchors.set(key, worktree);
  }

  unanchor(key: string): void {
    this.#anchors.delete(key);
  }

  /** A worktree da sessão, se tiver uma. */
  worktreeOf(sessionId: string): Worktree | undefined {
    return this.#memory.get(sessionId)?.worktree;
  }

  /**
   * O que correr para verificar o trabalho desta sessão: as verificações ligadas do projeto (só
   * em projetos de confiança), as suas portas e o executor.
   */
  checkContext(sessionId: string): {
    specs: CheckSpec[];
    env: Record<string, string>;
    run: RunCommand | undefined;
  } {
    const { info } = this.#get(sessionId);
    const state = this.#checks.get(info.cwd)?.state;
    return {
      specs: state?.trusted ? state.specs.filter((s) => s.enabled) : [],
      env: info.port !== undefined ? PortAllocator.env(info.port) : {},
      run: this.#checksOptions?.run,
    };
  }

  /**
   * Grava a worktree com a mensagem do utilizador. Os hooks do projeto correm.
   * Não faz merge nem push. Sem email no git, falha e pede a identidade.
   */
  async saveCommit(sessionId: string, message: string): Promise<{ sha: string | null }> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    this.#requireActive(entry);
    this.#requireIdle(entry, memory, 'gravar');
    const worktree = memory.worktree;
    if (!worktree || !this.#worktrees) throw new Error('Gravar só numa worktree.');
    const saved = await this.#worktrees.commitMessage(worktree, message);
    await this.#emitWorkspace(sessionId);
    return saved;
  }

  /** Repositório e branch, para a confirmação. Não envia nada. */
  async pullTarget(sessionId: string): Promise<{ repo: string; branch: string }> {
    const worktree = this.#pullWorktree(sessionId);
    return { repo: await this.#requireWorktrees().remoteRepo(worktree), branch: worktree.branch };
  }

  /** Envia o branch da worktree. O PR abre-se depois, e só se a confirmação já passou. */
  async pushPull(sessionId: string): Promise<{ cwd: string; branch: string }> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    this.#requireActive(entry);
    this.#requireIdle(entry, memory, 'enviar o branch');
    const worktree = this.#pullWorktree(sessionId);
    await this.#requireWorktrees().pushBranch(worktree);
    return { cwd: worktree.path, branch: worktree.branch };
  }

  #pullWorktree(sessionId: string): Worktree {
    const worktree = this.#memoryOf(sessionId).worktree;
    if (!worktree) throw new Error('Abrir o PR só numa worktree.');
    return worktree;
  }

  /** Traz o trabalho da worktree para o branch atual do projeto. */
  async bring(sessionId: string): Promise<{ merged: boolean; conflicts: string[]; into: string }> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    this.#requireActive(entry);
    this.#requireIdle(entry, memory, 'trazer o trabalho');
    if (!memory.worktree || !this.#worktrees)
      throw new Error('Esta sessão trabalha na pasta do projeto');
    if (memory.closing) throw new Error('A sessão está a fechar');
    this.#requireProjectIdle(memory.worktree.top);
    const done = memory.cycle
      .exclusive('trazer o trabalho', () => this.#bring(sessionId, memory))
      .finally(() => {
        memory.bringing = undefined;
      });
    memory.bringing = done;
    return done;
  }

  async #bring(
    sessionId: string,
    memory: Memory,
  ): Promise<{ merged: boolean; conflicts: string[]; into: string }> {
    await memory.naming;
    if (!memory.worktree || !this.#worktrees)
      throw new Error('Esta sessão trabalha na pasta do projeto');
    const first = memory.turns.find((t) => t.role === 'user');
    const title = (first ? textOf(first).split('\n')[0] : undefined)?.slice(0, 72) || 'sessão';
    const { result, wt } = await this.#worktrees.bring(memory.worktree, `Solline: ${title}`);
    memory.worktree = wt;
    const view = this.#recoveryViews.get(sessionId);
    if (view)
      view.conflicts = result.merged ? null : { files: result.conflicts, into: result.into };
    await this.#emitWorkspace(sessionId);
    return result;
  }

  /**
   * Fecha a sessão. Uma worktree com mudanças por trazer pede escolha primeiro: trazer, guardar
   * o branch ou deitar fora. Sem mudanças (ou já trazida), a pasta e o branch saem.
   */
  async close(
    sessionId: string,
    choice?: 'bring' | 'keep' | 'discard',
    dropQueue = false,
  ): Promise<{
    closed: boolean;
    queued?: number;
    stats?: WorktreeStats;
    conflicts?: string[];
    into?: string;
  }> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    // A meio de uma passagem a worktree está a mudar de dono: fechar agora podia apagá-la.
    if (this.#handingOff.has(sessionId))
      throw new Error('A passagem de testemunho está a meio: espera que acabe.');
    const queued = memory.cycle.queue.items.length;
    if (queued > 0 && !dropQueue) return { closed: false, queued };
    // A fechar: um "Trazer" que comece agora recusa (não se apaga a worktree a meio dele).
    memory.closing = true;
    try {
      return await this.#close(sessionId, entry, memory, choice);
    } finally {
      memory.closing = false;
    }
  }

  async #close(
    sessionId: string,
    entry: Entry,
    memory: Memory,
    choice: 'bring' | 'keep' | 'discard' | undefined,
  ): Promise<{
    closed: boolean;
    stats?: WorktreeStats;
    conflicts?: string[];
    into?: string;
  }> {
    await memory.bringing?.catch(() => undefined);
    await memory.naming;
    const worktree = memory.worktree;
    // Passagens de testemunho: quem a passou a esta sessão (os herdeiros) não pode ficar a apontar
    // para uma sessão fechada nem sem pasta. Se esta passou a outra, eles passam a apontar para
    // essa; se é esta que tem a pasta, ela volta ao primeiro herdeiro, com a worktree (que é dos
    // dois: nada se pergunta, nada se apaga) e os outros passam a apontar para ele.
    const heirs = [...this.#sessions.values()].filter(
      (other) => other.info.id !== sessionId && other.info.handedTo === sessionId,
    );
    const onward = entry.info.handedTo;
    const heir = onward ? undefined : heirs[0];
    const returns = Boolean(heir && worktree && !this.#memory.get(heir.info.id)?.worktree);
    if (worktree && this.#worktrees && !returns) {
      // Uma contagem que falha conta como "há mudanças": pergunta em vez de apagar.
      const stats = await this.#worktrees
        .stats(worktree)
        .catch(() => ({ files: 1, additions: 0, deletions: 0 }));
      if (stats.files > 0) {
        if (!choice) return { closed: false, stats };
        if (choice === 'bring') {
          memory.closing = false;
          const result = await this.bring(sessionId);
          memory.closing = true;
          if (!result.merged)
            return { closed: false, conflicts: result.conflicts, into: result.into };
        }
        if (choice === 'keep') {
          // Guardar o branch é guardar o trabalho: o que não está em commit grava-se antes.
          const first = memory.turns.find((t) => t.role === 'user');
          const title =
            (first ? textOf(first).split('\n')[0] : undefined)?.slice(0, 72) || 'sessão';
          await this.#worktrees.commitAll(worktree, `Solline: ${title}`);
        }
      }
    }
    // Só agora se sabe que fecha: a fila deita-se fora aqui, nunca antes.
    memory.cycle.clear();
    this.#sessions.delete(sessionId);
    this.#memory.delete(sessionId);
    this.#consult?.sessionClosed(sessionId);
    for (const other of heirs) {
      const to = onward ?? (other === heir ? null : (heir?.info.id ?? null));
      this.#setHandedTo(other.info.id, to === other.info.id ? null : to);
    }
    if (returns && heir && worktree) {
      const heirMemory = this.#memoryOf(heir.info.id);
      heirMemory.worktree = worktree;
      heirMemory.named = true;
      await this.#emitWorkspace(heir.info.id);
    }
    memory.preparing?.abort();
    this.#ports.release(sessionId);
    entry.brain?.revoke();
    await entry.adapter.close().catch(() => undefined);
    memory.quality?.dispose();
    await memory.checkpoints?.dispose();
    const cwd = entry.info.cwd;
    if (![...this.#sessions.values()].some((e) => e.info.cwd === cwd)) {
      this.#checks.get(cwd)?.dispose();
      this.#checks.delete(cwd);
      this.#checkProjects.delete(cwd);
    }
    if (worktree && this.#worktrees && !returns) {
      const current = memory.worktree ?? worktree;
      const branch = choice === 'discard' ? 'always' : choice === 'keep' ? 'keep' : 'if-merged';
      await this.#worktrees.remove(current, branch).catch((error) => {
        console.error('[worktrees] não consegui tirar a worktree:', error);
      });
    }
    return { closed: true };
  }

  /** As worktrees no disco sem sessão aberta, com o que mudou em cada uma. */
  /** Outras worktrees em uso que não são de sessões (a montagem de uma corrida). */
  claimWorktrees(paths: () => readonly string[]): void {
    this.#claimed = paths;
  }

  /** As worktrees que alguém usa: as das sessões abertas e as que outros reclamaram. */
  #open(): Set<string> {
    return new Set([
      ...[...this.#memory.values()].flatMap((m) => (m.worktree ? [m.worktree.path] : [])),
      ...this.#claimed(),
    ]);
  }

  async orphans(): Promise<Orphan[]> {
    const worktrees = this.#worktrees;
    if (!worktrees) return [];
    const found = await worktrees.orphans(this.#open());
    return Promise.all(
      found.map(async (wt) => ({
        id: `${wt.projectId}/${wt.suffix}`,
        projectId: wt.projectId,
        branch: wt.branch,
        stats: await worktrees.statsOrNone(wt),
      })),
    );
  }

  async #orphan(id: string): Promise<Worktree> {
    const wt = (await this.#worktrees?.orphans(this.#open()))?.find(
      (w) => `${w.projectId}/${w.suffix}` === id,
    );
    if (!wt) throw new Error('Essa worktree já não existe');
    return wt;
  }

  async bringOrphan(id: string): Promise<{ merged: boolean; conflicts: string[]; into: string }> {
    const worktrees = this.#requireWorktrees();
    const wt = await this.#orphan(id);
    this.#requireProjectIdle(wt.top);
    const { result, wt: next } = await worktrees.bring(wt, `Solline: ${wt.branch}`);
    if (result.merged) await worktrees.remove(next, 'if-merged');
    return result;
  }

  async discardOrphan(id: string): Promise<void> {
    await this.#requireWorktrees().remove(await this.#orphan(id), 'always');
  }

  /**
   * Trazer escreve na pasta do projeto: as sessões que lá trabalham têm de estar paradas, e as
   * verificações delas recomeçam do zero (os ficheiros mudaram por baixo).
   */
  #requireProjectIdle(top: string): void {
    const norm = (p: string) => resolve(p).toLowerCase();
    for (const e of this.#sessions.values()) {
      const m = this.#memory.get(e.info.id);
      if (!m || m.worktree) continue;
      const rel = relative(norm(top), norm(e.info.cwd));
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      this.#requireIdle(e, m, 'trazer o trabalho para o projeto (há uma sessão a trabalhar lá)');
      this.#checks.get(e.info.cwd)?.reset();
    }
  }

  #requireWorktrees(): WorktreeManager {
    if (!this.#worktrees) throw new Error('As worktrees estão desligadas');
    return this.#worktrees;
  }

  /**
   * Prepara a worktree de uma sessão: copia os .env da raiz e corre o comando do projeto (ou a
   * sugestão). O que escreveres entretanto espera na fila; uma falha não bloqueia a sessão.
   */
  async #prepare(sessionId: string, projectPath: string, worktreeCwd: string): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    const memory = this.#memory.get(sessionId);
    if (!entry || !memory) return;
    memory.preparing?.abort();
    const abort = new AbortController();
    memory.preparing = abort;
    const started = Date.now();
    const report = (setup: SetupState) => {
      entry.info.setup = setup;
      this.#emit({ kind: 'event', type: 'session.setup', sessionId, setup });
    };
    report({ state: 'running', tail: null, durationMs: null });
    try {
      const saved = this.#setups.get(entry.info.projectId);
      if (!saved) {
        // Sem preparação guardada: a sugestão (que o repo pode mudar num git pull) só corre
        // depois de a aprovares, uma vez, com a confirmação nativa do main.
        const suggestion = await detectSetup(projectPath);
        if (abort.signal.aborted) return;
        report({
          state: 'approval',
          command: suggestion.command,
          tail: null,
          durationMs: null,
        });
        return;
      }
      const spec = saved;
      if (spec.copyEnv && this.#worktrees) {
        const names = await envFilesIn(projectPath);
        // Só os que o git ignora: um .env não ignorado entraria no commit do "Trazer".
        const ignored = await this.#worktrees.ignored(projectPath, names);
        const skip = new Set(names.filter((n) => !ignored.has(n)));
        await copyEnvFiles(projectPath, worktreeCwd, skip);
      }
      if (abort.signal.aborted) return;
      let outcome: { state: 'passed' | 'failed' | 'timeout'; tail: string | null } = {
        state: 'passed',
        tail: null,
      };
      if (spec.command.trim()) {
        const run = this.#checksOptions?.run ?? runCommand;
        outcome = await run(spec.command, {
          cwd: worktreeCwd,
          signal: abort.signal,
          timeoutMs: SETUP_TIMEOUT_MS,
          env: {
            ...(entry.info.port !== undefined ? PortAllocator.env(entry.info.port) : {}),
            SOLLINE_ROOT_PATH: projectPath,
            SOLLINE_WORKSPACE_PATH: worktreeCwd,
          },
        });
      }
      if (abort.signal.aborted) return;
      report({
        state: outcome.state === 'passed' ? 'done' : 'failed',
        tail: outcome.tail,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      report({
        state: 'failed',
        tail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      });
    } finally {
      if (memory.preparing === abort) memory.preparing = undefined;
      // Pronta ou não, a fila segue: uma falha vê-se e repete-se, não bloqueia.
      if (!abort.signal.aborted) memory.cycle.release();
    }
  }

  /** Volta a preparar a worktree da sessão. */
  async retrySetup(sessionId: string): Promise<void> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    if (!memory.worktree) throw new Error('Esta sessão trabalha na pasta do projeto');
    if (!entry.trusted) throw new Error('Preparar só corre em projetos de confiança');
    const project = memory.worktree;
    const projectPath = resolve(project.top, relative(project.path, project.cwd));
    memory.cycle.hold();
    void this.#prepare(sessionId, projectPath, project.cwd);
  }

  /** A preparação de um projeto mudou no main (já com a tua confirmação); vale para as próximas. */
  setProjectSetup(projectId: string, setup: SetupSpec | null): void {
    this.#setups.set(projectId, setup);
  }

  quality(sessionId: string): Quality {
    this.#get(sessionId);
    return (
      this.#memoryOf(sessionId).quality?.state ?? {
        available: false,
        enabled: false,
        review: NO_REVIEW,
        stats: { fixed: 0, dismissed: 0, total: 0 },
      }
    );
  }

  setQualityEnabled(sessionId: string, enabled: boolean): Quality {
    this.#get(sessionId);
    const quality = this.#memoryOf(sessionId).quality;
    if (!quality) throw new Error('A segunda opinião não está disponível');
    return quality.setEnabled(enabled);
  }

  /**
   * Revê agora: o último turno com checkpoint (por omissão) ou, com scope 'session', tudo o que
   * a sessão mudou. A pedido ('manual') e antes de trazer ('bring') revê sempre, sem o limiar
   * das 20 linhas.
   */
  async reviewNow(
    sessionId: string,
    how: { trigger?: ReviewTrigger | undefined; scope?: ReviewScope | undefined } = {},
  ): Promise<Quality> {
    this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    if (!memory.quality) throw new Error('A segunda opinião não está disponível');
    const last = memory.checkpoints?.timeline().checkpoints.at(-1);
    if (!last || last.state !== 'done') throw new Error('Ainda não há nenhum turno acabado');
    // Não espera pelo fim (uma revisão leva segundos); o resultado chega por session.quality.
    const trigger = how.trigger === 'turn' ? 'manual' : (how.trigger ?? 'manual');
    void this.#review(sessionId, last.turnId, { trigger, scope: how.scope ?? 'turn' }).catch(
      (error) => this.#backgroundFailure(sessionId, error),
    );
    return memory.quality.state;
  }

  /** Pede ao agente da sessão para corrigir os achados escolhidos. */
  async fix(sessionId: string, ids: readonly string[]): Promise<string> {
    const quality = this.#memoryOf(sessionId).quality;
    const findings = quality?.pick(ids) ?? [];
    if (!quality || findings.length === 0) throw new Error('Esses achados já não existem');
    const { turnId } = await this.send(sessionId, fixMessage(findings));
    quality.resolve(
      findings.map((f) => f.id),
      'fixed',
    );
    return turnId;
  }

  /** Descarta achados: ficam marcados (e contados) e a interface deixa de os mostrar. */
  dismiss(sessionId: string, ids: readonly string[]): Quality {
    this.#get(sessionId);
    const quality = this.#memoryOf(sessionId).quality;
    if (!quality) throw new Error('A segunda opinião não está disponível');
    if (quality.pick(ids).length === 0) throw new Error('Esses achados já não existem');
    return quality.resolve(ids, 'dismissed');
  }

  /**
   * Uma sessão que passou o testemunho (ou está a passá-lo) só se lê: nada lhe envia nem mexe na
   * pasta, que agora é de outra. "Retomar aqui" devolve-lha.
   */
  #requireActive(entry: Entry): void {
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

  /**
   * O que o rascunho da passagem precisa da sessão de origem: onde está, quem é, o que se disse e
   * os ficheiros tocados (contados pela Solline: da worktree contra a base, ou do checkpoint da
   * sessão). `filesNote` diz porque a lista pode estar incompleta.
   */
  async handoffSource(sessionId: string): Promise<{
    cwd: string;
    label: string;
    title: string;
    turns: readonly Turn[];
    lastRequest: string;
    files: DraftFile[];
    filesNote?: string;
  }> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    const last = memory.turns.findLast((t) => t.role === 'user');
    const base = {
      cwd: entry.info.cwd,
      label: entry.definition.label,
      title: entry.info.title,
      turns: memory.turns,
      lastRequest: last ? textOf(last) : '',
    };
    try {
      if (memory.worktree && this.#worktrees) {
        const diff = await this.#worktrees.diff(memory.worktree);
        return { ...base, files: draftFilesOf(diff.map((f) => f.diff)) };
      }
      const checkpoints = memory.checkpoints;
      await checkpoints?.ready;
      if (checkpoints?.available)
        return { ...base, files: draftFilesOf(await checkpoints.diff({ kind: 'session' })) };
      return {
        ...base,
        files: [],
        filesNote: 'Os checkpoints estão desligados: não há como listar os ficheiros tocados.',
      };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        files: [],
        filesNote: `Não consegui listar os ficheiros tocados (${why}).`,
      };
    }
  }

  /**
   * Passa o testemunho: abre a sessão do agente escolhido na mesma pasta (e a mesma worktree, que
   * muda de dono) e manda-lhe o aviso e o rascunho. A origem fica sem enviar até "Retomar aqui".
   * Recusa se a origem trabalha ou já passou o testemunho; se a primeira mensagem não segue, desfaz.
   */
  async handoff(
    sourceId: string,
    request: {
      agent: string;
      model?: string | undefined;
      effort?: string | undefined;
      text: string;
    },
  ): Promise<SessionResult & { turnId: string }> {
    const source = this.#get(sourceId);
    const sourceMemory = this.#memoryOf(sourceId);
    this.#requireActive(source);
    if (isConsult(source.info))
      throw new Error('Uma consulta não passa o testemunho. Abre uma sessão normal para continuar.');
    if (sourceMemory.closing) throw new Error('A sessão está a fechar');
    this.#requireIdle(source, sourceMemory, 'passar o testemunho');
    this.#handingOff.add(sourceId);
    try {
      // O branch a ganhar nome acaba antes de a worktree mudar de dono (senão voltava à origem).
      await sourceMemory.naming;
      const lastTurn = sourceMemory.turns.at(-1);
      const created = await this.create(
        {
          projectId: source.info.projectId,
          cwd: source.info.cwd,
          trusted: source.trusted,
          agent: request.agent,
          ...(request.model ? { model: request.model } : {}),
          ...(request.effort ? { effort: request.effort } : {}),
          origin: {
            kind: 'handoff',
            sessionId: sourceId,
            ...(lastTurn ? { turnId: lastTurn.id } : {}),
          },
        },
        { workspace: source.info.workspace ?? { kind: 'project' } },
      );
      const targetId = created.session.id;
      const target = this.#get(targetId);
      // O nome do objetivo, antes de qualquer evento: a primeira mensagem é só o aviso.
      target.info.title = (
        objectiveOf(request.text) ?? `Continuação de ${source.info.title}`
      ).slice(0, 80);
      this.#giveWorktree(sourceId, targetId);
      this.#setHandedTo(sourceId, targetId);
      this.#setHandedTo(targetId, null);
      await this.#emitWorkspace(targetId);
      let sent: Submitted;
      try {
        sent = await this.send(
          targetId,
          handoffMessage(
            { label: source.definition.label, title: source.info.title },
            request.text,
          ),
        );
      } catch (error) {
        // A primeira mensagem não seguiu: a pasta e o direito de enviar voltam à origem.
        this.#giveWorktree(targetId, sourceId);
        this.#setHandedTo(sourceId, null);
        await this.#emitWorkspace(sourceId);
        await this.close(targetId, undefined, true).catch(() => undefined);
        throw error;
      }
      return {
        session: { ...target.info },
        capabilities: created.capabilities,
        turnId: sent.turnId,
      };
    } finally {
      this.#handingOff.delete(sourceId);
    }
  }

  /**
   * "Retomar aqui", pedido na sessão que passou o testemunho: a pasta (e a worktree) voltam a ela
   * e quem a tinha fica em pausa, também sem enviar. Segue a cadeia de passagens até quem tem a
   * pasta agora; recusa se essa sessão está a trabalhar.
   */
  async resumeHere(
    sessionId: string,
  ): Promise<{ session: SessionInfo; paused: SessionInfo | undefined }> {
    const entry = this.#get(sessionId);
    if (!entry.info.handedTo) throw new Error('Esta sessão já tem a pasta.');
    if (this.#handingOff.has(sessionId))
      throw new Error('A passagem de testemunho está a meio: espera que acabe.');
    const holder = this.#holderOf(entry);
    this.#handingOff.add(sessionId);
    if (holder) this.#handingOff.add(holder.info.id);
    try {
      if (holder) {
        const holderMemory = this.#memoryOf(holder.info.id);
        this.#requireIdle(holder, holderMemory, 'retomar aqui');
        await holderMemory.naming;
        if (holderMemory.closing) throw new Error('A sessão está a fechar');
        this.#giveWorktree(holder.info.id, sessionId);
        this.#setHandedTo(holder.info.id, sessionId);
      }
      this.#setHandedTo(sessionId, null);
      await this.#emitWorkspace(sessionId);
      return { session: { ...entry.info }, paused: holder ? { ...holder.info } : undefined };
    } finally {
      this.#handingOff.delete(sessionId);
      if (holder) this.#handingOff.delete(holder.info.id);
    }
  }

  /** Quem tem a pasta agora: o fim da cadeia de passagens (undefined: já não existe ninguém). */
  #holderOf(from: Entry): Entry | undefined {
    const seen = new Set([from.info.id]);
    let current: Entry | undefined = from;
    while (current?.info.handedTo) {
      const next: Entry | undefined = this.#sessions.get(current.info.handedTo);
      if (!next) {
        // A sessão para quem passou já não existe: esta fica com a pasta.
        this.#setHandedTo(current.info.id, null);
        return current === from ? undefined : current;
      }
      if (seen.has(next.info.id)) throw new Error('A cadeia de passagens ficou inconsistente.');
      seen.add(next.info.id);
      current = next;
    }
    return current === from ? undefined : current;
  }

  /** A worktree muda de dono: só uma sessão a tem de cada vez (fechar e trazer vão por ela). */
  #giveWorktree(fromId: string, toId: string): void {
    const from = this.#memoryOf(fromId);
    const to = this.#memoryOf(toId);
    if (!from.worktree) return;
    if (to.worktree) throw new Error('As duas sessões têm worktree: o estado ficou inconsistente.');
    to.worktree = from.worktree;
    from.worktree = undefined;
    // O branch já tem nome; o aviso da primeira mensagem não lho deve dar.
    to.named = true;
  }

  /** Escreve o `handedTo` da sessão e avisa (a interface e o diário de recuperação). */
  #setHandedTo(sessionId: string, handedTo: string | null): void {
    const entry = this.#get(sessionId);
    if (handedTo) entry.info.handedTo = handedTo;
    else delete entry.info.handedTo;
    this.#emit({ kind: 'event', type: 'session.handoff', sessionId, handedTo });
  }

  /**
   * Bifurca a sessão no fim de um turno: uma sessão nova, do mesmo agente e modelo, na sua própria
   * worktree com os ficheiros como ficaram depois desse turno (o checkpoint). A conversa continua
   * pelo próprio agente quando ele sabe (fork no ponto guardado) e, nos outros, com um resumo do
   * que ficou até lá. A origem não muda (nem a conversa, nem a pasta, nem os checkpoints).
   * Recusa em projetos sem git, com a origem a trabalhar ou com um turno sem checkpoint acabado.
   */
  async fork(sourceId: string, turnId: string): Promise<EngineCommandResult<'session.fork'>> {
    const source = this.#get(sourceId);
    const memory = this.#memoryOf(sourceId);
    if (memory.closing) throw new Error('A sessão está a fechar');
    if (this.#handingOff.has(sourceId))
      throw new Error('A passagem de testemunho está a meio: espera que acabe.');
    this.#requireIdle(source, memory, 'bifurcar');
    // Os turnos e os pontos de onde se parte não mudam enquanto se copia.
    return memory.cycle.exclusive('bifurcar', () => this.#fork(source, memory, turnId));
  }

  async #fork(
    source: Entry,
    memory: Memory,
    turnId: string,
  ): Promise<EngineCommandResult<'session.fork'>> {
    const sourceId = source.info.id;
    const index = memory.turns.findIndex((t) => t.id === turnId && t.role === 'user');
    if (index === -1) throw new Error('Este turno já não está na conversa');
    const checkpoints = this.#checkpoints(sourceId);
    await checkpoints.ready;
    if (!checkpoints.has(turnId)) throw new Error('Este turno não tem checkpoint');
    const worktrees = this.#requireWorktrees();
    // O turno e a resposta dele: tudo até ao pedido seguinte.
    const next = memory.turns.findIndex((t, i) => i > index && t.role === 'user');
    const upTo = memory.turns.slice(0, next === -1 ? memory.turns.length : next);
    // A conversa pelo agente, no ponto em que ele estava ao fim deste turno (o que guardou antes
    // do pedido seguinte; no último, o de agora). Sem ponto, a sessão nova começa com um resumo.
    const point = this.#forkPoint(source, memory, next === -1 ? undefined : memory.turns[next]?.id);

    // Os ficheiros: uma worktree nova da mesma base, com o que o checkpoint tinha.
    const sibling = this.#worktreeOwnerOf(source);
    const fresh = sibling
      ? await worktrees.createFrom(sibling)
      : await worktrees.create(source.info.cwd, source.info.projectId);
    if (!fresh) throw new Error('Bifurcar só funciona em projetos git.');
    let worktree = fresh;
    try {
      await checkpoints.materialize(turnId, worktree.cwd);
      const words = slug(source.info.title).split('-').slice(0, 3);
      worktree = await worktrees.rename(worktree, `${words.join(' ')} bifurcacao`);
    } catch (error) {
      await worktrees.remove(worktree, 'always').catch(() => undefined);
      throw error;
    }

    let created: SessionResult;
    try {
      created = await this.create(
        {
          projectId: source.info.projectId,
          cwd: resolve(worktree.top, relative(worktree.path, worktree.cwd)),
          trusted: source.trusted,
          agent: source.info.agent,
          ...(source.info.settings.model ? { model: source.info.settings.model } : {}),
          ...(source.info.settings.effort ? { effort: source.info.settings.effort } : {}),
          origin: { kind: 'fork', sessionId: sourceId, turnId },
        },
        undefined,
        { worktree, point },
      );
    } catch (error) {
      await worktrees.remove(worktree, 'always').catch(() => undefined);
      throw error;
    }

    const id = created.session.id;
    const entry = this.#get(id);
    const target = this.#memoryOf(id);
    try {
      // O branch já tem nome, o título já é o da origem: a primeira mensagem não lhos muda.
      target.named = true;
      entry.info.title = `${source.info.title.slice(0, 64)} (bifurcação)`;
      const history = upTo.map(settledCopy);
      const deltas = this.#deltaFor(entry.info, target);
      for (const turn of history) deltas({ type: 'turn.start', turn });
      if (point === undefined)
        target.context = summaryOf(
          history,
          'Esta conversa é uma bifurcação de uma sessão anterior, a partir de um dos turnos dela. O que ficou até aí, por ordem:',
        );
      await this.#emitWorkspace(id);
      return {
        session: { ...entry.info },
        capabilities: created.capabilities,
        turns: structuredClone(history),
        conversation: point === undefined ? 'summary' : 'agent',
      };
    } catch (error) {
      await this.close(id, 'discard', true).catch(() => undefined);
      throw error;
    }
  }

  /** O ponto de rebobinar do agente ao fim de um turno (undefined: sem como o agente continuar). */
  #forkPoint(source: Entry, memory: Memory, nextTurnId: string | undefined): string | undefined {
    let rewinds = false;
    try {
      rewinds = source.adapter.capabilities().features.rewind;
    } catch {
      /* Um agente que nunca arrancou não diz o que sabe. */
    }
    if (!rewinds || !source.adapter.rewindPoint) return undefined;
    return (nextTurnId ? memory.points.get(nextTurnId) : source.adapter.rewindPoint()) ?? undefined;
  }

  /** A worktree que a pasta da sessão tem agora: a dela, ou a de quem recebeu o testemunho. */
  #worktreeOwnerOf(entry: Entry): Worktree | undefined {
    const seen = new Set<string>();
    let current: Entry | undefined = entry;
    while (current && !seen.has(current.info.id)) {
      seen.add(current.info.id);
      const worktree = this.#memory.get(current.info.id)?.worktree;
      if (worktree) return worktree;
      current = current.info.handedTo ? this.#sessions.get(current.info.handedTo) : undefined;
    }
    return undefined;
  }

  /** Mexer no disco ou na conversa só com o agente parado e nada a meio. */
  #requireIdle(entry: Entry, memory: Memory, what: string): void {
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

  /**
   * Os servidores que o projeto escolheu no catálogo global, entregues a cada sessão nova pelos
   * mesmos caminhos dos pedidos à mão, sem escrever nas configs dos agentes. Ficam de fora (com a
   * razão em `mcpSkipped`) os que precisam de aprovação, mudaram ou falharam, os que correm
   * programas num modo sem perguntas e o que passar do limite de 8. Pistas, partes, consultas só
   * de leitura e delegações não recebem servidores de terceiros: têm de ficar independentes.
   */
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
        // Sem saber se corre programas (ainda não pronto), conta como se corresse.
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

  /**
   * As ferramentas da Solline desta sessão, ou nada. Pistas e partes de uma repartição (e quem
   * resolve a integração) ficam sem elas: têm de continuar independentes umas das outras.
   */
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
        // O que o turno leu fora da pasta (web, servidores de terceiros) vê-se na conversa guardada.
        // Os resumos de delegações não são pedidos do utilizador (nem recomeçam a quota), e numa
        // consulta ou delegação a primeira mensagem é de outro agente: tudo conta como externo.
        turn: () =>
          currentTurn(this.#memory.get(info.id)?.turns ?? [], {
            fromAgent: (turn) => isDelegateDigest(turnText(turn)),
            external: opensFromConsult(info),
          }),
        // A profundidade é 1: quem nasceu de uma consulta ou delegação não consulta nem delega.
        ...(opensFromConsult(info) ? { withhold: CONSULT_TOOL_NAMES } : {}),
      },
      definition.brain,
    );
    if (binding.available) return binding;
    binding.revoke();
    return undefined;
  }

  /** O bloco de regras que o revisor lê: o mesmo texto do arranque, sem os ficheiros da pasta. */
  #startupRules(projectId: string): string | undefined {
    if (!this.#rules) return undefined;
    return renderStart(this.#rules.deliver(projectId), { target: 'instructions', readTool: true });
  }

  /**
   * As regras no formato do agente: no arranque (instructions) ou com a primeira mensagem (intro).
   * Gerais primeiro, depois as do projeto. A pasta do projeto não entra.
   */
  async #ruleBlock(
    info: SessionInfo,
    definition: AgentDefinition,
    _trusted: boolean,
    readTool: boolean,
  ): Promise<{ instructions?: string; intro?: string } | undefined> {
    const channel = definition.rules;
    if (!this.#rules || !channel) return undefined;
    const text = renderStart(this.#rules.deliver(info.projectId), { target: channel.via, readTool });
    if (!text) return undefined;
    return channel.via === 'instructions' ? { instructions: text } : { intro: text };
  }

  /**
   * O índice da memória partilhada no formato do agente (no arranque ou com a primeira mensagem),
   * ao lado das regras. Só nos agentes que têm canal para isso.
   */
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

  /**
   * As regras com padrões cujos ficheiros o agente mudou nos turnos anteriores e que ainda não
   * seguiram: vão inteiras com a próxima mensagem, uma vez por regra e sessão. Uma falha ao ler os
   * checkpoints nunca impede a mensagem.
   */
  async #touchedRules(
    entry: Entry,
    memory: Memory,
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
    /** Só numa sessão nova: o modelo e o effort pedidos têm de existir no agente. */
    requested?: { model?: string | undefined; effort?: string | undefined },
    /** Ponto de rebobinar do agente de onde a conversa continua. */
    fork?: string,
  ): Promise<SessionResult> {
    // Também na retoma: tirar a confiança a um projeto fecha-o a estes agentes.
    if (!trusted && definition.untrustedProjects === 'refused') {
      throw new Error(`O ${definition.label} só corre em projetos de confiança`);
    }
    const { model, effort, mode } = info.settings;
    const entry: Partial<Entry> = {};
    // As variáveis escolhidas no painel valem a partir da próxima sessão (ou retoma).
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
    // Retomar ou rebobinar arranca outro agente: o acesso do anterior fecha antes de abrir o novo.
    this.#sessions.get(info.id)?.brain?.revoke();
    const brain = await this.#bindBrain(info, definition);
    const ruleBlock = await this.#ruleBlock(info, definition, trusted, Boolean(brain));
    const memoryBlock = await this.#memoryBlock(info, definition, Boolean(brain));
    // As regras e o índice da memória seguem pelo mesmo canal, regras primeiro.
    const joined = (key: 'instructions' | 'intro') =>
      [ruleBlock?.[key], memoryBlock?.[key]].filter(Boolean).join('\n\n') || undefined;
    const rules = { instructions: joined('instructions'), intro: joined('intro') };
    const servers = [
      ...mcp.map((s) => withoutSecrets(s, env)),
      // O shim vai como mais um servidor MCP; o limite de 8 é dos do catálogo e este não conta.
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
    // Só o que a sessão precisa de saber (corre programas?): os valores das variáveis ficam no agente.
    const bare = mcp.map((s) => ({ ...s, env: {} }));
    this.#sessions.set(info.id, { info, adapter, definition, trusted, mcp: bare, brain });
    const restricted = mcp.some((s) => s.executesCode);
    let started: Awaited<ReturnType<AgentAdapter['start']>> | undefined;
    try {
      started = await adapter.start();
      info.agentSessionId = adapter.agentSessionId() ?? info.agentSessionId;
      if (requested) checkRequested(started.capabilities, requested);
      info.settings = started.settings;
      info.state = 'idle';
      // Uma sessão retomada já tem as regras no histórico do agente; uma nova leva-as na primeira mensagem.
      const own = this.#memory.get(info.id);
      if (own && rules?.intro && !resume) own.intro = rules.intro;
      // Um modo que o agente aceitou no arranque mas não anuncia (por exemplo Auto num modelo
      // sem suporte) volta ao modo por omissão: a interface nunca mostra um modo que não há.
      const fallback = definition.defaultMode;
      const visible = withBrain(restrict(started.capabilities, restricted), Boolean(brain));
      const modes = visible.modes;
      if (info.settings.mode && !modes.some((m) => m.id === info.settings.mode)) {
        // Sem modo por omissão (agentes ACP), vai para o mais fechado que restar.
        const target =
          fallback && modes.some((m) => m.id === fallback) ? fallback : safestMode(modes)?.id;
        if (target && target !== info.settings.mode) {
          await adapter.setMode(target);
          info.settings = { ...info.settings, mode: target };
        } else if (restricted && !target) {
          throw new Error('Este agente não tem um modo que pergunte antes; tira o servidor MCP');
        }
      }
      // Uma consulta só abre num modo de leitura que o agente tenha: sem ele, não responde.
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
      // O agente arrancou mas algo depois falhou: fecha-o, senão o processo ficava sem dono.
      if (started) await adapter.close().catch(() => undefined);
      // Uma sessão que nunca arrancou não fica; uma retomada fica, em erro, para tentar outra vez.
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
        // Numa consulta não há nada a decidir: tudo o que pede permissão (escrever, correr comandos,
        // sair do planeamento) é recusado, sem cartão. As perguntas ao utilizador seguem como sempre.
        if (isConsult(info) && request.kind !== 'question') {
          // O adaptador só regista o pedido depois de nos avisar: a resposta vai logo a seguir.
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

  /** Leva um delta à interface e à memória da sessão. */
  #deltaFor(
    info: SessionInfo,
    memory: Memory | undefined,
  ): (delta: Parameters<AdapterSink['delta']>[0]) => void {
    return (delta) => {
      if (delta.type === 'settings') info.settings = { ...info.settings, ...delta.settings };
      if (delta.type === 'meta') info.agentSessionId = delta.agentSessionId;
      // Uma sessão de passagem já nasce com o nome do objetivo: a primeira mensagem é o aviso.
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
      if (memory) memory.turns = applyDelta(memory.turns, delta);
      this.#emit({ kind: 'event', type: 'session.event', sessionId: info.id, delta });
    };
  }

  /** O que as consultas e delegações precisam de saber de uma sessão aberta (undefined: já não existe). */
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

  #get(sessionId: string): Entry {
    const entry = this.#sessions.get(sessionId);
    if (!entry) throw new Error('Sessão desconhecida (o motor pode ter reiniciado)');
    return entry;
  }
}

/**
 * Uma cópia de um turno para o histórico de uma bifurcação: o que estava a meio quando a origem
 * parou (um pedido por responder, uma ferramenta a correr) fica fechado, como na recuperação.
 */
function settledCopy(turn: Turn): Turn {
  const copy = structuredClone(turn);
  for (const block of copy.blocks) {
    if (
      (block.kind === 'permission' || block.kind === 'plan' || block.kind === 'question') &&
      block.status === 'pending'
    )
      block.status = 'cancelled';
    if (block.kind === 'tool' && block.state === 'running') block.state = 'error';
  }
  return copy;
}

/**
 * Um agente que diz não reportar custo não mostra custo: se um valor aparecer na mesma, sai
 * antes de chegar à interface (por exemplo o preço do Claude num perfil com outro fornecedor).
 */
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

/** O modelo e o effort de uma sessão nova têm de vir das capacidades, como no setModel/setEffort. */
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

/**
 * O agente arranca os servidores MCP com o ambiente dele por baixo. Os segredos do agente
 * (chaves, tokens, o que vem da Anthropic) vão vazios para o servidor, que não precisa deles.
 */
function withoutSecrets(
  server: McpServerLaunch,
  agentEnvironment: Record<string, string | undefined>,
): McpServerLaunch {
  const blanks = Object.keys(agentEnvironment).filter(
    (key) => SECRET_NAME.test(key) || /^ANTHROPIC_/i.test(key),
  );
  return { ...server, env: { ...Object.fromEntries(blanks.map((k) => [k, ''])), ...server.env } };
}
