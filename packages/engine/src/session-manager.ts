import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
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
  type Orphan,
  type Workspace,
  type WorktreeStats,
  type Timeline,
  type Turn,
} from '@solline/protocol';
import type { AgentAdapter, AdapterSink, McpServerLaunch } from './adapters/types.ts';
import type { SessionCheckpoints } from './checkpoints/session-checkpoints.ts';
import type { CheckpointStore } from './checkpoints/store.ts';
import { commentsMessage, summaryOf, textOf } from './review.ts';
import type { Reviewer } from './quality/reviewer.ts';
import { NO_REVIEW, SessionQuality, fixMessage } from './quality/session-quality.ts';
import { ProjectChecks, checkFixMessage } from './checks/project-checks.ts';
import type { RunCommand } from './checks/run.ts';
import type { Worktree, WorktreeManager } from './worktrees/worktrees.ts';
import type { AgentDefinition, AgentRegistry } from './agents/registry.ts';
import { SECRET_NAME, agentEnv } from './env.ts';
import { safestMode } from './adapters/acp/capabilities.ts';
import type { McpCatalog } from './mcp/catalog.ts';

/** Com um servidor MCP que corre programas ligado, nada de modos sem perguntas. */
const RESTRICTED_RISKS = new Set(['auto', 'full']);

function restrict(capabilities: AgentCapabilities, restricted: boolean): AgentCapabilities {
  if (!restricted) return capabilities;
  return {
    ...capabilities,
    modes: capabilities.modes.filter((m) => !RESTRICTED_RISKS.has(m.risk)),
  };
}

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
  /** A enviar ou a rebobinar: um segundo pedido igual espera que este acabe. */
  busy: boolean;
  /** Resumo que segue com a próxima mensagem, depois de rebobinar numa sessão nova. */
  context: string | undefined;
  /** A segunda opinião: um revisor lê o diff de cada turno (sem revisor, não existe). */
  quality: SessionQuality | undefined;
  /** A worktree da sessão (só quando o projeto já tinha uma sessão na pasta). */
  worktree: Worktree | undefined;
  /** O branch já tem o nome da primeira mensagem. */
  named: boolean;
  /** Um "Trazer" a meio: fechar espera por ele. */
  bringing: Promise<unknown> | undefined;
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
 * shortcut: as sessões só vivem em memória e desaparecem ao fechar a app; o M3 traz o
 * histórico (listSessions/getSessionMessages).
 */
export class SessionManager {
  readonly #sessions = new Map<string, Entry>();
  readonly #memory = new Map<string, Memory>();
  readonly #emit: (event: EngineEvent) => void;
  readonly #registry: AgentRegistry;
  readonly #mcp: McpCatalog | undefined;
  readonly #checkCwd: (cwd: string) => Promise<void>;
  readonly #store: CheckpointStore | undefined;
  readonly #keysFor: (agent: string) => Promise<readonly string[]>;
  readonly #reviewer: Reviewer | undefined;
  readonly #checksOptions: ChecksOptions | undefined;
  /** As verificações de cada pasta de trabalho (por cwd), partilhadas pelas sessões que lá estão. */
  readonly #checks = new Map<string, ProjectChecks>();
  /** O projeto de cada pasta com verificações (para a confiança e a lista do projeto). */
  readonly #checkProjects = new Map<string, string>();
  readonly #worktrees: WorktreeManager | undefined;

  constructor(options: {
    emit: (event: EngineEvent) => void;
    /** Os agentes que se podem abrir: modos, ambiente e adaptador de cada um. */
    registry: AgentRegistry;
    /** Servidores MCP que uma sessão pode pedir. */
    mcp?: McpCatalog | undefined;
    /** Para testes: troca a verificação da pasta. */
    checkCwd?: (cwd: string) => Promise<void>;
    /** Checkpoints escondidos por turno; sem isto, rever e rebobinar ficheiros ficam desligados. */
    checkpoints?: CheckpointStore | undefined;
    /** As variáveis escolhidas no painel para os agentes com configurableKeys. */
    keysFor?: (agent: string) => Promise<readonly string[]>;
    /** Quem dá a segunda opinião no fim de cada turno que mude ficheiros. */
    reviewer?: Reviewer | undefined;
    /** As verificações do projeto no fim de cada turno que mude ficheiros; sem isto, não há. */
    checks?: ChecksOptions | undefined;
    /** Worktrees para as sessões a mais de um projeto; sem isto, partilham a pasta. */
    worktrees?: WorktreeManager | undefined;
  }) {
    this.#emit = options.emit;
    this.#registry = options.registry;
    this.#mcp = options.mcp;
    this.#checkCwd = options.checkCwd ?? defaultCheckCwd;
    this.#store = options.checkpoints;
    this.#keysFor = options.keysFor ?? (async () => []);
    this.#reviewer = options.reviewer;
    this.#checksOptions = options.checks;
    this.#worktrees = options.worktrees;
  }

