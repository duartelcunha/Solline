import { z } from 'zod';
import { AgentId } from './conversation.ts';
import { DiffStats } from './review.ts';
import { ProjectRulesView } from './rules.ts';

const Id = z.string().min(1).max(128);
const Text = z.string().trim().min(1).max(20_000);
export const SpaceRef = z.string().min(1).max(128).nullable();
export const TaskAttempt = z
  .object({
    id: Id,
    sessionId: Id.nullable(),
    turnId: Id,
    text: z.string().min(1).max(200_000),
    state: z.enum(['prepared', 'queued', 'running', 'review', 'failed', 'unknown']),
    at: z.number(),
    error: z.string().nullable(),
    result: z.string().max(20_000).optional(),
    conversation: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(20_000) }))
      .max(50)
      .optional(),
    changes: DiffStats.optional(),
  })
  .strict();
export const SpaceTask = z
  .object({
    id: Id,
    projectId: SpaceRef,
    title: z.string().trim().min(1).max(300),
    description: z.string().max(20_000),
    status: z.enum(['todo', 'active', 'review', 'done']),
    attempts: z.array(TaskAttempt),
    sourceId: Id.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type SpaceTask = z.infer<typeof SpaceTask>;
/** Os limites do que um agente propõe (o utilizador pode editar até MEMORY_EDIT_TEXT). */
export const MEMORY_MAX_TEXT = 500;
export const MEMORY_MAX_REASON = 300;
export const MEMORY_EDIT_TEXT = 2_000;
export const MEMORY_MAX_CITATIONS = 5;

/**
 * A prova de uma memória: um intervalo de linhas (ou o ficheiro todo) dentro do projeto, ou um
 * commit. Sem caminhos absolutos nem `..`: quem aceita valida-o contra a pasta do projeto.
 */
export const MemoryCitation = z.union([
  z
    .object({
      path: z.string().trim().min(1).max(500),
      line: z.number().int().min(1).max(10_000_000).optional(),
      endLine: z.number().int().min(1).max(10_000_000).optional(),
    })
    .strict()
    .refine((c) => c.endLine === undefined || (c.line !== undefined && c.endLine >= c.line), {
      message: 'endLine pede line e não pode ser menor',
    }),
  z
    .object({
      commit: z
        .string()
        .trim()
        .regex(/^[0-9a-f]{7,40}$/i),
    })
    .strict(),
]);
export type MemoryCitation = z.infer<typeof MemoryCitation>;

/** O que o intervalo citado tinha quando o utilizador aprovou (hash do conteúdo, nunca o texto). */
export const MemoryEvidence = z
  .object({
    path: z.string().max(500),
    line: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    hash: z.string().length(64),
  })
  .strict();
export type MemoryEvidence = z.infer<typeof MemoryEvidence>;

/** Quem propôs: o agente, a sessão e o turno (e o projeto onde a prova mora). */
export const MemoryOrigin = z
  .object({
    agent: AgentId,
    sessionId: Id,
    turnId: Id.optional(),
    projectId: Id.optional(),
  })
  .strict();
export type MemoryOrigin = z.infer<typeof MemoryOrigin>;

/**
 * pending: à espera de aprovação (nunca chega aos agentes) · active: aprovada · disabled: desligada
 * · toConfirm: aprovada mas a prova mudou ou ficou 28 dias sem uso (não entra no índice).
 */
export const MemoryState = z.enum(['pending', 'active', 'disabled', 'toConfirm']);
export type MemoryState = z.infer<typeof MemoryState>;

export const SpaceMemory = z
  .object({
    id: Id,
    projectId: SpaceRef,
    text: Text,
    source: Text,
    sourceId: Id.nullable(),
    state: MemoryState,
    createdAt: z.number(),
    /** "Porque isto importa" (o agente escreve-o ao propor). */
    reason: z.string().max(MEMORY_MAX_REASON).default(''),
    citations: z.array(MemoryCitation).max(MEMORY_MAX_CITATIONS).default([]),
    /** Null: escrita pelo utilizador ou pela análise da Solline. */
    origin: MemoryOrigin.nullable().default(null),
    /** O turno que a propôs leu páginas da web ou resultados de servidores de terceiros. */
    external: z.boolean().default(false),
    approvedAt: z.number().nullable().default(null),
    /** Só uma leitura ou procura de um agente conta como uso. */
    lastUsedAt: z.number().nullable().default(null),
    evidence: z.array(MemoryEvidence).max(MEMORY_MAX_CITATIONS).default([]),
    /** Porque está "a confirmar" (só com state toConfirm). */
    stale: z.enum(['evidence', 'age']).nullable().default(null),
  })
  .strict();
export type SpaceMemory = z.infer<typeof SpaceMemory>;
/** Uma memória nova: só os campos de sempre; o resto leva os valores por omissão. */
export function blankMemory(
  fields: Pick<SpaceMemory, 'id' | 'projectId' | 'text' | 'source' | 'sourceId' | 'state'> &
    Partial<SpaceMemory> & { createdAt: number },
): SpaceMemory {
  return SpaceMemory.parse(fields);
}
export const SpaceInsight = z
  .object({
    id: Id,
    projectId: SpaceRef,
    title: z.string().min(1).max(300),
    detail: Text,
    sources: z.array(z.string().max(500)).max(20),
    fingerprint: Id,
    state: z.enum(['suggested', 'accepted', 'dismissed']),
    createdAt: z.number(),
    evidence: z
      .array(z.object({ id: z.string(), text: z.string().max(4000) }))
      .max(10)
      .optional(),
  })
  .strict();
export const SpaceSettings = z
  .object({
    analysisMode: z.enum(['manual', 'proactive']).default('manual'),
    // 'automatic' já não existe: nada chega aos agentes sem aprovação. Estados guardados migram.
    learningMode: z
      .enum(['approval', 'automatic'])
      .default('approval')
      .transform(() => 'approval' as const),
    projectIds: z.array(Id).max(100).default([]),
    agent: AgentId.nullable().default(null),
    model: z.string().max(200).default(''),
  })
  .strict();
export type SpaceSettings = z.infer<typeof SpaceSettings>;
export const SpacesState = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    tasks: z.array(SpaceTask),
    memories: z.array(SpaceMemory),
    insights: z.array(SpaceInsight),
    settings: SpaceSettings,
    forgotten: z.array(z.string()).default([]),
    analysis: z
      .object({
        state: z.enum(['idle', 'running', 'paused']),
        error: z.string().nullable(),
        lastAt: z.number().nullable(),
        fingerprint: z.string(),
        files: z.record(z.string(), z.string()),
      })
      .strict(),
  })
  .strict();
