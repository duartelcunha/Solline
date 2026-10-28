import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServerId, McpServerSpec } from '@solline/protocol';

/**
 * O que o motor guarda do catálogo, no diretório de dados da Solline. Nunca leva segredos: só o
 * comando, os argumentos, os nomes das variáveis (e o valor das que não são secretas), a
 * impressão aprovada e a impressão das ferramentas.
 */
const StoredTool = z
  .object({
    name: z.string().max(128),
    description: z.string().max(300),
    hash: z.string().length(64),
  })
  .strict();

const Pending = z
  .object({ tools: z.array(StoredTool).max(200), hash: z.string().length(64) })
  .strict();

export const StoredServer = z
  .object({
    id: McpServerId,
    name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    spec: McpServerSpec,
    /** A impressão do comando, argumentos e variáveis que o utilizador aprovou. */
    approvedFingerprint: z.string().length(64).nullable(),
    /** As ferramentas aprovadas. */
    tools: z.array(StoredTool).max(200).nullable(),
    toolsHash: z.string().length(64).nullable(),
    probedAt: z.number().nullable(),
    /** O que a sonda viu depois da aprovação, se mudou: espera nova aprovação. */
    pending: Pending.nullable(),
    createdAt: z.number(),
  })
  .strict();
export type StoredServer = z.infer<typeof StoredServer>;

export const StoredCatalog = z
  .object({
    version: z.literal(1),
    servers: z.array(StoredServer).max(100),
    projects: z.record(z.string().min(1).max(128), z.array(McpServerId).max(8)),
  })
  .strict();
export type StoredCatalog = z.infer<typeof StoredCatalog>;

export function emptyCatalog(): StoredCatalog {
  return { version: 1, servers: [], projects: {} };
}

/** O ficheiro do catálogo, ou memória quando não há pasta de dados (testes). */
export class CatalogFile {
  readonly #file: string | undefined;

  constructor(dataDir: string | undefined) {
    this.#file = dataDir ? path.join(dataDir, 'mcp-catalog.json') : undefined;
  }

  load(): StoredCatalog {
    if (!this.#file || !existsSync(this.#file)) return emptyCatalog();
    try {
      return StoredCatalog.parse(JSON.parse(readFileSync(this.#file, 'utf8')));
    } catch {
      // Ilegível: guarda-se ao lado (não se perde) e começa-se vazio.
      try {
        renameSync(this.#file, `${this.#file}.corrupt-${Date.now()}`);
      } catch {
        // Sem rasto: o próximo save escreve por cima.
      }
      return emptyCatalog();
    }
  }

  save(catalog: StoredCatalog): void {
    if (!this.#file) return;
    mkdirSync(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify(catalog, null, 2), 'utf8');
    renameSync(temp, this.#file);
  }
}
