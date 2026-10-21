import { z } from 'zod';
import { AgentId, AskBlock, ConversationDelta, SessionState, Workspace } from './conversation.ts';
import { Checks } from './checks.ts';
import { Quality } from './quality.ts';
import { Timeline } from './review.ts';

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

/** Onde a sessão trabalha mudou: o branch ganhou nome, mudaram os +/− ou o trabalho foi trazido. */
export const SessionWorkspaceEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('session.workspace'),
  sessionId: z.string(),
  workspace: Workspace,
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

export const EngineEvent = z.discriminatedUnion('type', [
  AgentsChangedEvent,
  EngineReadyEvent,
  SessionEvent,
  SessionStateEvent,
  PermissionRequestEvent,
  SessionTimelineEvent,
  SessionQualityEvent,
  SessionChecksEvent,
  SessionWorkspaceEvent,
  EngineErrorEvent,
]);
export type EngineEvent = z.infer<typeof EngineEvent>;
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionStateEvent = z.infer<typeof SessionStateEvent>;
export type PermissionRequestEvent = z.infer<typeof PermissionRequestEvent>;
export type SessionTimelineEvent = z.infer<typeof SessionTimelineEvent>;
export type SessionQualityEvent = z.infer<typeof SessionQualityEvent>;
export type SessionChecksEvent = z.infer<typeof SessionChecksEvent>;
export type AgentsChangedEvent = z.infer<typeof AgentsChangedEvent>;
