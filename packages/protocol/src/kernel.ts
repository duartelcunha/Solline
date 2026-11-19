import { z } from 'zod';

/**
 * Contratos do microkernel interno e dos circuit breakers nas fronteiras externas.
 * Só módulos internos revistos entram aqui; nunca se carrega código externo em runtime.
 */

export const ModuleId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/);
export type ModuleId = z.infer<typeof ModuleId>;

export const ModuleState = z.enum([
  'registered',
  'initialized',
  'running',
  'degraded',
  'disabled',
  'stopped',
]);
export type ModuleState = z.infer<typeof ModuleState>;

export const CircuitState = z.enum(['closed', 'open', 'half-open']);
export type CircuitState = z.infer<typeof CircuitState>;

export const CircuitSnapshot = z
  .object({
    id: z.string(),
    state: CircuitState,
    failures: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    openedAt: z.number().nullable(),
    nextAttemptAt: z.number().nullable(),
  })
  .strict();
export type CircuitSnapshot = z.infer<typeof CircuitSnapshot>;

export const ModuleManifest = z
  .object({
    id: ModuleId,
    version: z.string().min(1).max(32),
    dependsOn: z.array(ModuleId).default([]),
    commands: z.array(z.string()).default([]),
    events: z.array(z.string()).default([]),
    critical: z.boolean().default(true),
    toggleable: z.boolean().default(false),
  })
  .strict();
export type ModuleManifest = z.input<typeof ModuleManifest>;
export type ResolvedModuleManifest = z.output<typeof ModuleManifest>;

export const ModuleHealth = z
  .object({
    id: ModuleId,
    version: z.string(),
    state: ModuleState,
    critical: z.boolean(),
    toggleable: z.boolean(),
    lastError: z.string().nullable(),
    updatedAt: z.number(),
  })
  .strict();
export type ModuleHealth = z.infer<typeof ModuleHealth>;

export const KernelHealthSnapshot = z
  .object({
    modules: z.array(ModuleHealth),
    circuits: z.array(CircuitSnapshot),
  })
  .strict();
export type KernelHealthSnapshot = z.infer<typeof KernelHealthSnapshot>;

const Empty = z.object({}).strict();

export const kernelCommandSchemas = {
  /** Estado dos módulos do microkernel e dos circuit breakers nas fronteiras externas. */
  'engine.health': { payload: Empty, result: KernelHealthSnapshot },
} as const;

export const kernelInternalSchemas = {
  /** Liga ou desliga um módulo interno não crítico e marcado como toggleable. */
  'engine.moduleToggle': {
    payload: z.object({ id: ModuleId, enabled: z.boolean() }).strict(),
    result: ModuleHealth,
  },
} as const;