export type SpacesState = z.infer<typeof SpacesState>;
export function emptySpaces(): SpacesState {
  return {
    version: 1,
    revision: 0,
    tasks: [],
    memories: [],
    insights: [],
    forgotten: [],
    settings: SpaceSettings.parse({}),
    analysis: { state: 'idle', error: null, lastAt: null, fingerprint: '', files: {} },
  };
}
export const TaskTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), sessionId: Id }).strict(),
  z
    .object({ kind: z.literal('new'), agent: AgentId, model: z.string().max(200).optional() })
    .strict(),
]);
export const DelegateTask = z
  .object({
    id: Id,
    requestId: z.uuid(),
    target: TaskTarget,
    text: Text,
    memoryIds: z.array(Id).max(100),
  })
  .strict();
export const spacesCommandSchemas = {
  'spaces.snapshot': { payload: z.object({}).strict(), result: SpacesState },
  'spaces.taskCreate': {
    payload: z
      .object({
        projectId: SpaceRef,
        title: z.string().trim().min(1).max(300),
        description: z.string().max(20_000).default(''),
      })
      .strict(),
    result: SpaceTask,
  },
  'spaces.taskUpdate': {
    payload: z
      .object({
        id: Id,
        title: z.string().trim().min(1).max(300).optional(),
        description: z.string().max(20_000).optional(),
        status: z.enum(['todo', 'done']).optional(),
      })
      .strict(),
    result: SpaceTask,
  },
  'spaces.delegate': { payload: DelegateTask, result: SpaceTask },
  'spaces.configure': { payload: SpaceSettings, result: SpacesState },
  'spaces.analyze': { payload: z.object({}).strict(), result: SpacesState },
  'spaces.tick': { payload: z.object({}).strict(), result: SpacesState },
  'spaces.insightDecision': {
    payload: z.object({ id: Id, decision: z.enum(['accept', 'dismiss']) }).strict(),
    result: SpacesState,
  },
  'spaces.memorySave': {
    payload: z
      .object({
        id: Id.optional(),
        projectId: SpaceRef,
        text: Text,
        source: Text,
        sourceId: Id.nullable().default(null),
        state: MemoryState,
      })
      .strict(),
    result: SpacesState,
  },
  'spaces.memoryDelete': { payload: z.object({ id: Id }).strict(), result: SpacesState },
} as const;

const Ids = z.array(Id).min(1).max(100);
export const memoryCommandSchemas = {
  /**
   * Aprova propostas (ou re-aprova). `scope: 'global'` é uma decisão do utilizador, nunca de um
   * agente. `edits` altera o texto ou o motivo antes de aprovar, por id.
   */
  'memory.approve': {
    payload: z
      .object({
        ids: Ids,
        scope: z.enum(['project', 'global']).optional(),
        edits: z
          .record(
            Id,
            z
              .object({
                text: z.string().trim().min(1).max(MEMORY_EDIT_TEXT).optional(),
                reason: z.string().trim().max(MEMORY_MAX_REASON).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    result: SpacesState,
  },
  /** Rejeita propostas: apagam-se e o resumo fica em "esquecidas" para não voltarem. */
  'memory.reject': { payload: z.object({ ids: Ids }).strict(), result: SpacesState },
  /** Re-aprova memórias "a confirmar": renova a prova e o relógio. */
  'memory.confirm': { payload: z.object({ ids: Ids }).strict(), result: SpacesState },
  /**
   * "Exportar para regras": faz de uma memória aprovada uma regra do projeto e desliga a memória.
   * Uma memória geral precisa de `projectId` para dizer a que projeto vai a regra.
   */
  'memory.toRule': {
    payload: z.object({ id: Id, projectId: Id.optional() }).strict(),
    result: ProjectRulesView,
  },
} as const;
