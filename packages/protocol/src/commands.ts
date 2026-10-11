import { z } from 'zod';

/**
 * Contrato dos comandos da Ponte: interface -> main -> motor.
 * Cada comando tem um payload e um resultado validados com zod nos dois lados.
 * M0 só tem os comandos de saúde do motor; as sessões chegam no M1.
 */

export const PingPayload = z.object({}).strict();
export const PingResult = z.object({
  pong: z.literal(true),
  engineVersion: z.string(),
  pid: z.number().int(),
  receivedAt: z.number(),
});

export const SdkCheckPayload = z.object({}).strict();
export const SdkCheckResult = z.object({
  model: z.string(),
  apiKeySource: z.string(),
  result: z.string(),
  /** true quando a volta acabou num erro da API (por exemplo sessão expirada). */
  isError: z.boolean(),
  totalCostUsd: z.number(),
  durationMs: z.number(),
  claudeExecutable: z.string().nullable(),
});

export const commandSchemas = {
  'engine.ping': { payload: PingPayload, result: PingResult },
  'engine.sdkCheck': { payload: SdkCheckPayload, result: SdkCheckResult },
} as const;

export type CommandName = keyof typeof commandSchemas;
export const commandNames = Object.keys(commandSchemas) as CommandName[];

export type CommandPayload<C extends CommandName> = z.infer<(typeof commandSchemas)[C]['payload']>;
export type CommandResult<C extends CommandName> = z.infer<(typeof commandSchemas)[C]['result']>;

export const CommandNameSchema = z.enum(commandNames as [CommandName, ...CommandName[]]);

/** Pedido que viaja pela MessagePort entre main e motor. */
export const RequestEnvelope = z.object({
  kind: z.literal('request'),
  id: z.string().min(1),
  command: CommandNameSchema,
  payload: z.unknown(),
});
export type RequestEnvelope = z.infer<typeof RequestEnvelope>;

export const ResponseEnvelope = z.discriminatedUnion('ok', [
  z.object({
    kind: z.literal('response'),
    id: z.string(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal('response'),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ message: z.string() }),
  }),
]);
export type ResponseEnvelope = z.infer<typeof ResponseEnvelope>;
