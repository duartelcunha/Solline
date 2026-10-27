import { z } from 'zod';
import { EngineSnapshot, RecoverySession, SetupSpec } from '@solline/protocol';
import { CheckpointRecovery } from '../checkpoints/session-checkpoints.ts';

export const SavedSession = z
  .object({
    view: RecoverySession,
    trusted: z.boolean(),
    points: z.array(z.tuple([z.string(), z.string().nullable()])),
    context: z.string().optional(),
    /** O bloco das regras do projeto que ainda não seguiu (agentes sem canal de instruções). */
    intro: z.string().optional(),
    /** As regras com padrões que já seguiram inteiras nesta sessão. */
    rulesDelivered: z.array(z.string()).optional(),
    named: z.boolean(),
    worktree: z
      .object({
        path: z.string(),
        cwd: z.string(),
        branch: z.string(),
        base: z.string(),
        top: z.string(),
        projectId: z.string(),
        suffix: z.string(),
      })
      .optional(),
    checkpoints: CheckpointRecovery.nullable(),
  })
  .strict();
export type SavedSession = z.infer<typeof SavedSession>;
export const RecoveryState = z
  .object({
    snapshot: EngineSnapshot,
    sessions: z.array(SavedSession),
    setups: z.array(z.tuple([z.string(), SetupSpec.nullable()])),
  })
  .strict();
export type RecoveryState = z.infer<typeof RecoveryState>;
