import type { CircuitSnapshot, CircuitState } from '@solline/protocol';

export interface CircuitBreakerOptions {
  /** Falhas consecutivas até o circuito abrir. */
  threshold: number;
  /** Milissegundos até tentar uma nova sonda (`half-open`). */
  resetMs: number;
  now?: (() => number) | undefined;
  onStateChange?: ((snapshot: CircuitSnapshot) => void) | undefined;
}

export class CircuitOpenError extends Error {
  readonly circuitId: string;
  readonly retryAt: number;

  constructor(circuitId: string, retryAt: number) {
    super(`Circuito aberto para "${circuitId}"`);
    this.name = 'CircuitOpenError';
    this.circuitId = circuitId;
    this.retryAt = retryAt;
  }
}

function formatError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat || 'Erro desconhecido';
}

/**
 * Circuit breaker leve para fronteiras externas (subprocesses, sondas MCP, cofre do Windows).
 * Nunca abre com erros de validação ou ausência legítima de dados quando `tripOn` os exclui.
 */
export class CircuitBreaker {
  readonly #id: string;
  readonly #threshold: number;
  readonly #resetMs: number;
  readonly #now: () => number;
  readonly #onStateChange: ((snapshot: CircuitSnapshot) => void) | undefined;

  #state: CircuitState = 'closed';
  #failures = 0;
  #lastError: string | null = null;
  #openedAt: number | null = null;
  #nextAttemptAt: number | null = null;
  #halfOpenInFlight = false;

  constructor(id: string, options: CircuitBreakerOptions) {
    if (!Number.isInteger(options.threshold) || options.threshold < 1)
      throw new Error(`CircuitBreaker "${id}": threshold inválido`);
    if (!Number.isFinite(options.resetMs) || options.resetMs < 0)
      throw new Error(`CircuitBreaker "${id}": resetMs inválido`);
    this.#id = id;
    this.#threshold = options.threshold;
    this.#resetMs = options.resetMs;
    this.#now = options.now ?? Date.now;
    this.#onStateChange = options.onStateChange;
  }

  get id(): string {
    return this.#id;
  }

  get state(): CircuitState {
    return this.#effectiveState();
  }

  #effectiveState(): CircuitState {
    if (this.#state === 'open' && this.#nextAttemptAt !== null && this.#now() >= this.#nextAttemptAt)
      return 'half-open';
    return this.#state;
  }

  snapshot(): CircuitSnapshot {
    return {
      id: this.#id,
      state: this.#effectiveState(),
      failures: this.#failures,
      lastError: this.#lastError,
      openedAt: this.#openedAt,
      nextAttemptAt: this.#nextAttemptAt,
    };
  }

  recordSuccess(): void {
    const changed =
      this.#state !== 'closed' ||
      this.#failures !== 0 ||
      this.#lastError !== null ||
      this.#openedAt !== null;
    this.#state = 'closed';
    this.#failures = 0;
    this.#lastError = null;
    this.#openedAt = null;
    this.#nextAttemptAt = null;
    this.#halfOpenInFlight = false;
    if (changed) this.#onStateChange?.(this.snapshot());
  }

  recordFailure(error: unknown): void {
    const now = this.#now();
    this.#failures += 1;
    this.#lastError = formatError(error);
    this.#halfOpenInFlight = false;
    if (this.#state === 'half-open' || this.#failures >= this.#threshold) {
      this.#state = 'open';
      this.#openedAt = now;
      this.#nextAttemptAt = now + this.#resetMs;
    }
    this.#onStateChange?.(this.snapshot());
  }

  reset(): void {
    this.recordSuccess();
  }

  async execute<T>(
    fn: () => Promise<T>,
    options?: { tripOn?: ((error: unknown) => boolean) | undefined },
  ): Promise<T> {
    const now = this.#now();
    if (this.#state === 'open') {
      const next = this.#nextAttemptAt ?? now;
      if (now < next) throw new CircuitOpenError(this.#id, next);
      this.#state = 'half-open';
      this.#onStateChange?.(this.snapshot());
    }
    let probed = false;
    if (this.#state === 'half-open') {
      if (this.#halfOpenInFlight)
        throw new CircuitOpenError(this.#id, this.#nextAttemptAt ?? now + this.#resetMs);
      this.#halfOpenInFlight = true;
      probed = true;
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      const shouldTrip = options?.tripOn ? options.tripOn(error) : true;
      if (shouldTrip) this.recordFailure(error);
      else if (probed) this.#halfOpenInFlight = false;
      throw error;
    }
  }
}

/** Registo central dos circuit breakers do motor para observabilidade em `engine.health`. */
export class CircuitRegistry {
  readonly #breakers = new Map<string, CircuitBreaker>();
  readonly #onStateChange: ((snapshot: CircuitSnapshot) => void) | undefined;

  constructor(options?: { onStateChange?: ((snapshot: CircuitSnapshot) => void) | undefined }) {
    this.#onStateChange = options?.onStateChange;
  }

  getOrCreate(id: string, options: CircuitBreakerOptions): CircuitBreaker {
    const existing = this.#breakers.get(id);
    if (existing) return existing;
    const breaker = new CircuitBreaker(id, {
      ...options,
      onStateChange: options.onStateChange ?? this.#onStateChange,
    });
    this.#breakers.set(id, breaker);
    return breaker;
  }

  get(id: string): CircuitBreaker | undefined {
    return this.#breakers.get(id);
  }

  reset(id: string): void {
    this.#breakers.get(id)?.reset();
  }

  snapshots(): CircuitSnapshot[] {
    return [...this.#breakers.values()].map((breaker) => breaker.snapshot());
  }
}
