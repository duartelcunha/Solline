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

/**
 * A parte de uma repartição que esta pista faz: o objetivo e o contrato (o que pode e não pode
 * tocar, as interfaces combinadas, o que se espera no fim). A parte zero corre primeiro.
 */
export const SplitPart = z
  .object({
    title: z.string().min(1).max(200),
    goal: z.string().min(1).max(20_000),
    /** Caminhos ou globs que a parte pode tocar. */
    allowed: z.array(z.string().min(1).max(500)).max(200),
    forbidden: z.array(z.string().min(1).max(500)).max(200),
    interfaces: z.string().max(20_000),
    expected: z.string().max(20_000),
    /** O id de uma verificação do projeto que tem de passar (se houver). */
    check: z.string().min(1).max(200).nullable(),
    /** A parte zero: prepara o terreno e corre antes das outras. */
    zero: z.boolean(),
  })
  .strict();
export type SplitPart = z.infer<typeof SplitPart>;

export const RaceLane = z.object({
  sessionId: z.string(),
  agent: AgentId,
  model: z.string().nullable(),
  state: SessionState,
  /** Só nas repartições: a parte que a pista faz. */
  part: SplitPart.optional(),
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

/** race: o mesmo pedido em todas as pistas · split: cada pista faz uma parte diferente. */
export const RaceKind = z.enum(['race', 'split']);
export type RaceKind = z.infer<typeof RaceKind>;

/**
 * Um aviso de uma repartição, nunca um castigo: a pista mexeu fora do que o contrato permite
 * (`outside`) ou o que ela tem já choca com o de outra pista (`collision`, com a pista `other`).
 */
export const SplitWarning = z
  .object({
    sessionId: z.string(),
    kind: z.enum(['outside', 'collision']),
    path: z.string(),
    other: z.string().optional(),
  })
  .strict();
export type SplitWarning = z.infer<typeof SplitWarning>;

/**
 * Uma parte que ainda não arrancou. `after` é a parte de cuja entrega arranca (o resultado dela é
 * a base desta); sem `after`, arranca do HEAD do projeto.
 */
export const SplitPending = z
  .object({
    index: z.number().int().min(0),
    part: SplitPart,
    agent: AgentId,
    model: z.string().min(1).max(200).optional(),
    after: z.number().int().min(0).nullable(),
  })
  .strict();
export type SplitPending = z.infer<typeof SplitPending>;

/** O que só as repartições têm: as partes por arrancar e os avisos até agora. */
export const RaceSplit = z
  .object({ pending: z.array(SplitPending), warnings: z.array(SplitWarning) })
  .strict();
export type RaceSplit = z.infer<typeof RaceSplit>;

export const Race = z.object({
  id: z.string(),
  /** Sem `kind` (corridas gravadas antes das repartições) é uma corrida. */
  kind: RaceKind.default('race'),
  projectId: z.string(),
  text: z.string(),
  /** Só as pistas que já arrancaram (as partes por arrancar estão em `split.pending`). */
  lanes: z.array(RaceLane),
  phase: RacePhase,
  verdict: RaceVerdict.nullable().optional(),
  assembly: RaceAssembly.nullable().optional(),
  split: RaceSplit.optional(),
});
export type Race = z.infer<typeof Race>;

export const RaceStartPayload = z
  .object({
    projectId: z.string().min(1).max(64),
    text: z.string().min(1).max(200_000),
    lanes: z.array(RaceLaneSpec).min(2).max(4),
  })
  .strict();
