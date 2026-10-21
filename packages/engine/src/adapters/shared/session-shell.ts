import type { AskBlock, PermissionAnswer } from '@solline/protocol';
import { PermissionBroker, type BrokerOutcome } from '../../permission-broker.ts';
import type { AdapterSink } from '../types.ts';

/**
 * A casca de uma sessão de agente, igual para todos os transportes: o ciclo de cada pedido
 * (abrir, esperar pela resposta, fechar com o estado certo), a validação da resposta, as
 * quedas e o estado da sessão que daí resulta. É a única que chama sink.state; cada
 * adapter só lhe diz o que aconteceu e traduz o seu transporte.
 */

interface Ask<Extra> {
  turnId: string;
  block: AskBlock;
  /** O que o adapter precisa para responder ao agente (id do RPC, opções, sugestões). */
  extra: Extra;
}

export function statusFor(outcome: BrokerOutcome): AskBlock['status'] {
  switch (outcome.decision) {
    case 'allow-once':
    case 'answer':
      return 'allowed';
    case 'allow-always':
      return 'allowed-always';
    case 'deny':
      return 'denied';
    case 'deny-always':
      return 'denied-always';
    case 'cancelled':
      return 'cancelled';
  }
}

/** A resposta tem de caber no pedido: o bloco é a única verdade sobre o que aceita. */
export function checkAnswer(block: AskBlock, answer: PermissionAnswer): void {
  if (
    answer.decision === 'allow-always' &&
    !(block.kind === 'permission' && block.canAlwaysAllow)
  ) {
    throw new Error('Este pedido não aceita "Permitir sempre"');
  }
  if (
    answer.decision === 'deny-always' &&
    !(block.kind === 'permission' && block.canAlwaysDeny === true)
  ) {
    throw new Error('Este pedido não aceita "Negar sempre"');
  }
  if (answer.decision === 'answer' && block.kind !== 'question') {
    throw new Error('Este pedido não é uma pergunta');
  }
}

export class SessionShell<Extra = undefined> {
  readonly #sink: AdapterSink;
  readonly #broker = new PermissionBroker();
  readonly #asks = new Map<string, Ask<Extra>>();
  #running = false;
  #closing = false;
  #crashed = false;

  constructor(sink: AdapterSink) {
    this.#sink = sink;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Caiu: não aceita mais nada até ser retomada noutro adapter. */
  get crashed(): boolean {
    return this.#crashed;
  }

  /** A fechar por vontade de quem a abriu (uma queda a meio já não conta). */
  get closing(): boolean {
    return this.#closing;
  }

  /** O agente está a arrancar. */
  starting(): void {
    this.#sink.state('starting');
  }

  /** O agente arrancou e espera pela primeira mensagem. */
  ready(): void {
    this.#sink.state('idle');
  }

  turnStarted(): void {
    this.#running = true;
    this.#sink.state('running');
  }

  /**
   * O agente acabou o turno. Com cancelAsks, os pedidos ainda abertos deixam de valer (o
   * agente já não espera por eles).
   */
  turnEnded(options: { cancelAsks?: boolean } = {}): void {
    if (options.cancelAsks) this.#broker.cancelAll('turn ended');
    this.#running = false;
    if (this.#asks.size === 0 && !this.#crashed) this.#sink.state('idle');
  }

  /**
   * Abre um pedido e espera pela resposta. Quando chega, o bloco fica com o estado final na
   * conversa e a sessão volta a "precisa de ti", "a trabalhar" ou "parada".
   */
  async ask(
    turnId: string,
    block: AskBlock,
    extra: Extra,
    signal?: AbortSignal,
  ): Promise<BrokerOutcome> {
    this.#asks.set(block.id, { turnId, block, extra });
    this.#sink.ask(turnId, block);
    this.#sink.state('needs-you');
    const outcome = await this.#broker.wait(block.id, signal);
    this.#asks.delete(block.id);
    const status = statusFor(outcome);
    const resolved: AskBlock =
      block.kind === 'question' && outcome.decision === 'answer'
        ? { ...block, status, answers: outcome.answers }
        : { ...block, status };
    this.#sink.delta({ type: 'block.upsert', turnId, block: resolved });
    if (!this.#crashed) {
      this.#sink.state(this.#asks.size > 0 ? 'needs-you' : this.#running ? 'running' : 'idle');
    }
    return outcome;
  }

  /** Responde a um pedido aberto; false se já não existir. Lança se a resposta não couber. */
  answer(requestId: string, answer: PermissionAnswer): boolean {
    const ask = this.#asks.get(requestId);
    if (!ask) return false;
    checkAnswer(ask.block, answer);
    return this.#broker.answer(requestId, answer);
  }

  /** Cancela os pedidos que o agente resolveu sozinho (ex.: o Codex mudou de ideias). */
  cancelWhere(match: (extra: Extra) => boolean, reason: string): void {
    for (const [id, ask] of this.#asks) if (match(ask.extra)) this.#broker.cancel(id, reason);
  }

  /** O utilizador interrompeu: nenhum pedido aberto vale mais. */
  interrupted(): void {
    this.#broker.cancelAll('interrupt');
  }

  /**
   * O agente caiu. Devolve false se já tinha caído ou se estava a fechar (aí não é queda).
   */
  crash(message: string): boolean {
    if (this.#crashed || this.#closing) return false;
    this.#crashed = true;
    this.#running = false;
    this.#broker.cancelAll('crashed');
    this.#sink.state('error', message);
    return true;
  }

  /** A sessão vai fechar: os pedidos abertos deixam de valer e uma queda daqui para a frente não conta. */
  close(): void {
    this.#closing = true;
    this.#broker.cancelAll('closed');
  }
}
