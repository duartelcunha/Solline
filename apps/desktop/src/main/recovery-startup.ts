import type { EngineHost } from './engine-host';
import type { UiRecoveryStore } from './ui-recovery';

/** An initialization failure stays blocked until an explicit recovery action retries it. */
export class RecoveryStartup {
  #attempt: Promise<void> | undefined;
  #pending = false;
  constructor(
    readonly drafts: Pick<UiRecoveryStore, 'load' | 'retry'>,
    readonly engine: Pick<
      EngineHost,
      'running' | 'failedToStart' | 'start' | 'restartFailed' | 'restartStopped' | 'request'
    >,
    readonly loadKey: () => Promise<Buffer>,
  ) {}
  ready(): Promise<void> {
    return this.#attempt ?? this.#begin(false);
  }
  retry(): Promise<void> {
    if (this.#pending && this.#attempt) return this.#attempt;
    return this.#begin(true);
  }
  #begin(retry: boolean): Promise<void> {
    this.#pending = true;
    this.#attempt = this.#run(retry).finally(() => {
      this.#pending = false;
    });
    return this.#attempt;
  }
  async #run(retry: boolean): Promise<void> {
    const key = await this.loadKey();
    try {
      await (retry ? this.drafts.retry() : this.drafts.load());
      if (this.engine.failedToStart) await this.engine.restartFailed(key);
      else if (!this.engine.running) this.engine.start(key);
      let snapshot = await this.engine.request('engine.snapshot', {});
      if (snapshot.lifecycle === 'stopping')
        throw new Error(
          'O motor ainda está a guardar e a interromper trabalho. Espera e volta a tentar; nenhum agente foi reiniciado.',
        );
      if (snapshot.lifecycle === 'stopped') {
        await this.engine.restartStopped(key);
        snapshot = await this.engine.request('engine.snapshot', {});
      }
      if (snapshot.lifecycle !== 'running')
        throw new Error('O estado do motor ainda não foi confirmado.');
    } finally {
      key.fill(0);
    }
  }
}
