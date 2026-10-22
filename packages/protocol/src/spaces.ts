import { z } from 'zod';
import { AgentId } from './conversation.ts';
import { DiffStats } from './review.ts';

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
export const SpaceMemory = z
  .object({
    id: Id,
    projectId: SpaceRef,
    text: Text,
    source: Text,
    sourceId: Id.nullable(),
    state: z.enum(['pending', 'active', 'disabled']),
    createdAt: z.number(),
  })
  .strict();
export type SpaceMemory = z.infer<typeof SpaceMemory>;
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
    learningMode: z.enum(['approval', 'automatic']).default('approval'),
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
        state: z.enum(['pending', 'active', 'disabled']),
      })
      .strict(),
    result: SpacesState,
  },
  'spaces.memoryDelete': { payload: z.object({ id: Id }).strict(), result: SpacesState },
} as const;
