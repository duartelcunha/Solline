import type {
  ConsultDecision,
  ConsultKind,
  ConsultOutcome,
  ConsultRequest,
  EngineEvent,
} from '@solline/protocol';

type Pending = {
  request: ConsultRequest;
  resolve: (outcome: ConsultOutcome) => void;
};

/**
 * Os pedidos de consulta e delegação à espera do utilizador, como os de permissão: cada um fica
 * pendente até haver resposta, ou até a sessão fechar ou o turno ser interrompido (cancelado).
 * "Permitir nesta sessão" vale só para o tipo (perguntar ou delegar) e só para essa sessão; o
 * motor reiniciar apaga tudo (o agente morreu com ele).
 */
export class ConsultApprovals {
  readonly #emit: (event: EngineEvent) => void;
  readonly #pending = new Map<string, Pending>();
  readonly #allowed = new Map<string, Set<ConsultKind>>();
  #closed = false;

  constructor(emit: (event: EngineEvent) => void) {
    this.#emit = emit;
  }

  /** Ainda não é para esperar por ninguém. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Os pedidos à espera agora, do mais antigo para o mais recente. */
  pending(): ConsultRequest[] {
    return [...this.#pending.values()].map((p) => structuredClone(p.request));
  }

  /**
   * Abre o pedido e espera pela decisão. Com "permitir nesta sessão" já dado para este tipo,
   * segue sem cartão. Nunca rejeita: o resultado é a decisão ou `cancelled`.
   */
  request(request: ConsultRequest): Promise<ConsultOutcome> {
    if (this.#closed) return Promise.resolve('cancelled');
    if (this.#allowed.get(request.sessionId)?.has(request.kind)) return Promise.resolve('allow');
    return new Promise<ConsultOutcome>((resolve) => {
      this.#pending.set(request.id, { request, resolve });
      this.#emit({
        kind: 'event',
        type: 'consult.request',
        sessionId: request.sessionId,
        request: structuredClone(request),
      });
    });
  }

  /** Lança se o pedido já não está à espera ou é de outra sessão. */
  answer(sessionId: string, requestId: string, decision: ConsultDecision): void {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.request.sessionId !== sessionId)
      throw new Error('Este pedido já não está à espera de resposta');
    if (decision === 'allowSession') {
      const kinds = this.#allowed.get(sessionId) ?? new Set<ConsultKind>();
      kinds.add(pending.request.kind);
      this.#allowed.set(sessionId, kinds);
    }
    this.#settle(requestId, decision);
  }

  /** O turno foi interrompido ou a sessão fechou: os pedidos dela deixam de valer. */
  cancelSession(sessionId: string): void {
    for (const [id, pending] of [...this.#pending])
      if (pending.request.sessionId === sessionId) this.#settle(id, 'cancelled');
  }

  /** A sessão fechou: nada do que permitiu fica a valer. */
  forget(sessionId: string): void {
    this.cancelSession(sessionId);
    this.#allowed.delete(sessionId);
  }

  /** O motor vai parar: cancela tudo e deixa de aceitar pedidos. */
  close(): void {
    this.#closed = true;
    for (const id of [...this.#pending.keys()]) this.#settle(id, 'cancelled');
    this.#allowed.clear();
  }

  #settle(id: string, outcome: ConsultOutcome): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    this.#emit({
      kind: 'event',
      type: 'consult.settled',
      sessionId: pending.request.sessionId,
      requestId: id,
      outcome,
    });
    pending.resolve(outcome);
  }
}
