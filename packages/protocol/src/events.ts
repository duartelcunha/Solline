import { z } from 'zod';
import { AskBlock, ConversationDelta, SessionState } from './conversation.ts';
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

export const EngineErrorEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('engine.error'),
  message: z.string(),
  sessionId: z.string().optional(),
});

export const EngineEvent = z.discriminatedUnion('type', [
  EngineReadyEvent,
  SessionEvent,
  SessionStateEvent,
  PermissionRequestEvent,
  SessionTimelineEvent,
  EngineErrorEvent,
]);
export type EngineEvent = z.infer<typeof EngineEvent>;
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionStateEvent = z.infer<typeof SessionStateEvent>;
export type PermissionRequestEvent = z.infer<typeof PermissionRequestEvent>;
export type SessionTimelineEvent = z.infer<typeof SessionTimelineEvent>;
