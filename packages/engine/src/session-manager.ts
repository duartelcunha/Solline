/**
 * Vai gerir todas as conversas vivas: um query() em streaming-input por sessão,
 * com fila própria para as mensagens seguintes. No M0 é só a forma; o M1 enche-o.
 */
export interface SessionSummary {
  id: string;
  cwd: string;
}

export class SessionManager {
  readonly #sessions = new Map<string, SessionSummary>();

  list(): SessionSummary[] {
    return [...this.#sessions.values()];
  }

  get size(): number {
    return this.#sessions.size;
  }

  async disposeAll(): Promise<void> {
    this.#sessions.clear();
  }
}
