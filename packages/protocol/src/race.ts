import { z } from 'zod';
import { AgentId, SessionState } from './conversation.ts';

/**
 * Uma corrida: o mesmo pedido em várias pistas (agente + modelo), cada uma na sua worktree. O
 * Verificador e o juiz cego ordenam-nas no fim; tu montas o resultado hunk a hunk.
 */

export const RaceLaneSpec = z
  .object({ agent: AgentId, model: z.string().min(1).max(200).optional() })
  .strict();
export type RaceLaneSpec = z.infer<typeof RaceLaneSpec>;

export const RaceLane = z.object({
  sessionId: z.string(),
  agent: AgentId,
  model: z.string().nullable(),
  state: SessionState,
});
export type RaceLane = z.infer<typeof RaceLane>;

/** running: as pistas trabalham · done: todas pararam · ranking/ranked: a ordenar e ordenada. */
export const RacePhase = z.enum(['running', 'done', 'ranking', 'ranked', 'closed']);
export type RacePhase = z.infer<typeof RacePhase>;

export const Race = z.object({
  id: z.string(),
  projectId: z.string(),
  text: z.string(),
  lanes: z.array(RaceLane),
  phase: RacePhase,
});
export type Race = z.infer<typeof Race>;

export const RaceStartPayload = z
  .object({
    projectId: z.string().min(1).max(64),
    text: z.string().min(1).max(200_000),
    lanes: z.array(RaceLaneSpec).min(2).max(4),
  })
  .strict();
