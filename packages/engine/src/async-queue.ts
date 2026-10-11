/**
 * Fila assíncrona de uma só leitura: o SDK lê dela em streaming-input e o motor
 * empurra cada mensagem nova. close() termina a iteração.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #closed = false;

  push(item: T): void {
    if (this.#closed) throw new Error('A fila já fechou');
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      waiting({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  close(): void {
    this.#closed = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  get closed(): boolean {
    return this.#closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
