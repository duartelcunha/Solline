import type { PermissionAnswer } from '@solline/protocol';

export type BrokerOutcome = PermissionAnswer | { decision: 'cancelled'; reason: string };

interface Pending {
  resolve: (outcome: BrokerOutcome) => void;
  cleanup: () => void;
}

/**
 * Transforma um pedido do agente (canUseTool no Claude) numa pergunta à interface e
 * espera a resposta, o tempo que for: o Duarte pode estar a almoçar. Cancela quando o agente
 * desiste (signal) ou quando a sessão para (cancelAll).
 */
export class PermissionBroker {
  readonly #pending = new Map<string, Pending>();

  wait(id: string, signal?: AbortSignal): Promise<BrokerOutcome> {
    if (this.#pending.has(id)) return Promise.reject(new Error(`Pedido repetido: ${id}`));
    if (signal?.aborted) return Promise.resolve({ decision: 'cancelled', reason: 'aborted' });
    return new Promise<BrokerOutcome>((resolve) => {
      const onAbort = () => this.#settle(id, { decision: 'cancelled', reason: 'aborted' });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        resolve,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
    });
  }

  /** Devolve false se o pedido já não existir (respondido, cancelado ou desconhecido). */
  answer(id: string, answer: PermissionAnswer): boolean {
    return this.#settle(id, answer);
  }

  /** Cancela um pedido (por exemplo o agente resolveu-o sozinho). */
  cancel(id: string, reason: string): boolean {
    return this.#settle(id, { decision: 'cancelled', reason });
  }

  cancelAll(reason: string): string[] {
    const ids = [...this.#pending.keys()];
    for (const id of ids) this.#settle(id, { decision: 'cancelled', reason });
    return ids;
  }

  #settle(id: string, outcome: BrokerOutcome): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    this.#pending.delete(id);
    pending.cleanup();
    pending.resolve(outcome);
    return true;
  }
}
