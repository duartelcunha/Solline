import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type {
  AgentCapabilities,
  CanonicalTaskState,
  CheckSpec,
  Checks,
  ConversationRewind,
  EngineCommandResult,
  EngineEvent,
  Orphan,
  RecoverySession,
  SessionInfo,
  SessionStartPayload,
  SetupSpec,
  Timeline,
  Turn,
  Workspace,
  WorktreeStats,
} from '@solline/protocol';
import type { AdapterSink, AgentAdapter, McpServerLaunch } from '../adapters/types.ts';
import type { AgentDefinition, AgentRegistry } from '../agents/registry.ts';
import type { BrainBinding } from '../brain/brain.ts';
import type { ProjectChecks } from '../checks/project-checks.ts';
import type { RunCommand } from '../checks/run.ts';
import type { SessionCheckpoints } from '../checkpoints/session-checkpoints.ts';
import type { CheckpointStore } from '../checkpoints/store.ts';
import type { ConsultManager } from '../consult/manager.ts';
import type { CircuitRegistry } from '../kernel/circuit-breaker.ts';
import type { SessionLedger } from '../ledger/ledger.ts';
import type { SavedSession } from '../recovery/state.ts';
import type { RepairLoop } from '../repair/loop.ts';
import type { RulesManager } from '../rules/manager.ts';
import type { How, SessionTurns, Submitted } from '../session-turns.ts';
import type { Reviewer } from '../quality/reviewer.ts';
import type { ReviewerPicker } from '../quality/routing.ts';
import type { SessionQuality } from '../quality/session-quality.ts';
import type { PortAllocator } from '../workspace/ports.ts';
import type { Worktree, WorktreeManager } from '../worktrees/worktrees.ts';

/** Com um servidor MCP que corre programas ligado, nada de modos sem perguntas. */
export const RESTRICTED_RISKS = new Set(['auto', 'full']);
/** Origens que ficam sem os servidores que o projeto escolheu (ver #projectMcp). */
export const NO_PROJECT_MCP = new Set(['lane', 'part', 'ask', 'delegate']);
export const MAX_MCP = 8;

export const READ_ONLY_DENIAL =
  'Esta é uma consulta só de leitura: não podes alterar nada nem pedir permissões. Lê o que precisares e responde.';

export const NO_STATS: WorktreeStats = { files: 0, additions: 0, deletions: 0 };

/** Para testes: troca como se correm e encontram os comandos. */
export interface ChecksOptions {
  run?: RunCommand;
  detect?: (cwd: string) => Promise<CheckSpec[]>;
}

export type SessionResult = EngineCommandResult<'session.start'>;

export interface CloseSessionResult {
  closed: boolean;
  queued?: number;
  stats?: WorktreeStats;
  conflicts?: string[];
  into?: string;
}

export interface SessionEntry {
  info: SessionInfo;
  adapter: AgentAdapter;
  definition: AgentDefinition;
  trusted: boolean;
  mcp: readonly McpServerLaunch[];
  /** As ferramentas da Solline desta sessão, até ela fechar ou arrancar de novo. */
  brain?: BrainBinding | undefined;
}

/** O que a sessão guarda para lá do adaptador (sobrevive a retomar e a rebobinar). */
export interface SessionMemory {
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
  /** Regras ativas ao arrancar (sem globs). */
  startupRuleIds: string[];
  /** Memórias aprovadas lidas ou pesquisadas por esta sessão. */
  usedMemoryIds: Set<string>;
  /** Pacote canónico de estado da tarefa (intenção real separada do rascunho de handoff). */
  taskState: CanonicalTaskState;
  /** Verdadeiro enquanto o primeiro turno de passagem ainda não entrou em `turns`. */
  awaitingHandoffTurn?: boolean | undefined;
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

export const DISABLED_TIMELINE = (rewind: ConversationRewind): Timeline => ({
  available: false,
  reason: 'os checkpoints estão desligados',
  checkpoints: [],
  pending: { files: 0, additions: 0, deletions: 0 },
  undo: null,
  conversationRewind: rewind,
  rewoundTo: null,
});

export function restrict(
  capabilities: AgentCapabilities,
  restricted: boolean,
): AgentCapabilities {
  if (!restricted) return capabilities;
  return {
    ...capabilities,
    modes: capabilities.modes.filter((m) => !RESTRICTED_RISKS.has(m.risk)),
  };
}

/** features.brain diz à interface se o agente desta sessão tem mesmo as ferramentas da Solline. */
export function withBrain(capabilities: AgentCapabilities, brain: boolean): AgentCapabilities {
  return brain
    ? { ...capabilities, features: { ...capabilities.features, brain: true } }
    : capabilities;
}

/** Quem nasceu de uma consulta ou delegação não consulta nem delega (profundidade 1). */
export function opensFromConsult(info: Pick<SessionInfo, 'origin'>): boolean {
  return info.origin?.kind === 'ask' || info.origin?.kind === 'delegate';
}

/** Uma consulta só lê: nunca muda o modo, não tem checkpoints nem segunda opinião. */
export function isConsult(info: Pick<SessionInfo, 'origin'>): boolean {
  return info.origin?.kind === 'ask';
}

/** Nascem com o título que lhes deram (a primeira mensagem é o aviso ou o enquadramento, não o assunto). */
export function keepsTitle(info: Pick<SessionInfo, 'origin'>): boolean {
  const kind = info.origin?.kind;
  return kind === 'handoff' || kind === 'fork' || kind === 'ask' || kind === 'delegate';
}

/** A pasta tem de ser absoluta e existir; o main já a tirou de um projeto conhecido. */
export async function defaultCheckCwd(cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) throw new Error('A pasta da sessão tem de ser um caminho absoluto');
  const isDir = await stat(cwd).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) throw new Error('A pasta do projeto já não existe');
}