  async create(payload: SessionStartPayload): Promise<SessionResult> {
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
    const mcp = await this.#mcpFor(definition, payload.mcpServerIds ?? []);
    const restricted = mcp.some((s) => s.executesCode);
    const risk = known.find((m) => m.id === payload.mode)?.risk;
    if (restricted && risk && RESTRICTED_RISKS.has(risk)) {
      throw new Error(
        'Com um servidor MCP que corre programas, escolhe um modo que pergunte antes',
      );
    }
    const place = await this.#placeFor(payload.projectId, payload.cwd);
    const info: SessionInfo = {
      id: crypto.randomUUID(),
      projectId: payload.projectId,
      agent: payload.agent,
      cwd: place.cwd,
      workspace: place.workspace,
      // O título vem da primeira mensagem, na interface.
      title: 'Nova sessão',
      state: 'starting',
      settings: {
        model: payload.model ?? null,
        effort: payload.effort ?? null,
        mode: payload.mode ?? definition.defaultMode,
      },
      agentSessionId: null,
      ...(mcp.length ? { mcpServers: payload.mcpServerIds ?? [] } : {}),
    };
    const memory: Memory = {
      turns: [],
      checkpoints: undefined,
      points: new Map(),
      openTurn: null,
      busy: false,
      context: undefined,
      quality: this.#reviewer
        ? new SessionQuality({
            reviewer: this.#reviewer,
            enabled: true,
            emit: (quality) =>
              this.#emit({ kind: 'event', type: 'session.quality', sessionId: info.id, quality }),
          })
        : undefined,
      worktree: place.worktree,
      named: false,
      bringing: undefined,
    };
    this.#memory.set(info.id, memory);
    this.#checksFor(info.projectId, info.cwd, payload.trusted, payload.checks ?? null);
    let result: SessionResult;
    try {
      result = await this.#start(info, definition, payload.trusted, mcp, undefined, {
        model: payload.model,
        effort: payload.effort,
      });
    } catch (error) {
      this.#memory.delete(info.id);
      if (place.worktree)
        await this.#worktrees?.remove(place.worktree, true).catch(() => undefined);
      throw error;
    }
    // O primeiro checkpoint (o disco antes de tudo) faz-se por trás: a sessão já está pronta.
    const checkpoints = this.#store?.open(info.id, info.cwd, () => this.#rewindKind(info.id));
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
    return this.send(sessionId, checkFixMessage(failure.spec, failure.result));
  }

  #projectChecks(sessionId: string): ProjectChecks {
    const { info } = this.#get(sessionId);
    const checks = this.#checks.get(info.cwd);
    if (!checks) throw new Error('As verificações não estão disponíveis');
    return checks;
  }

  /** Abre (uma vez por pasta) as verificações e espalha cada mudança pelas sessões de lá. */
  #checksFor(projectId: string, cwd: string, trusted: boolean, saved: CheckSpec[] | null): void {
    if (!this.#checksOptions || this.#checks.has(cwd)) return;
    const checks = new ProjectChecks({
      cwd,
      saved,
      trusted,
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
    const resumeId = entry.adapter.agentSessionId();
    if (!resumeId) throw new Error('Esta sessão ainda não tem histórico no agente para retomar');
    await entry.adapter.close();
    return this.#start(entry.info, entry.definition, entry.trusted, entry.mcp, resumeId);
  }

  /**
   * Antes de a mensagem seguir, o disco fica guardado (o checkpoint deste turno) e o ponto
   * de rebobinar do agente também. Se o checkpoint falhar, a mensagem segue na mesma.
   */
  async send(sessionId: string, text: string): Promise<string> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    this.#requireIdle(entry, memory, 'mandar outra mensagem');
    memory.busy = true;
    // Um turno novo muda os ficheiros: a ronda de verificações a meio deixa de valer.
    this.#checks.get(entry.info.cwd)?.cancel();
    try {
      const turnId = crypto.randomUUID();
      const point = entry.adapter.rewindPoint?.();
      const checkpoints = memory.checkpoints;
      if (checkpoints) {
        const { staged, done } = checkpoints.beginTurn(turnId, text);
        await staged;
        memory.openTurn = turnId;
        void done.then(() => this.#emitTimeline(sessionId));
      }
      const context = memory.context;
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
      if (point !== undefined) memory.points.set(sent, point);
      if (memory.worktree && !memory.named) {
        memory.named = true;
        void this.#nameBranch(sessionId, text);
      }
      return sent;
    } finally {
      memory.busy = false;
    }
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
      this.#requireIdle(this.#get(sessionId), this.#memoryOf(sessionId), 'rejeitar');
    }
    const timeline = await this.#checkpoints(sessionId).apply(action, path, hunkId);
    this.#emitTimeline(sessionId, timeline);
    return timeline;
  }

  async undo(sessionId: string): Promise<Timeline> {
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
    return this.send(sessionId, commentsMessage(comments, files, note));
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
    this.#requireIdle(entry, memory, 'rebobinar');
    memory.busy = true;
    try {
      return await this.#rewind(entry, memory, turnId, options);
    } finally {
      memory.busy = false;
    }
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
          entry.mcp,
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
    return this.#get(sessionId).adapter.interrupt();
  }

  /** Modo, modelo e effort só passam se o agente os anunciou nas capacidades. */
  async setMode(sessionId: string, mode: string): Promise<void> {
    const { adapter, mcp } = this.#get(sessionId);
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

  async disposeAll(): Promise<void> {
    const entries = [...this.#sessions.values()];
    const memories = [...this.#memory.values()];
    this.#sessions.clear();
    this.#memory.clear();
    await Promise.all(entries.map((entry) => entry.adapter.close()));
    for (const m of memories) m.quality?.dispose();
    for (const c of this.#checks.values()) c.dispose();
    this.#checks.clear();
    this.#checkProjects.clear();
    await Promise.all(memories.map((m) => m.checkpoints?.dispose()));
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
      if (memory.quality?.state.enabled) void this.#review(sessionId, turnId);
      void this.#check(sessionId, turnId);
      if (memory.worktree) void this.#emitWorkspace(sessionId);
    });
  }

  /** A segunda opinião sobre um turno, se ele mudou ficheiros. Uma falha fica no estado. */
  async #review(sessionId: string, turnId: string): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    const memory = this.#memory.get(sessionId);
    const checkpoints = memory?.checkpoints;
    if (!entry || !memory?.quality || !checkpoints?.available) return;
    const checkpoint = checkpoints.timeline().checkpoints.find((c) => c.turnId === turnId);
    if (!checkpoint || checkpoint.stats.files === 0) return;
    const turn = memory.turns.find((t) => t.id === turnId && t.role === 'user');
    // Uma falha do diff chega ao estado como erro: o revisor nunca parece ter aprovado.
    await memory.quality.review(turnId, async () => {
      const diff = await checkpoints.diff({ kind: 'turn', turnId });
      return diff.length === 0
        ? null
        : { cwd: entry.info.cwd, diff, request: turn ? textOf(turn) : '' };
    });
  }

  /** As verificações do projeto depois de um turno que mudou ficheiros. */
  async #check(sessionId: string, turnId: string): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    const checkpoint = this.#memory
      .get(sessionId)
      ?.checkpoints?.timeline()
      .checkpoints.find((c) => c.turnId === turnId);
    if (!entry || !checkpoint || checkpoint.stats.files === 0) return;
    await this.#checks.get(entry.info.cwd)?.run(turnId);
  }

  /**
   * Onde trabalha uma sessão nova: a primeira de um projeto na pasta dele; com outra já lá, numa
   * worktree (se o projeto for git) ou na mesma pasta, marcada como partilhada.
   */
  async #placeFor(
    projectId: string,
    projectPath: string,
  ): Promise<{ cwd: string; workspace: Workspace; worktree?: Worktree }> {
    const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const taken = [...this.#sessions.values()].some(
      (e) => e.info.projectId === projectId && key(e.info.cwd) === key(projectPath),
    );
    if (!taken) return { cwd: projectPath, workspace: { kind: 'project' } };
    const worktree = await this.#worktrees?.create(projectPath, projectId).catch((error) => {
      console.error('[worktrees] não consegui criar a worktree:', error);
      return null;
    });
    if (!worktree) return { cwd: projectPath, workspace: { kind: 'shared' } };
    return {
      cwd: worktree.cwd,
      workspace: { kind: 'worktree', branch: worktree.branch, stats: NO_STATS },
      worktree,
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

  /** Traz o trabalho da worktree para o branch atual do projeto. */
  async bring(sessionId: string): Promise<{ merged: boolean; conflicts: string[]; into: string }> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    this.#requireIdle(entry, memory, 'trazer o trabalho');
    if (!memory.worktree || !this.#worktrees)
      throw new Error('Esta sessão trabalha na pasta do projeto');
    memory.busy = true;
    const done = this.#bring(sessionId, memory).finally(() => {
      memory.busy = false;
      memory.bringing = undefined;
    });
    memory.bringing = done;
    return done;
  }

  async #bring(
    sessionId: string,
    memory: Memory,
  ): Promise<{ merged: boolean; conflicts: string[]; into: string }> {
    if (!memory.worktree || !this.#worktrees)
      throw new Error('Esta sessão trabalha na pasta do projeto');
    const first = memory.turns.find((t) => t.role === 'user');
    const title = (first ? textOf(first).split('\n')[0] : undefined)?.slice(0, 72) || 'sessão';
    const { result, wt } = await this.#worktrees.bring(memory.worktree, `Solline: ${title}`);
    memory.worktree = wt;
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
  ): Promise<{ closed: boolean; stats?: WorktreeStats; conflicts?: string[] }> {
    const entry = this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    await memory.bringing?.catch(() => undefined);
    const worktree = memory.worktree;
    if (worktree && this.#worktrees) {
      const stats = await this.#worktrees.statsOrNone(worktree);
      if (stats.files > 0) {
        if (!choice) return { closed: false, stats };
        if (choice === 'bring') {
          const result = await this.bring(sessionId);
          if (!result.merged) return { closed: false, conflicts: result.conflicts };
        }
      }
    }
    this.#sessions.delete(sessionId);
    this.#memory.delete(sessionId);
    await entry.adapter.close().catch(() => undefined);
    memory.quality?.dispose();
    await memory.checkpoints?.dispose();
    const cwd = entry.info.cwd;
    if (![...this.#sessions.values()].some((e) => e.info.cwd === cwd)) {
      this.#checks.get(cwd)?.dispose();
      this.#checks.delete(cwd);
      this.#checkProjects.delete(cwd);
    }
    if (worktree && this.#worktrees) {
      const current = memory.worktree ?? worktree;
      await this.#worktrees.remove(current, choice !== 'keep').catch((error) => {
        console.error('[worktrees] não consegui tirar a worktree:', error);
      });
    }
    return { closed: true };
  }

  /** As worktrees no disco sem sessão aberta, com o que mudou em cada uma. */
  async orphans(): Promise<Orphan[]> {
    const worktrees = this.#worktrees;
    if (!worktrees) return [];
    const open = new Set(
      [...this.#memory.values()].flatMap((m) => (m.worktree ? [m.worktree.path] : [])),
    );
    const found = await worktrees.orphans(open);
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
    const open = new Set(
      [...this.#memory.values()].flatMap((m) => (m.worktree ? [m.worktree.path] : [])),
    );
    const wt = (await this.#worktrees?.orphans(open))?.find(
      (w) => `${w.projectId}/${w.suffix}` === id,
    );
    if (!wt) throw new Error('Essa worktree já não existe');
    return wt;
  }

  async bringOrphan(id: string): Promise<{ merged: boolean; conflicts: string[]; into: string }> {
    const worktrees = this.#requireWorktrees();
    const wt = await this.#orphan(id);
    const { result, wt: next } = await worktrees.bring(wt, `Solline: ${wt.branch}`);
    if (result.merged) await worktrees.remove(next, true);
    return result;
  }

  async discardOrphan(id: string): Promise<void> {
    await this.#requireWorktrees().remove(await this.#orphan(id), true);
  }

  #requireWorktrees(): WorktreeManager {
    if (!this.#worktrees) throw new Error('As worktrees estão desligadas');
    return this.#worktrees;
  }

  quality(sessionId: string): Quality {
    this.#get(sessionId);
    return (
      this.#memoryOf(sessionId).quality?.state ?? {
        available: false,
        enabled: false,
        review: NO_REVIEW,
      }
    );
  }

  setQualityEnabled(sessionId: string, enabled: boolean): Quality {
    this.#get(sessionId);
    const quality = this.#memoryOf(sessionId).quality;
    if (!quality) throw new Error('A segunda opinião não está disponível');
    return quality.setEnabled(enabled);
  }

  /** Volta a rever o último turno com checkpoint, agora. */
  async reviewNow(sessionId: string): Promise<Quality> {
    this.#get(sessionId);
    const memory = this.#memoryOf(sessionId);
    if (!memory.quality) throw new Error('A segunda opinião não está disponível');
    const last = memory.checkpoints?.timeline().checkpoints.at(-1);
    if (!last || last.state !== 'done') throw new Error('Ainda não há nenhum turno acabado');
    // Não espera pelo fim (uma revisão leva segundos); o resultado chega por session.quality.
    void this.#review(sessionId, last.turnId);
    return memory.quality.state;
  }

  /** Pede ao agente da sessão para corrigir os achados escolhidos. */
  async fix(sessionId: string, ids: readonly string[]): Promise<string> {
    const findings = this.#memoryOf(sessionId).quality?.pick(ids) ?? [];
    if (findings.length === 0) throw new Error('Esses achados já não existem');
    return this.send(sessionId, fixMessage(findings));
  }

  /** Mexer no disco ou na conversa só com o agente parado e nada a meio. */
  #requireIdle(entry: Entry, memory: Memory, what: string): void {
    const state = entry.info.state;
    if (memory.busy || (state !== 'idle' && state !== 'error')) {
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
    const env = agentEnv(policy);
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
        ...(mcp.length ? { mcpServers: mcp.map((s) => withoutSecrets(s, env)) } : {}),
      },
      this.#sinkFor(
        info,
        () => entry.adapter,
        mcp.some((s) => s.executesCode),
      ),
    );
    entry.adapter = adapter;
    const isNew = !this.#sessions.has(info.id);
    this.#sessions.set(info.id, { info, adapter, definition, trusted, mcp });
    const restricted = mcp.some((s) => s.executesCode);
    let started: Awaited<ReturnType<AgentAdapter['start']>> | undefined;
    try {
      started = await adapter.start();
      if (requested) checkRequested(started.capabilities, requested);
      info.settings = started.settings;
      info.state = 'idle';
      // Um modo que o agente aceitou no arranque mas não anuncia (por exemplo Auto num modelo
      // sem suporte) volta ao modo por omissão: a interface nunca mostra um modo que não há.
      const fallback = definition.defaultMode;
      const visible = restrict(started.capabilities, restricted);
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
      return { session: { ...info }, capabilities: visible };
    } catch (error) {
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
  ): AdapterSink {
    const emit = this.#emit;
    const forward = this.#deltaFor(info, this.#memory.get(info.id));
    return {
      delta: (raw) => {
        const cleaned = withoutUnreportedCost(raw, adapter());
        forward(
          cleaned.type === 'capabilities'
            ? { ...cleaned, capabilities: restrict(cleaned.capabilities, restricted) }
            : cleaned,
        );
      },
      state: (state, error) => {
        info.state = state;
        if (state === 'idle' || state === 'error') this.#turnSettled(info.id);
        emit({
          kind: 'event',
          type: 'session.state',
          sessionId: info.id,
          state,
          ...(error ? { error } : {}),
        });
      },
      ask: (turnId, request) => {
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
      if (memory) memory.turns = applyDelta(memory.turns, delta);
      this.#emit({ kind: 'event', type: 'session.event', sessionId: info.id, delta });
    };
  }

  #get(sessionId: string): Entry {
    const entry = this.#sessions.get(sessionId);
    if (!entry) throw new Error('Sessão desconhecida (o motor pode ter reiniciado)');
    return entry;
  }
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
