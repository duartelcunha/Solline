import { z } from 'zod';

/**
 * As verificações do projeto: no fim de cada turno que mude ficheiros, o motor corre os
 * comandos do projeto (tipos, lint, testes) e mostra verde ou vermelho. Correr um comando é
 * correr código do projeto, por isso só em projetos de confiança. A lista vive nas
 * definições da Solline, por projeto; mudar um comando pede confirmação nativa no main.
 */

export const CheckSpec = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,32}$/),
    label: z.string().min(1).max(24),
    command: z.string().min(1).max(300),
    enabled: z.boolean(),
  })
  .strict();
export type CheckSpec = z.infer<typeof CheckSpec>;

/** No máximo 6 verificações, sem ids repetidos. */
export const CheckList = z
  .array(CheckSpec)
  .max(6)
  .refine((list) => new Set(list.map((c) => c.id)).size === list.length, {
    message: 'Verificações repetidas',
  });

/** pending: à espera de vez · passed · failed · timeout: passou o limite de 3 minutos. */
export const CheckResult = z.object({
  id: z.string(),
  state: z.enum(['pending', 'running', 'passed', 'failed', 'timeout']),
  /** O fim da saída, sem cores, só quando falhou. */
  tail: z.string().nullable(),
  durationMs: z.number().nullable(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const Checks = z.object({
  /** O projeto é de confiança: sem ela, nada corre. */
  trusted: z.boolean(),
  /** A lista em uso: a que guardaste, ou a que a Solline encontrou no package.json. */
  specs: z.array(CheckSpec),
  /** true se a lista veio do package.json (ainda não a mudaste). */
  detected: z.boolean(),
  /** O turno verificado; null antes da primeira ronda ou depois de rebobinar. */
  turnId: z.string().nullable(),
  results: z.array(CheckResult),
});
export type Checks = z.infer<typeof Checks>;

const SessionRef = { sessionId: z.string().min(1) };

export const checksCommandSchemas = {
  'checks.get': { payload: z.object(SessionRef).strict(), result: Checks },
  /** Volta a correr as verificações agora. */
  'checks.run': { payload: z.object(SessionRef).strict(), result: Checks },
  /** Manda a falha de uma verificação ao agente da sessão como a próxima mensagem. */
  'checks.fix': {
    payload: z.object({ ...SessionRef, id: z.string().min(1).max(32) }).strict(),
    result: z.object({ turnId: z.string() }),
  },
} as const;