export interface SessionHost {
  readonly sessions: Map<string, SessionEntry>;
  readonly memory: Map<string, SessionMemory>;
  readonly recoveryViews: Map<string, RecoverySession>;
  readonly ledgers: Map<string, SessionLedger>;
  readonly repairs: Map<string, RepairLoop>;
  readonly checks: Map<string, ProjectChecks>;
  readonly checkProjects: Map<string, string>;
  readonly unavailableHistory: Map<string, SavedSession>;
  readonly unresolvedWorktrees: Set<string>;
  readonly setups: Map<string, SetupSpec | null>;
  readonly handingOff: Set<string>;
  readonly placing: Set<string>;
  readonly anchors: Map<string, Worktree>;
  readonly ports: PortAllocator;
  readonly worktrees: WorktreeManager | undefined;
  readonly store: CheckpointStore | undefined;
  readonly registry: AgentRegistry;
  readonly checksOptions: ChecksOptions | undefined;
  readonly circuits: CircuitRegistry;
  readonly reviewer: Reviewer | undefined;
  readonly pickReviewer: ReviewerPicker | undefined;
  readonly rules: RulesManager | undefined;
  readonly consult: Pick<ConsultManager, 'interrupted' | 'sessionClosed' | 'stop'> | undefined;
  readonly claimed: () => readonly string[];
  isStopping(): boolean;

  emit(event: EngineEvent): void;
  beforeEffect(command: string, sessionId: string, text?: string): () => void;
  get(sessionId: string): SessionEntry;
  memoryOf(sessionId: string): SessionMemory;
  checkpoints(sessionId: string): SessionCheckpoints;
  rewindKind(sessionId: string): ConversationRewind;
  emitTimeline(sessionId: string, timeline?: Timeline): void;
  emitRepair(sessionId: string): void;
  repairOf(sessionId: string): RepairLoop;
  requireWritable(entry: SessionEntry): void;
  requireActive(entry: SessionEntry): void;
  requireIdle(entry: SessionEntry, memory: SessionMemory, what: string): void;
  mcpFor(definition: AgentDefinition, ids: readonly string[]): Promise<McpServerLaunch[]>;
  startAdapter(
    info: SessionInfo,
    definition: AgentDefinition,
    trusted: boolean,
    mcp: readonly McpServerLaunch[],
    resume?: string,
    requested?: { model?: string | undefined; effort?: string | undefined },
    fork?: string,
  ): Promise<SessionResult>;
  deltaFor(
    info: SessionInfo,
    memory: SessionMemory | undefined,
  ): (delta: Parameters<AdapterSink['delta']>[0]) => void;
  turnsFor(info: () => SessionInfo): SessionTurns;
  create(
    payload: SessionStartPayload,
    inherit?: { workspace: Workspace },
    forked?: { worktree: Worktree; point?: string | undefined; named?: boolean },
  ): Promise<SessionResult>;
  send(sessionId: string, text: string, how?: How, submissionId?: string): Promise<Submitted>;
  close(
    sessionId: string,
    choice?: 'bring' | 'keep' | 'discard',
    dropQueue?: boolean,
  ): Promise<CloseSessionResult>;
  backgroundFailure(sessionId: string, error: unknown): void;
  check(sessionId: string, turnId: string): Promise<void>;
  review(
    sessionId: string,
    turnId: string,
    how?: { trigger: 'turn' | 'manual' | 'bring'; scope: 'turn' | 'session' },
  ): Promise<void>;
  bring(sessionId: string): Promise<{ merged: boolean; conflicts: string[]; into: string }>;
  closeSession(
    sessionId: string,
    choice?: 'bring' | 'keep' | 'discard',
    dropQueue?: boolean,
  ): Promise<CloseSessionResult>;
  checksFor(
    projectId: string,
    cwd: string,
    trusted: boolean,
    saved: CheckSpec[] | null,
    port?: number,
    recovery?: Checks,
  ): void;
  maybeRepair(sessionId: string, state: Checks): Promise<void>;
  setClaimed(paths: () => readonly string[]): void;
  markStopping(): void;
  orphansList?(): Promise<Orphan[]>;
}
