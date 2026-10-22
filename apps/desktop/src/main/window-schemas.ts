import { z } from 'zod';
import { DiffScope, ReviewComment } from '@solline/protocol';

export const WindowActionSchema = z.enum(['minimize', 'toggle-maximize', 'close']);
const SavedDraft = z
  .object({
    text: z.string().max(1_000_000),
    pendingSend: z.string().max(1_000_000).nullable(),
    review: z
      .object({
        scope: DiffScope,
        comments: z.array(ReviewComment).max(10000),
        note: z.string().max(1_000_000),
        editing: ReviewComment.extend({ text: z.string().max(10_000) }).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const DraftUpdateSchema = SavedDraft.extend({
  sessionId: z.string().min(1).max(128),
}).strict();
export const UiRecoverySchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    drafts: z.record(z.string(), SavedDraft),
  })
  .strict();
