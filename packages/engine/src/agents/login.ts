import type { AgentId } from '@solline/protocol';

/** Um login a decorrer: o endereço para o browser, o fim e como desistir. */
export interface LoginFlow {
  url: string;
  /** Resolve quando o agente diz que entrou; rejeita se falhou ou foi cancelado. */
  done: Promise<void>;
  cancel(): Promise<void>;
}

/** Um login sem resposta ao fim disto é cancelado. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Os logins a decorrer, no máximo um por agente. Um novo pedido para o mesmo agente cancela o
 * anterior (fechaste o browser e voltaste a carregar). O fim, bom ou mau, avisa quem ouve.
 */
export class LoginManager {
  readonly #flows = new Map<AgentId, { flow: LoginFlow; timer: NodeJS.Timeout }>();
  readonly #onChange: (agent: AgentId, error?: string) => void;
  readonly #timeoutMs: number;

  constructor(options: { onChange: (agent: AgentId, error?: string) => void; timeoutMs?: number }) {
    this.#onChange = options.onChange;
    this.#timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  }

  pending(agent: AgentId): boolean {
    return this.#flows.has(agent);
  }

  async start(agent: AgentId, begin: () => Promise<LoginFlow>): Promise<string> {
    await this.cancel(agent);
    const flow = await begin();
    const timer = setTimeout(() => {
      if (this.#flows.get(agent)?.flow !== flow) return;
      this.#flows.delete(agent);
      void flow.cancel();
      this.#onChange(agent, 'O login expirou ao fim de 10 minutos. Tenta outra vez.');
    }, this.#timeoutMs);
    this.#flows.set(agent, { flow, timer });
    flow.done.then(
      () => this.#finish(agent, flow),
      (error: unknown) =>
        this.#finish(agent, flow, error instanceof Error ? error.message : String(error)),
    );
    return flow.url;
  }

  /** Desiste sem avisar de erro (foste tu que cancelaste). */
  async cancel(agent: AgentId): Promise<void> {
    const entry = this.#flows.get(agent);
    if (!entry) return;
    this.#flows.delete(agent);
    clearTimeout(entry.timer);
    await entry.flow.cancel();
    this.#onChange(agent);
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.#flows.keys()].map((agent) => this.cancel(agent)));
  }

  #finish(agent: AgentId, flow: LoginFlow, error?: string): void {
    const entry = this.#flows.get(agent);
    // Já foi cancelado ou expirou: quem o tirou já avisou.
    if (entry?.flow !== flow) return;
    this.#flows.delete(agent);
    clearTimeout(entry.timer);
    this.#onChange(agent, error);
  }
}
