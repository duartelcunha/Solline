import { z } from 'zod';

/** Não há aprovação. Falhar ou discordar é inconclusivo. */
export const ShadowVerdict = z.enum(['recommend', 'inconclusive', 'unavailable']);
export type ShadowVerdict = z.infer<typeof ShadowVerdict>;

export const ShadowFinding = z
  .object({
    path: z.string().min(1).max(300),
    line: z.number().int().positive().nullable(),
    /** Frase que aponta para o diff ou para o resultado da verificação. */
    proof: z.string().min(1).max(500),
    title: z.string().min(1).max(200),
  })
  .strict();
export type ShadowFinding = z.infer<typeof ShadowFinding>;

export const ShadowAdvice = z
  .object({
    verdict: ShadowVerdict,
    reason: z.string().min(1).max(400),
    findings: z.array(ShadowFinding).max(8),
    /** O juiz não autoriza push, merge nem apagar. */
    canAuthorize: z.literal(false),
  })
  .strict();
export type ShadowAdvice = z.infer<typeof ShadowAdvice>;

export const shadowCommandSchemas = {
  'shadow.ask': {
    payload: z.object({ sessionId: z.string().min(1).max(128) }).strict(),
    result: ShadowAdvice,
  },
} as const;
