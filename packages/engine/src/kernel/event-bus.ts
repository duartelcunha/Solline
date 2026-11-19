import type { EngineEvent } from '@solline/protocol';

export type EngineEventFilter = EngineEvent['type'] | '*';
export type EngineEventHandler = (event: EngineEvent) => void;

interface Subscription {
  filter: EngineEventFilter;
  handler: EngineEventHandler;
}

/**
 * Barramento interno tipado de eventos do motor. Cada subscritor corre isolado em `try/catch`
 * para que uma falha num módulo não derrube a entrega aos restantes nem o journal.
 */
export class EngineEventBus {
  readonly #byType = new Map<EngineEvent['type'], Set<Subscription>>();
  readonly #wildcard = new Set<Subscription>();
  readonly #onError: ((error: unknown, event: EngineEvent) => void) | undefined;

  constructor(options?: { onError?: ((error: unknown, event: EngineEvent) => void) | undefined }) {
    this.#onError = options?.onError;
  }

  on(filter: EngineEventFilter, handler: EngineEventHandler): () => void {
    const sub: Subscription = { filter, handler };
    if (filter === '*') {
      this.#wildcard.add(sub);
    } else {
      let bucket = this.#byType.get(filter);
      if (!bucket) {
        bucket = new Set();
        this.#byType.set(filter, bucket);
      }
      bucket.add(sub);
    }
    return () => {
      if (sub.filter === '*') {
        this.#wildcard.delete(sub);
      } else {
        const bucket = this.#byType.get(sub.filter);
        bucket?.delete(sub);
        if (bucket && bucket.size === 0) this.#byType.delete(sub.filter);
      }
    };
  }

  emit(event: EngineEvent): void {
    const targeted = [...(this.#byType.get(event.type) ?? [])];
    const any = [...this.#wildcard];
    for (const sub of [...targeted, ...any]) {
      try {
        sub.handler(event);
      } catch (error) {
        this.#onError?.(error, event);
      }
    }
  }

  clear(): void {
    this.#byType.clear();
    this.#wildcard.clear();
  }
}
