import type { SessionQueue } from '@solline/protocol';

/**
 * O dono do turno de uma sessão: um turno de cada vez, a fila do que escreves enquanto o
 * agente trabalha, guiar a meio onde o agente aceita, e as ações que não podem coincidir com
 * um turno (rebobinar, desfazer, trazer). O SessionManager diz-lhe quando o agente parou;
 * entre itens da fila a sessão não chega a ficar "parada".
 */

export type How = 'queue' | 'now';
export type Submitted = { turnId: string; how: 'sent' | 'queued' | 'steered' };

interface Item {
  id: string;
  text: string;
}

export class SessionTurns {
  readonly #start: (text: string) => Promise<string>;
  readonly #steer: ((text: string, id: string) => Promise<'joined' | 'too-late'>) | undefined;
  readonly #running: () => boolean;
  readonly #emit: (queue: SessionQueue) => void;
  readonly #failed: (error: unknown) => void;
  #items: Item[] = [];
  #paused = false;
  #busy = false;
  /** A preparar a worktree: tudo o que escreves espera na fila. */
  #held = false;

  constructor(options: {
    /** Abre um turno com esta mensagem (checkpoint, ponto de rebobinar, envio ao agente). */
    start: (text: string) => Promise<string>;
    steer?: ((text: string, id: string) => Promise<'joined' | 'too-late'>) | undefined;
    /** O agente está a meio de um turno (a trabalhar ou à espera de ti). */
    running: () => boolean;
    emit: (queue: SessionQueue) => void;
    /** Um item da fila não conseguiu seguir (a sessão caiu, por exemplo). */
    failed?: (error: unknown) => void;
  }) {
    this.#start = options.start;
    this.#steer = options.steer;
    this.#running = options.running;
    this.#emit = options.emit;
    this.#failed = options.failed ?? (() => undefined);
  }

  /** Algo está a meio: um envio, uma ação exclusiva ou um turno do agente. */
  get busy(): boolean {
    return this.#busy || this.#running();
  }

  get queue(): SessionQueue {
    return { items: this.#items.map((i) => ({ ...i })), paused: this.#paused };
  }

  /** Restore data only. In particular, an empty paused queue cannot send a fresh turn. */
  restore(queue: SessionQueue): void {
    this.#items = queue.items.map((item) => ({ ...item }));
    this.#paused = true;
    this.#held = true;
  }

  /**
   * Manda uma mensagem. Parado e sem fila, segue logo. Ocupado: 'now' guia o turno se o agente
   * aceitar; senão (ou se já for tarde) vai para o fim da fila. Nunca se perde.
   */
  async submit(text: string, how: How = 'queue'): Promise<Submitted> {
    if (!this.busy && !this.#held && this.#items.length === 0) {
      return { turnId: await this.#exclusiveStart(text), how: 'sent' };
    }
    if (how === 'now' && this.#steer && this.#running()) {
      const id = crypto.randomUUID();
      if ((await this.#steer(text, id)) === 'joined') return { turnId: id, how: 'steered' };
      // Tarde de mais: a mensagem passa à frente da fila, para seguir já a seguir.
      this.#items.unshift({ id, text });
      this.#changed();
      this.#drainIfIdle();
      return { turnId: id, how: 'queued' };
    }
    const id = crypto.randomUUID();
    this.#items.push({ id, text });
    this.#changed();
    this.#drainIfIdle();
    return { turnId: id, how: 'queued' };
  }

  /**
   * Uma ação que não pode coincidir com um turno nem com a fila (rebobinar, desfazer, rejeitar,
   * trazer). Recusa com uma frase calma em vez de esperar.
   */
  async exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy || this.#items.length > 0) {
      throw new Error(`Espera que o agente acabe (ou interrompe-o) antes de ${what}`);
    }
    this.#busy = true;
    try {
      return await fn();
    } finally {
      this.#busy = false;
      // O que chegou entretanto foi para a fila: segue agora, se o agente estiver parado.
      this.#drainIfIdle();
    }
  }

  /**
   * O agente parou. Com fila (e sem pausa), o próximo item segue logo e a sessão não passa por
   * "parada": devolve true para o SessionManager não anunciar o idle.
   */
  settled(): boolean {
    if (this.#held || this.#paused || this.#items.length === 0 || this.#busy) return false;
    const next = this.#items[0];
    if (!next) return false;
    // #start persists the turn intent synchronously before its first await. Keep the queue
    // item until that point so a crash cannot erase it between dequeue and dispatch.
    const started = this.#exclusiveStart(next.text, true);
    this.#items.shift();
    this.#changed();
    void started.catch((error: unknown) => {
      // The provider may have accepted the message before its reply failed. Keep the text
      // and require an explicit decision; never automatically dispatch it or the next item.
      this.#items.unshift(next);
      this.#paused = true;
      this.#changed();
      this.#failed(error);
    });
    return true;
  }

  /** A worktree está a ser preparada: o que escreveres espera até release(). */
  hold(): void {
    this.#held = true;
  }

  release(): void {
    if (!this.#held) return;
    this.#held = false;
    this.#drainIfIdle();
  }

  /** Interromper pausa a fila: nada segue sozinho até "Continuar". */
  interrupted(): void {
    if (this.#items.length === 0 || this.#paused) return;
    this.#paused = true;
    this.#changed();
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#changed();
    this.#drainIfIdle();
  }

  /** Tira uma mensagem da fila; false se já tinha seguido. */
  unqueue(id: string): boolean {
    const before = this.#items.length;
    this.#items = this.#items.filter((i) => i.id !== id);
    if (this.#items.length === 0) this.#paused = false;
    if (this.#items.length === before) return false;
    this.#changed();
    return true;
  }

  /** A ordem nova (ids que já não estão na fila ficam de fora; os esquecidos vão para o fim). */
  reorder(ids: readonly string[]): void {
    const byId = new Map(this.#items.map((i) => [i.id, i]));
    const next = ids.flatMap((id) => {
      const item = byId.get(id);
      if (!item) return [];
      byId.delete(id);
      return [item];
    });
    this.#items = [...next, ...byId.values()];
    this.#changed();
  }

  /** Deita a fila fora (fechar a sessão). */
  clear(): void {
    if (this.#items.length === 0 && !this.#paused) return;
    this.#items = [];
    this.#paused = false;
    this.#changed();
  }

  async #exclusiveStart(text: string, fromQueue = false): Promise<string> {
    this.#busy = true;
    try {
      const turnId = await this.#start(text);
      this.#busy = false;
      return turnId;
    } catch (error) {
      this.#busy = false;
      if (fromQueue) this.#paused = true;
      // O envio falhou: a fila não fica presa à espera de um turno que não começou.
      this.#drainIfIdle();
      throw error;
    }
  }

  /** Uma fila que chega com o agente parado (por exemplo depois de "Continuar") segue já. */
  #drainIfIdle(): void {
    if (!this.busy && !this.#held && !this.#paused && this.#items.length > 0) this.settled();
  }

  #changed(): void {
    this.#emit(this.queue);
  }
}
