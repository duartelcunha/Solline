import { z } from 'zod';
import { AgentId, SessionState } from './conversation.ts';
import { Finding } from './quality.ts';
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

/** Num glob, cada `{` tem de fechar (e nenhum `}` fica solto). */
function bracesBalanced(entry: string): boolean {
  let depth = 0;
  for (const c of entry) {
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * A parte como entrada (para rever ou lançar): igual a `SplitPart`, mas as zonas não podem ter
 * chavetas por fechar. O que vem do disco ou do planeador não passa por aqui.
 */
export const SplitPartInput = SplitPart.refine(
  (part) => [...part.allowed, ...part.forbidden].every(bracesBalanced),
  { message: 'Uma zona tem chavetas que não fecham: confere os ficheiros que a parte pode tocar.' },
);

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
 * assembling/assembled: a montar e montada (a worktree da montagem existe; numa repartição, a
 * integrar e integrada) · closed: fechada.
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
 * (`outside`), o que ela tem já choca com o de outra pista (`collision`, com a pista `other`) ou
 * algo correu mal com uma parte (`problem`, com a frase em `detail`; `sessionId` é vazio se não
 * é de nenhuma pista). Um problema de uma parte nunca é um erro do motor.
 */
export const SplitWarning = z
  .object({
    sessionId: z.string(),
    kind: z.enum(['outside', 'collision', 'problem']),
    path: z.string(),
    other: z.string().optional(),
    detail: z.string().max(2_000).optional(),
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

/**
 * Quando uma pista arrancou e parou (milissegundos desde 1970), e a posição da parte no plano:
 * `index` é o índice dela e `after` o da parte de cuja entrega arrancou. Servem para integrar pela
 * ordem certa e para medir quanto demorou a mais lenta face à soma de todas.
 */
export const SplitLaneInfo = z
  .object({
    sessionId: z.string(),
    index: z.number().int().min(0),
    after: z.number().int().min(0).nullable(),
    startedAt: z.number(),
    settledAt: z.number().nullable(),
  })
  .strict();
export type SplitLaneInfo = z.infer<typeof SplitLaneInfo>;

/** O que só as repartições têm: as partes por arrancar, os avisos e o tempo de cada pista. */
export const RaceSplit = z
  .object({
    pending: z.array(SplitPending),
    warnings: z.array(SplitWarning),
    lanes: z.array(SplitLaneInfo).optional(),
  })
  .strict();
export type RaceSplit = z.infer<typeof RaceSplit>;

const IntegrationCheck = z.object({
  label: z.string(),
  state: z.enum(['passed', 'failed', 'timeout']),
  preexisting: z.boolean(),
});

/** Uma parte juntada ao resultado (ou que bateu num conflito), com as verificações desse passo. */
export const IntegrationStep = z.object({
  sessionId: z.string(),
  title: z.string(),
  merged: z.boolean(),
  /** Os ficheiros que entraram em conflito neste passo (resolvidos, se `merged`). */
  conflicts: z.array(z.string()),
  checks: z.array(IntegrationCheck),
  failures: z.number().int(),
});
export type IntegrationStep = z.infer<typeof IntegrationStep>;

/** O conflito que parou a integração: a parte, os ficheiros e a sessão que o está a resolver. */
export const IntegrationConflict = z.object({
  sessionId: z.string(),
  branch: z.string(),
  files: z.array(z.string()),
  resolver: z.string().nullable(),
});
export type IntegrationConflict = z.infer<typeof IntegrationConflict>;

/**
 * O que a integração mediu, sem estimativas inventadas: o custo é a soma do último custo de cada
 * pista, e o tempo compara a pista mais lenta com a soma de todas (o que levaria uma a seguir à
 * outra, não o que levaria um agente sozinho).
 */
export const IntegrationMetrics = z.object({
  costUsd: z.number().nullable(),
  slowestMs: z.number().int(),
  totalMs: z.number().int(),
  conflicts: z.number().int(),
  /** Verificações que falharam por culpa do resultado (as que já falhavam na base não contam). */
  failures: z.number().int(),
});
export type IntegrationMetrics = z.infer<typeof IntegrationMetrics>;

/**
 * A integração de uma repartição: as partes juntadas uma a uma numa worktree própria (a ponta),
 * com as verificações depois de cada uma, e no fim a revisão do diff todo.
 * merging: a juntar · conflict: parou num conflito · ready: pronta · brought: trazida.
 */
export const RaceIntegration = z.object({
  state: z.enum(['merging', 'conflict', 'ready', 'brought']),
  /** `base` é o commit de onde as pistas partiram (o diff integrado conta-se face a ele). */
  tip: z.object({ branch: z.string(), path: z.string(), top: z.string(), base: z.string() }),
  steps: z.array(IntegrationStep),
  conflict: IntegrationConflict.nullable(),
  /** As verificações todas, uma vez, depois da última parte. */
  final: z.object({ checks: z.array(IntegrationCheck), failures: z.number().int() }).nullable(),
  /** Os achados do revisor sobre o diff integrado; null se ainda não correu ou falhou. */
  review: z.array(Finding).nullable(),
  warnings: z.array(z.string()),
  metrics: IntegrationMetrics,
  brought: z.object({ into: z.string() }).nullable(),
});
export type RaceIntegration = z.infer<typeof RaceIntegration>;

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
  /** Só nas repartições: a integração das partes (assembling/assembled usam-se aqui também). */
  integration: RaceIntegration.nullable().optional(),
});
export type Race = z.infer<typeof Race>;

export const RaceStartPayload = z
  .object({
    projectId: z.string().min(1).max(64),
    text: z.string().min(1).max(200_000),
    lanes: z.array(RaceLaneSpec).min(2).max(4),
  })
  .strict();
