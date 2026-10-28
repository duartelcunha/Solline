import { randomUUID } from 'node:crypto';
import {
  HostResponse,
  mcpSecretTarget,
  type HostRequest,
  type SecretStore,
} from '@solline/protocol';

/**
 * Como o motor obtém os segredos de um servidor do catálogo: só no momento de arrancar a sonda ou
 * de entregar o servidor a uma sessão. Devolve o valor ou null (não existe). O motor nunca o
 * guarda, regista, mete em eventos, no diário, no snapshot nem em erros.
 */
export interface McpSecretReader {
  read(serverId: string, names: readonly string[]): Promise<Record<string, string | null>>;
}

/** Um leitor sobre um cofre local (testes, ou o motor a correr no mesmo processo que o cofre). */
export function secretReaderFrom(store: SecretStore): McpSecretReader {
  return {
    read: async (serverId, names) => {
      const values = await store.getMany(names.map((name) => mcpSecretTarget(serverId, name)));
      return Object.fromEntries(names.map((name, i) => [name, values[i] ?? null]));
    },
  };
}

/**
 * O lado do motor da ligação ao main (a mesma MessagePort): pede os segredos por um pedido do
 * motor ao main e espera pela resposta. O main só responde com o que ele próprio guardou.
 */
export class HostLink {
  readonly #send: (request: HostRequest) => void;
  readonly #timeoutMs: number;
  readonly #pending = new Map<
    string,
    { resolve: (values: Record<string, string | null>) => void; reject: (error: Error) => void }
  >();

  constructor(send: (request: HostRequest) => void, timeoutMs = 30_000) {
    this.#send = send;
    this.#timeoutMs = timeoutMs;
  }

  readonly secrets: McpSecretReader = {
    read: (serverId, names) =>
      names.length === 0
        ? Promise.resolve({})
        : new Promise((resolve, reject) => {
            const id = randomUUID();
            const timer = setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error('O cofre de segredos não respondeu a tempo'));
            }, this.#timeoutMs);
            this.#pending.set(id, {
              resolve: (values) => {
                clearTimeout(timer);
                resolve(values);
              },
              reject: (error) => {
                clearTimeout(timer);
                reject(error);
              },
            });
            try {
              this.#send({
                kind: 'host-request',
                id,
                op: 'mcp.secrets',
                serverId,
                names: [...names],
              });
            } catch (error) {
              clearTimeout(timer);
              this.#pending.delete(id);
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          }),
  };

  /** Consome uma resposta do main; devolve false se a mensagem não é uma. */
  handle(raw: unknown): boolean {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      (raw as { kind?: unknown }).kind !== 'host-response'
    )
      return false;
    const parsed = HostResponse.safeParse(raw);
    if (!parsed.success) return true;
    const waiting = this.#pending.get(parsed.data.id);
    if (!waiting) return true;
    this.#pending.delete(parsed.data.id);
    if (parsed.data.ok) waiting.resolve(parsed.data.values);
    else waiting.reject(new Error(parsed.data.error.message));
    return true;
  }
}
