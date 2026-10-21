import { createServer } from 'node:net';

/**
 * Portas por sessão, como o Conductor: cada sessão recebe um bloco de 10 portas livres
 * (SOLLINE_PORT a +9), para dois servidores de dev nunca chocarem. Os blocos começam em 41000,
 * longe das portas habituais; cada porta é confirmada livre antes de se dar.
 */

export const BLOCK = 10;
const FIRST = 41_000;
const LAST = 60_000;

export type IsFree = (port: number) => Promise<boolean>;

/** A porta está livre em 127.0.0.1 (abre e fecha um servidor nela). */
export const portIsFree: IsFree = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });

export class PortAllocator {
  readonly #taken = new Map<string, number>();
  readonly #isFree: IsFree;

  constructor(options: { isFree?: IsFree } = {}) {
    this.#isFree = options.isFree ?? portIsFree;
  }

  /** O bloco da sessão (o mesmo se já tiver um). */
  async reserve(owner: string): Promise<number> {
    const existing = this.#taken.get(owner);
    if (existing !== undefined) return existing;
    const used = new Set(this.#taken.values());
    for (let base = FIRST; base + BLOCK <= LAST; base += BLOCK) {
      if (used.has(base)) continue;
      // Reservado logo, antes de esperar: duas sessões ao mesmo tempo não ficam com o mesmo bloco.
      this.#taken.set(owner, base);
      const free = await Promise.all(
        Array.from({ length: BLOCK }, (_, i) => this.#isFree(base + i)),
      );
      if (free.every(Boolean)) return base;
      this.#taken.delete(owner);
      used.add(base);
    }
    throw new Error('Não há portas livres para esta sessão');
  }

  release(owner: string): void {
    this.#taken.delete(owner);
  }

  /** As variáveis de ambiente do bloco. */
  static env(base: number): Record<string, string> {
    return { SOLLINE_PORT: String(base), SOLLINE_PORT_COUNT: String(BLOCK) };
  }
}
