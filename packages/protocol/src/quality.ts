import { z } from 'zod';

/**
 * Segunda opinião, igual para qualquer agente: no fim de cada turno que mude ficheiros, um
 * revisor com contexto limpo lê o diff do turno e deixa achados presos às linhas. A
 * interface só vê isto e pede ao agente da sessão para corrigir os que escolheres.
 */

/** bug: está errado · risk: pode partir ou é inseguro · slop: funciona mas é ruído. */
export const FindingSeverity = z.enum(['bug', 'risk', 'slop']);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const Finding = z.object({
  id: z.string(),
  path: z.string(),
  /** Linha na versão nova do ficheiro; null quando o achado é do ficheiro todo. */
  line: z.number().int().nullable(),
  severity: FindingSeverity,
  /** Uma frase curta. */
  title: z.string(),
  /** Porquê e o que fazer, em poucas linhas. */
  detail: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const QualityReview = z.object({
  /** idle: ainda nada revisto · running: a rever o turno · done · error */
  state: z.enum(['idle', 'running', 'done', 'error']),
  turnId: z.string().nullable(),
  findings: z.array(Finding),
  error: z.string().nullable(),
});
export type QualityReview = z.infer<typeof QualityReview>;

export const Quality = z.object({
  /** O revisor corre sozinho no fim de cada turno que mude ficheiros. */
  enabled: z.boolean(),
  review: QualityReview,
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
  /** Volta a rever o último turno agora (por exemplo depois de um erro). */
  'quality.review': { payload: z.object(SessionRef).strict(), result: Quality },
  /** Manda os achados escolhidos ao agente da sessão como a próxima mensagem. */
  'quality.fix': {
    payload: z
      .object({ ...SessionRef, ids: z.array(z.string().min(1).max(64)).min(1).max(30) })
      .strict(),
    result: z.object({ turnId: z.string() }),
  },
} as const;
