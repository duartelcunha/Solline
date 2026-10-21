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

/** Como ficou cada pista: posição, verificações, grupo (soluções iguais) e as notas do juiz. */
export const RaceLaneVerdict = z.object({
  sessionId: z.string(),
  rank: z.number().int(),
  /** Verificações que falharam por culpa da mudança (as que já falhavam na base não contam). */
  failures: z.number().int(),
  checks: z.array(
    z.object({
      label: z.string(),
      state: z.enum(['passed', 'failed', 'timeout']),
      preexisting: z.boolean(),
    }),
  ),
  /** Pistas com o mesmo patch partilham o grupo (consenso). */
  group: z.number().int(),
  /** Não mudou nada. */
  empty: z.boolean(),
  best: z.string().nullable(),
  worst: z.string().nullable(),
});
export type RaceLaneVerdict = z.infer<typeof RaceLaneVerdict>;

export const RaceVerdict = z.object({
  lanes: z.array(RaceLaneVerdict),
  /** Empate que o juiz não desfez (as duas ordens discordaram): decides tu entre estas. */
  tie: z.array(z.string()).nullable(),
  /** O juiz chegou a ser chamado (só nos empates da execução). */
  judged: z.boolean(),
  /** O juiz falhou: a ordem é só a da execução. */
  judgeError: z.string().nullable(),
});
export type RaceVerdict = z.infer<typeof RaceVerdict>;

export const Race = z.object({
  id: z.string(),
  projectId: z.string(),
  text: z.string(),
  lanes: z.array(RaceLane),
  phase: RacePhase,
  verdict: RaceVerdict.nullable().optional(),
});
export type Race = z.infer<typeof Race>;

export const RaceStartPayload = z
  .object({
    projectId: z.string().min(1).max(64),
    text: z.string().min(1).max(200_000),
    lanes: z.array(RaceLaneSpec).min(2).max(4),
  })
  .strict();
