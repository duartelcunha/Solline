import { z } from 'zod';
import { AgentId, TodoEntry } from './conversation.ts';
import { HandoffDraftedBy } from './handoff.ts';

/**
 * Estado canónico independente de adaptador. Separa de propósito o pedido real do utilizador
 * (`originalIntent`) do resumo escrito na passagem de testemunho (`handoffSummary`), para o
 * revisor nunca confundir a história do modelo anterior com a intenção original.
 */

export const TaskFileRef = z
  .object({
    path: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean().optional(),
  })
  .strict();
export type TaskFileRef = z.infer<typeof TaskFileRef>;

export const HandoffSummaryRef = z
  .object({
    text: z.string(),
    draftedBy: HandoffDraftedBy,
    sourceSessionId: z.string(),
    sourceAgent: AgentId,
  })
  .strict();
export type HandoffSummaryRef = z.infer<typeof HandoffSummaryRef>;

export const TaskVerificationState = z
  .object({
    state: z.enum(['unknown', 'passing', 'failing']),
    failedIds: z.array(z.string()),
    repairFixes: z.number().int().nonnegative(),
  })
  .strict();
export type TaskVerificationState = z.infer<typeof TaskVerificationState>;

export const CanonicalTaskState = z
  .object({
    version: z.literal(1),
    sessionId: z.string(),
    /** Intenção real do utilizador (nunca substituída por resumo escrito por LLM). */
    originalIntent: z.string(),
    /** Rascunho de passagem em quarentena (excluído do pedido entregue ao revisor). */
    handoffSummary: HandoffSummaryRef.optional(),
    /** Id do turno de abertura que levou o envelope de handoff (ignorado pelo revisor). */
    handoffTurnId: z.string().optional(),
    plan: z.array(TodoEntry),
    files: z.array(TaskFileRef),
    checkpointTurnIds: z.array(z.string()),
    decisions: z.array(z.string()),
    activeRuleIds: z.array(z.string()),
    usedMemoryIds: z.array(z.string()),
    verification: TaskVerificationState,
    updatedAt: z.number(),
  })
  .strict();
export type CanonicalTaskState = z.infer<typeof CanonicalTaskState>;

const SessionRef = z.object({ sessionId: z.string().min(1).max(128) }).strict();

export const taskStateCommandSchemas = {
  /** Pacote canónico de estado da tarefa desta sessão (só leitura). */
  'session.taskState': { payload: SessionRef, result: CanonicalTaskState },
} as const;
