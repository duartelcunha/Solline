import { z } from 'zod';
import { SpacesState } from './spaces.ts';
import { RulesState } from './rules.ts';
import { McpCatalogState } from './mcp-catalog.ts';
import { AgentId, AskBlock, ConversationDelta, SessionState, Workspace } from './conversation.ts';
import { Checks, SetupState } from './checks.ts';
import { LedgerView } from './ledger.ts';
import { Race } from './race.ts';
import { Quality } from './quality.ts';
import { Timeline } from './review.ts';
import { ConsultOutcome, ConsultRequest } from './consult.ts';

/**
 * Eventos que o motor emite sem pedido (motor -> main -> interface).
 * A interface constrói o estado de cada sessão só a partir daqui.
 */

export const EngineReadyEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('engine.ready'),
  engineVersion: z.string(),
  pid: z.number().int(),
});

/** Um passo da conversa já normalizado. */
export const SessionEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.event'),
  sessionId: z.string(),
  delta: ConversationDelta,
});

export const SessionStateEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.state'),
  sessionId: z.string(),
  state: SessionState,
  /** Mensagem calma para mostrar quando state é error. */
  error: z.string().optional(),
});

/** O agente parou à espera de ti: permissão, plano ou pergunta. */
export const PermissionRequestEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('permission.request'),
  sessionId: z.string(),
  turnId: z.string(),
  request: AskBlock,
});

/**
 * Um agente pediu para perguntar a outro ou delegar uma tarefa: o pedido fica à espera do
 * utilizador (consult.answer) até chegar o consult.settled. Não vai para o diário de recuperação:
 * depois de reiniciar o motor o agente já não existe, e o pedido cai com ele.
 */
export const ConsultRequestEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('consult.request'),
  sessionId: z.string(),
  request: ConsultRequest,
});

/** O pedido deixou de estar à espera: o utilizador decidiu, ou foi cancelado (sessão fechada, turno interrompido). */
export const ConsultSettledEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('consult.settled'),
  sessionId: z.string(),
  requestId: z.string(),
  outcome: ConsultOutcome,
});

/** A linha do tempo de uma sessão mudou: checkpoint novo, turno acabado, rever ou rebobinar. */
export const SessionTimelineEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.timeline'),
  sessionId: z.string(),
  timeline: Timeline,
});

/** A segunda opinião de uma sessão mudou: começou a rever, acabou ou foi ligada/desligada. */
export const SessionQualityEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.quality'),
  sessionId: z.string(),
  quality: Quality,
});

/** As verificações do projeto desta sessão mudaram: começaram, acabaram ou foram esquecidas. */
export const SessionChecksEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.checks'),
  sessionId: z.string(),
  checks: Checks,
});

/** O livro de custo desta sessão mudou. */
export const SessionLedgerEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.ledger'),
  sessionId: z.string(),
  ledger: LedgerView,
});

/** Onde a sessão trabalha mudou: o branch ganhou nome, mudaram os +/− ou o trabalho foi trazido. */
export const SessionWorkspaceEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.workspace'),
  sessionId: z.string(),
  workspace: Workspace,
});

/** A fila de uma sessão mudou: entrou, saiu, mudou de ordem ou ficou em pausa. */
export const SessionQueueEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.queue'),
  sessionId: z.string(),
  queue: z.object({
    items: z.array(z.object({ id: z.string(), text: z.string() })),
    /** Interrompeste: a fila espera por "Continuar". */
    paused: z.boolean(),
  }),
});
export type SessionQueue = z.infer<typeof SessionQueueEvent>['queue'];

/**
 * Passagem de testemunho: a sessão passou o trabalho a outra (`handedTo`) e deixa de enviar, ou
 * (null) voltou a poder enviar. Quem tem a pasta é sempre a sessão sem `handedTo`.
 */
/** O PR entrou. A sessão passa a ser só de leitura. Uma vez. */
export const SessionArchivedEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.archived'),
  sessionId: z.string(),
});

export const SessionHandoffEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.handoff'),
  sessionId: z.string(),
  handedTo: z.string().nullable(),
});

/** A preparação da worktree de uma sessão mudou (começou, acabou ou falhou). */
export const SessionSetupEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.setup'),
  sessionId: z.string(),
  setup: SetupState,
});

/** Uma corrida mudou: uma pista mudou de estado, acabaram todas, ou foi ordenada. */
export const RaceStateEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('race.state'),
  race: Race,
});

export const EngineErrorEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('engine.error'),
  message: z.string(),
  sessionId: z.string().optional(),
});

/** O estado de um agente mudou (um login acabou, por exemplo): volta a pedir agents.list. */
export const AgentsChangedEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('agents.changed'),
  agent: AgentId.optional(),
  /** Mensagem calma quando o que mudou foi uma falha (login recusado ou expirado). */
  error: z.string().optional(),
});

export const EngineEvent = z
  .discriminatedUnion('type', [
    z.object({ kind: z.literal('event'), type: z.literal('spaces.changed'), spaces: SpacesState }),
    z.object({ kind: z.literal('event'), type: z.literal('rules.changed'), rules: RulesState }),
    /** O catálogo MCP mudou (um servidor acrescentado, aprovado, sondado ou escolhido por um projeto). */
    z.object({ kind: z.literal('event'), type: z.literal('mcp.changed'), mcp: McpCatalogState }),
    AgentsChangedEvent,
    EngineReadyEvent,
    SessionEvent,
    SessionStateEvent,
    PermissionRequestEvent,
    ConsultRequestEvent,
    ConsultSettledEvent,
    SessionTimelineEvent,
    SessionQualityEvent,
    SessionChecksEvent,
    SessionLedgerEvent,
    SessionWorkspaceEvent,
    SessionQueueEvent,
    SessionHandoffEvent,
    SessionArchivedEvent,
    SessionSetupEvent,
    RaceStateEvent,
    EngineErrorEvent,
  ])
  .and(
    z.object({ epoch: z.string().optional(), sequence: z.number().int().nonnegative().optional() }),
  );
export type EngineEvent = z.infer<typeof EngineEvent>;
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionStateEvent = z.infer<typeof SessionStateEvent>;
export type PermissionRequestEvent = z.infer<typeof PermissionRequestEvent>;
export type ConsultRequestEvent = z.infer<typeof ConsultRequestEvent>;
export type ConsultSettledEvent = z.infer<typeof ConsultSettledEvent>;
export type SessionTimelineEvent = z.infer<typeof SessionTimelineEvent>;
export type SessionQualityEvent = z.infer<typeof SessionQualityEvent>;
export type SessionChecksEvent = z.infer<typeof SessionChecksEvent>;
export type SessionHandoffEvent = z.infer<typeof SessionHandoffEvent>;
export type AgentsChangedEvent = z.infer<typeof AgentsChangedEvent>;
