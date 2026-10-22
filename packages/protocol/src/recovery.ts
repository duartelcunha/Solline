import { z } from 'zod';
import { AgentCapabilities, PermissionAnswer, SessionInfo, Turn, Usage } from './conversation.ts';
import { Checks } from './checks.ts';
import { Quality } from './quality.ts';
import { Timeline, ReviewComment } from './review.ts';
import { Race, RaceLaneSpec } from './race.ts';

/** Human inspection only: an allowlist of intent, never an executable replay payload. */
export const RecoveryOperationDetails = z.object({
  itemId: z.string().optional(),
  ids: z.array(z.string()).optional(),
  path: z.string().optional(),
  hunkId: z.string().optional(),
  turnId: z.string().optional(),
  requestId: z.string().optional(),
  decision: z.string().optional(),
  answer: PermissionAnswer.optional(),
  action: z.string().optional(),
  worktree: z.string().optional(),
  dropQueue: z.boolean().optional(),
  files: z.boolean().optional(),
  conversation: z.boolean().optional(),
  comments: z.array(ReviewComment).optional(),
  note: z.string().optional(),
  agent: z.string().optional(),
  lanes: z.array(RaceLaneSpec).optional(),
  model: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  trusted: z.boolean().optional(),
  enabled: z.boolean().optional(),
  how: z.string().optional(),
});
export type RecoveryOperationDetails = z.infer<typeof RecoveryOperationDetails>;

export const RecoveryOperation = z
  .object({
    id: z.string(),
    command: z.string(),
    sessionId: z.string().optional(),
    raceId: z.string().optional(),
    projectId: z.string().optional(),
    text: z.string().optional(),
    details: RecoveryOperationDetails.optional(),
    state: z.enum(['prepared', 'completed', 'unknown']),
    at: z.number(),
  })
  .strict();
export type RecoveryOperation = z.infer<typeof RecoveryOperation>;

export const RecoverySession = z
  .object({
    session: SessionInfo,
    capabilities: AgentCapabilities.nullable(),
    turns: z.array(Turn),
    usage: Usage,
    queue: z.object({
      items: z.array(z.object({ id: z.string(), text: z.string() })),
      paused: z.boolean(),
    }),
    timeline: Timeline.nullable(),
    quality: Quality.nullable(),
    checks: Checks.nullable(),
    conflicts: z.object({ files: z.array(z.string()), into: z.string() }).nullable(),
    interrupted: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();
export type RecoverySession = z.infer<typeof RecoverySession>;

/** Subscribe first; discard buffered events at or below this sequence in this epoch. */
export const EngineSnapshot = z
  .object({
    version: z.literal(1),
    epoch: z.string(),
    sequence: z.number().int().nonnegative(),
    /** Optional only for historical records/fixture compatibility; live engines always emit it. */
    lifecycle: z.enum(['running', 'stopping', 'stopped']).optional(),
    sessions: z.array(RecoverySession),
    races: z.array(Race),
    operations: z.array(RecoveryOperation),
    durability: z.object({ status: z.enum(['saved', 'failed']), error: z.string().optional() }),
  })
  .strict();
export type EngineSnapshot = z.infer<typeof EngineSnapshot>;
