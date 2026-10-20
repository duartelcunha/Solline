import type { AgentId } from '@solline/protocol';

/** Um login a decorrer: o endereço para o browser, o fim e como desistir. */
export interface LoginFlow {
  url: string;
  /** Código de dispositivo a mostrar (o browser pede-o). */
  code?: string;
  /** O agente aceita um código colado do browser (ver submit). */
  acceptsCode?: boolean;
  /** O agente já abriu o browser sozinho. */
  openedByAgent?: boolean;
  /** Passa ao agente o código que o browser mostrou. */
  submit?: ((code: string) => Promise<void>) | undefined;
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
  /** Logins a preparar (o agente ainda não deu o endereço), com o número do arranque. */
  readonly #starting = new Map<AgentId, number>();
  /** O número do último arranque (ou cancelamento) de cada agente: só esse vale. */
  readonly #latest = new Map<AgentId, number>();
  #generation = 0;
  #closed = false;
  readonly #onChange: (agent: AgentId, error?: string) => void;
  readonly #timeoutMs: number;

  constructor(options: { onChange: (agent: AgentId, error?: string) => void; timeoutMs?: number }) {
    this.#onChange = options.onChange;
    this.#timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  }

  pending(agent: AgentId): boolean {
    return this.#flows.has(agent) || this.#starting.has(agent);
  }

  /** O login a decorrer (para mostrar o código ou deixar colar um). */
  current(agent: AgentId): LoginFlow | undefined {
    return this.#flows.get(agent)?.flow;
  }

  async submit(agent: AgentId, code: string): Promise<void> {
    const flow = this.#flows.get(agent)?.flow;
    if (!flow?.submit) throw new Error('Não há nenhum login à espera de um código');
    await flow.submit(code);
  }

  async start(agent: AgentId, begin: () => Promise<LoginFlow>): Promise<LoginFlow> {
    if (this.#closed) throw new Error('O motor está a fechar');
    // Cada arranque tem um número, marcado já (sem esperar): se outro começar ou alguém
    // cancelar enquanto o agente prepara o login (até um minuto), este fecha o seu processo
    // em vez de ficar órfão.
    const generation = ++this.#generation;
    this.#latest.set(agent, generation);
    this.#starting.set(agent, generation);
    const previous = this.#flows.get(agent);
    const preparing = begin();
    preparing.catch(() => undefined);
    let flow: LoginFlow;
    try {
      if (previous) {
        this.#flows.delete(agent);
        clearTimeout(previous.timer);
        await previous.flow.cancel().catch(() => undefined);
        this.#onChange(agent);
      }
      flow = await preparing;
    } finally {
      if (this.#starting.get(agent) === generation) this.#starting.delete(agent);
    }
    if (this.#closed || this.#latest.get(agent) !== generation) {
      await flow.cancel();
      throw new Error('O login foi cancelado ou substituído por outro');
    }
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
    return flow;
  }

  /** Desiste sem avisar de erro (foste tu que cancelaste). */
  async cancel(agent: AgentId): Promise<void> {
    // Um arranque a meio deixa de valer: fecha o processo quando o agente responder.
    const wasStarting = this.#starting.delete(agent);
    this.#latest.set(agent, ++this.#generation);
    const entry = this.#flows.get(agent);
    if (!entry) {
      if (wasStarting) this.#onChange(agent);
      return;
    }
    this.#flows.delete(agent);
    clearTimeout(entry.timer);
    await entry.flow.cancel();
    this.#onChange(agent);
  }

  async cancelAll(): Promise<void> {
    this.#closed = true;
    const agents = new Set([...this.#flows.keys(), ...this.#starting.keys()]);
    await Promise.all([...agents].map((agent) => this.cancel(agent)));
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
