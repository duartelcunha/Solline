/**
 * Segredos dos servidores MCP do catálogo. Os valores vivem só no cofre do sistema (no Windows, o
 * Gestor de Credenciais), geridos pelo main. Isto é a interface; a do Windows está no main e a de
 * memória serve os testes. Nunca passa por eventos, ficheiros nem registos.
 */
export interface SecretStore {
  /** O valor, ou null se não existe. */
  get(target: string): Promise<string | null>;
  /** Vários de uma vez (uma só ida ao cofre). */
  getMany(targets: readonly string[]): Promise<(string | null)[]>;
  set(target: string, value: string): Promise<void>;
  /** Apaga os que existirem; os que não existem são ignorados. */
  remove(targets: readonly string[]): Promise<void>;
}

/** O limite do Gestor de Credenciais é 2560 bytes por valor (1280 caracteres em UTF-16). */
export const SECRET_MAX_LENGTH = 1000;

const TARGET = /^Solline\/mcp\/[a-z0-9-]{1,32}\/[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** O nome do segredo no cofre: `Solline/mcp/<serverId>/<VARIÁVEL>`. */
export function mcpSecretTarget(serverId: string, name: string): string {
  const target = `Solline/mcp/${serverId}/${name}`;
  assertSecretTarget(target);
  return target;
}

/** Só alvos desta forma entram no cofre: nunca se lê nem se apaga outra coisa do utilizador. */
export function assertSecretTarget(target: string): void {
  if (!TARGET.test(target)) throw new Error('Nome de segredo inválido');
}

/** Cofre em memória, para os testes. */
export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(target: string): Promise<string | null> {
    assertSecretTarget(target);
    return this.values.get(target) ?? null;
  }
  async getMany(targets: readonly string[]): Promise<(string | null)[]> {
    return Promise.all(targets.map((t) => this.get(t)));
  }
  async set(target: string, value: string): Promise<void> {
    assertSecretTarget(target);
    this.values.set(target, value);
  }
  async remove(targets: readonly string[]): Promise<void> {
    for (const target of targets) {
      assertSecretTarget(target);
      this.values.delete(target);
    }
  }
}
