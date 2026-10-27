import { z } from 'zod';

/**
 * Segunda opinião, igual para qualquer agente: no fim de cada turno que mude ficheiros, um
 * revisor com contexto limpo lê o diff do turno e deixa achados presos às linhas. A
 * interface só vê isto e pede ao agente da sessão para corrigir os que escolheres.
 */

/** bug: está errado · risk: pode partir ou é inseguro · slop: funciona mas é ruído. */
export const FindingSeverity = z.enum(['bug', 'risk', 'slop']);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

/** 0 é o mais grave, 3 o menos. */
export const FindingPriority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type FindingPriority = z.infer<typeof FindingPriority>;

/** open: por tratar · fixed: pediste ao agente para corrigir · dismissed: descartado por ti. */
export const FindingStatus = z.enum(['open', 'fixed', 'dismissed']);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const Finding = z.object({
  id: z.string(),
  path: z.string(),
  /** Linha na versão nova do ficheiro; null quando o achado é do ficheiro todo. */
  line: z.number().int().nullable(),
  severity: FindingSeverity,
  /** Os valores por omissão deixam ler o que foi gravado antes de existirem. */
  priority: FindingPriority.default(2),
  /** Quão seguro está o revisor, de 0 a 1. */
  confidence: z.number().min(0).max(1).default(0.5),
  status: FindingStatus.default('open'),
  /** Uma frase curta. */
  title: z.string(),
  /** Porquê e o que fazer, em poucas linhas. */
  detail: z.string(),
});
export type Finding = z.infer<typeof Finding>;

/** Quem reviu: o fornecedor do agente revisor e se é o mesmo do agente que escreveu. */
export const ReviewerInfo = z.object({
  vendor: z.string(),
  model: z.string().optional(),
  sameVendor: z.boolean(),
});
export type ReviewerInfo = z.infer<typeof ReviewerInfo>;

/** turn: no fim de um turno · bring: antes de trazer para o projeto · manual: pediste tu. */
export const ReviewTrigger = z.enum(['turn', 'bring', 'manual']);
export type ReviewTrigger = z.infer<typeof ReviewTrigger>;

/** Em que se baseia a revisão: o último turno, ou tudo o que a sessão mudou. */
export const ReviewScope = z.enum(['turn', 'session']);
export type ReviewScope = z.infer<typeof ReviewScope>;

export const QualityReview = z.object({
  /** idle: ainda nada revisto · running: a rever o turno · done · error */
  state: z.enum(['idle', 'running', 'done', 'error']),
  turnId: z.string().nullable(),
  findings: z.array(Finding),
  error: z.string().nullable(),
  reviewer: ReviewerInfo.optional(),
  trigger: ReviewTrigger.optional(),
});
export type QualityReview = z.infer<typeof QualityReview>;

/** Contadores da sessão: achados dados, corrigidos e descartados desde que abriu. */
export const QualityStats = z.object({
  fixed: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type QualityStats = z.infer<typeof QualityStats>;

export const Quality = z.object({
  /** Há revisor neste motor (nos testes isolados não há). */
  available: z.boolean(),
  /** O revisor corre sozinho no fim de cada turno que mude ficheiros. */
  enabled: z.boolean(),
  review: QualityReview,
  stats: QualityStats.default({ fixed: 0, dismissed: 0, total: 0 }),
});
export type Quality = z.infer<typeof Quality>;

const SessionRef = { sessionId: z.string().min(1) };

export const qualityCommandSchemas = {
  'quality.get': { payload: z.object(SessionRef).strict(), result: Quality },
  /** Liga ou desliga o revisor nesta sessão. */
  'quality.setEnabled': {
    payload: z.object({ ...SessionRef, enabled: z.boolean() }).strict(),
    result: Quality,
  },
  /**
   * Revê agora (por exemplo depois de um erro): por omissão o último turno a pedido do utilizador;
   * scope 'session' revê tudo o que a sessão mudou (é o que "trazer" usa).
   */
  'quality.review': {
    payload: z
      .object({ ...SessionRef, trigger: ReviewTrigger.optional(), scope: ReviewScope.optional() })
      .strict(),
    result: Quality,
  },
  /** Manda os achados escolhidos ao agente da sessão como a próxima mensagem e marca-os como corrigidos. */
  'quality.fix': {
    payload: z
      .object({ ...SessionRef, ids: z.array(z.string().min(1).max(64)).min(1).max(30) })
      .strict(),
    result: z.object({ turnId: z.string() }),
  },
  /** Descarta achados: ficam marcados e a interface deixa de os mostrar. */
  'quality.dismiss': {
    payload: z
      .object({ ...SessionRef, ids: z.array(z.string().min(1).max(64)).min(1).max(30) })
      .strict(),
    result: Quality,
  },
} as const;

/** No máximo tantos achados à vista; o resto fica dobrado. */
export const MAX_SHOWN_FINDINGS = 5;
/** Abaixo desta confiança um achado fica dobrado. */
export const MIN_SHOWN_CONFIDENCE = 0.7;

/**
 * O que se mostra por omissão: só erros e riscos com confiança de 0,7 para cima, no máximo 5,
 * dos mais graves (prioridade) para os menos, e a seguir os mais seguros. O resto (ruído,
 * dúvidas, excesso) fica dobrado. Sem achados é um bom resultado. Descartados nunca se mostram.
 */
export function rankFindings<
  T extends Pick<Finding, 'severity' | 'priority' | 'confidence'> & { status?: FindingStatus },
>(findings: readonly T[]): { shown: T[]; folded: T[] } {
  const open = findings.filter((f) => (f.status ?? 'open') !== 'dismissed');
  const strong = open
    .filter((f) => f.severity !== 'slop' && f.confidence >= MIN_SHOWN_CONFIDENCE)
    .sort((a, b) => a.priority - b.priority || b.confidence - a.confidence);
  const shown = strong.slice(0, MAX_SHOWN_FINDINGS);
  const kept = new Set<T>(shown);
  return { shown, folded: open.filter((f) => !kept.has(f)) };
}
