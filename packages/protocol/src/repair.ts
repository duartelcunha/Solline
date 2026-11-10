import { z } from 'zod';

export const RepairState = z.enum(['off', 'watching', 'fixing', 'done', 'stopped']);
export type RepairState = z.infer<typeof RepairState>;

export const RepairView = z
  .object({
    enabled: z.boolean(),
    fixes: z.number().int().nonnegative(),
    equivalent: z.number().int().nonnegative(),
    state: RepairState,
    reason: z.string().nullable(),
    /** Turno em que as verificações passaram. Sem isto, não está feito. */
    proofTurnId: z.string().nullable(),
  })
  .strict();
export type RepairView = z.infer<typeof RepairView>;

const SessionRef = { sessionId: z.string().min(1).max(128) };

export const repairCommandSchemas = {
  'repair.set': {
    payload: z.object({ ...SessionRef, enabled: z.boolean() }).strict(),
    result: RepairView,
  },
  'repair.cancel': {
    payload: z.object(SessionRef).strict(),
    result: RepairView,
  },
} as const;
