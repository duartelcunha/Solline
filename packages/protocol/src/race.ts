import { z } from 'zod';
import { AgentId, SessionState } from './conversation.ts';
import { FileStatus, Hunk } from './review.ts';

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

/**
 * running: as pistas trabalham · done: todas pararam · ranking/ranked: a ordenar e ordenada ·
 * assembling/assembled: a montar e montada (a worktree da montagem existe) · closed: fechada.
 */
export const RacePhase = z.enum([
  'running',
  'done',
  'ranking',
  'ranked',
  'assembling',
  'assembled',
  'closed',
]);
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

/** Um pedaço de código que uma ou mais pistas escreveram, igual (sem contar espaços). */
export const RaceCandidate = z.object({
  /** Estável entre cálculos: o caminho e um resumo do conteúdo. */
  id: z.string(),
  /** As pistas que escreveram exatamente isto (mais de uma é consenso). */
  lanes: z.array(z.string()),
  /** O que a pista escreveu nesta zona: um ou mais hunks, de cima para baixo. */
  hunks: z.array(Hunk),
  /** A escolha de partida: a mais votada, ou a da pista melhor ordenada. */
  preferred: z.boolean(),
});
export type RaceCandidate = z.infer<typeof RaceCandidate>;

/** Uma zona do ficheiro onde pelo menos uma pista mexeu; só um candidato lá pode entrar. */
export const RaceSlot = z.object({ id: z.string(), candidates: z.array(RaceCandidate) });
export type RaceSlot = z.infer<typeof RaceSlot>;

export const RaceProposalFile = z.object({
  path: z.string(),
  status: FileStatus,
  slots: z.array(RaceSlot),
});
export type RaceProposalFile = z.infer<typeof RaceProposalFile>;

/** O que se pode montar: ficheiro a ficheiro, zona a zona, com as escolhas de partida. */
export const RaceProposal = z.object({
  files: z.array(RaceProposalFile),
  /** Ficheiros que não se montam pedaço a pedaço (binários, enormes) e porquê. */
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type RaceProposal = z.infer<typeof RaceProposal>;

/** A montagem: uma worktree própria com os pedaços escolhidos, já verificada. */
export const RaceAssembly = z.object({
  branch: z.string(),
  path: z.string(),
  top: z.string(),
  files: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  checks: z.array(
    z.object({
      label: z.string(),
      state: z.enum(['passed', 'failed', 'timeout']),
      preexisting: z.boolean(),
    }),
  ),
  failures: z.number().int(),
  /** Já foi trazida para o projeto (e para onde). */
  brought: z.object({ into: z.string() }).nullable(),
});
export type RaceAssembly = z.infer<typeof RaceAssembly>;

export const Race = z.object({
  id: z.string(),
  projectId: z.string(),
  text: z.string(),
  lanes: z.array(RaceLane),
  phase: RacePhase,
  verdict: RaceVerdict.nullable().optional(),
  assembly: RaceAssembly.nullable().optional(),
});
export type Race = z.infer<typeof Race>;

export const RaceStartPayload = z
  .object({
    projectId: z.string().min(1).max(64),
    text: z.string().min(1).max(200_000),
    lanes: z.array(RaceLaneSpec).min(2).max(4),
  })
  .strict();
