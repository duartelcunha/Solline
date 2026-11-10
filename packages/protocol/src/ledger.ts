import { z } from 'zod';

/**
 * Um número que o agente reportou, ou null quando não reportou.
 * Null não é zero. Zero só aparece quando o agente disse zero.
 */
export const Reported = z.number().finite().nullable();
export type Reported = z.infer<typeof Reported>;

export const TokenSnapshot = z
  .object({
    freshInput: Reported,
    cachedInput: Reported,
    output: Reported,
    costUsd: Reported,
  })
  .strict();
export type TokenSnapshot = z.infer<typeof TokenSnapshot>;

export const LedgerKind = z.enum(['session', 'resume', 'subagent']);
export type LedgerKind = z.infer<typeof LedgerKind>;

export const LedgerExecution = z
  .object({
    id: z.string().min(1).max(80),
    kind: LedgerKind,
    model: z.string().nullable(),
    /** Último total acumulado que esta execução reportou. */
    last: TokenSnapshot,
    /** O que se atribui a esta execução. Null num campo: não dá para saber. */
    spent: TokenSnapshot,
  })
  .strict();
export type LedgerExecution = z.infer<typeof LedgerExecution>;

export const BudgetStop = z
  .object({
    reason: z.enum(['turns', 'attempts', 'time']),
    text: z.string().min(1).max(240),
  })
  .strict();
export type BudgetStop = z.infer<typeof BudgetStop>;

export const BudgetState = z
  .object({
    maxTurns: z.number().int().positive().nullable(),
    maxAttempts: z.number().int().positive().nullable(),
    maxMinutes: z.number().positive().nullable(),
    turns: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    startedAt: z.number().nullable(),
    stop: BudgetStop.nullable(),
  })
  .strict();
export type BudgetState = z.infer<typeof BudgetState>;

export const LedgerView = z
  .object({
    executions: z.array(LedgerExecution).max(40),
    /** Soma das execuções da sessão. Um subagente não entra. Null se faltar uma parcela. */
    total: TokenSnapshot,
    estimateUsd: Reported,
    /** Versão da tabela. `unpriced-…` quer dizer que não há preços fixados. */
    priceVersion: z.string().min(1).max(40),
    quota: z
      .object({
        status: z.literal('unknown'),
        reason: z.string().min(1).max(200),
      })
      .strict(),
    budget: BudgetState,
  })
  .strict();
export type LedgerView = z.infer<typeof LedgerView>;

export const BudgetLimits = z
  .object({
    maxTurns: z.number().int().positive().nullable(),
    maxAttempts: z.number().int().positive().nullable(),
    maxMinutes: z.number().positive().nullable(),
  })
  .strict();
export type BudgetLimits = z.infer<typeof BudgetLimits>;

const SessionRef = { sessionId: z.string().min(1).max(128) };

export const ledgerCommandSchemas = {
  'ledger.get': {
    payload: z.object(SessionRef).strict(),
    result: LedgerView,
  },
  'ledger.budget': {
    payload: z.object({ ...SessionRef, ...BudgetLimits.shape }).strict(),
    result: LedgerView,
  },
} as const;
