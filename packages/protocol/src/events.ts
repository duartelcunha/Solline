import { z } from 'zod';

/**
 * Eventos que o motor emite sem pedido (motor -> main -> interface).
 * M0 só anuncia que o motor arrancou; os eventos de sessão chegam no M1.
 */

export const EngineReadyEvent = z.object({
  kind: z.literal('event'),
  type: z.literal('engine.ready'),
  engineVersion: z.string(),
  pid: z.number().int(),
});

export const EngineEvent = z.discriminatedUnion('type', [EngineReadyEvent]);
export type EngineEvent = z.infer<typeof EngineEvent>;
