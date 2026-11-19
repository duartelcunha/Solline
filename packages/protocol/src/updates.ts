import { z } from 'zod';

export const UpdateInstaller = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9._-]+\.exe$/),
    url: z.url({ protocol: /^https$/ }),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type UpdateInstaller = z.infer<typeof UpdateInstaller>;

export const UpdateCheckResult = z
  .object({
    status: z.enum(['up-to-date', 'available', 'unavailable']),
    currentVersion: z.string().min(1).max(64),
    latestVersion: z.string().min(1).max(64).nullable(),
    publishedAt: z.string().nullable(),
    releaseUrl: z.url({ protocol: /^https$/ }).nullable(),
    notes: z.string().max(4000),
    installer: UpdateInstaller.nullable(),
    checkedAt: z.number(),
    detail: z.string().max(400).optional(),
  })
  .strict();
export type UpdateCheckResult = z.infer<typeof UpdateCheckResult>;

export const UpdateInstallResult = z
  .object({
    started: z.boolean(),
    openedReleasePage: z.boolean().optional(),
    installerPath: z.string().optional(),
  })
  .strict();
export type UpdateInstallResult = z.infer<typeof UpdateInstallResult>;

export const updatesCommandSchemas = {
  /** Verifica lançamentos no GitHub apenas em modo de leitura (no main). */
  'app.checkUpdate': {
    payload: z.object({}).strict(),
    result: UpdateCheckResult,
  },
  /** Transfere o instalador (com SHA-256 verificado) ou abre a release após confirmação explícita. */
  'app.installUpdate': {
    payload: z.object({ version: z.string().min(1).max(64) }).strict(),
    result: UpdateInstallResult,
  },
} as const;
