import { z } from 'zod';
import { EnvKeyName } from './conversation.ts';
import { McpServerId } from './mcp-catalog.ts';

/**
 * Pedidos do motor ao main, pela mesma MessagePort. O motor corre num processo à parte e o cofre
 * dos segredos é do main: o motor pede os valores de um servidor do catálogo só no momento de o
 * arrancar (a sonda ou a entrega a uma sessão) e nunca os guarda.
 */
export const HostRequest = z
  .object({
    kind: z.literal('host-request'),
    id: z.string().min(1).max(64),
    op: z.literal('mcp.secrets'),
    serverId: McpServerId,
    names: z.array(EnvKeyName).max(16),
  })
  .strict();
export type HostRequest = z.infer<typeof HostRequest>;

export const HostResponse = z.union([
  z
    .object({
      kind: z.literal('host-response'),
      id: z.string().min(1).max(64),
      ok: z.literal(true),
      /** Por nome: o valor, ou null se não existe. */
      values: z.record(EnvKeyName, z.string().nullable()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('host-response'),
      id: z.string().min(1).max(64),
      ok: z.literal(false),
      error: z.object({ message: z.string() }).strict(),
    })
    .strict(),
]);
export type HostResponse = z.infer<typeof HostResponse>;
