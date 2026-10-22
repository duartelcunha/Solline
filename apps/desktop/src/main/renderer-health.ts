import { randomUUID } from 'node:crypto';

/** A single authenticated round trip, independent of Chromium's input hang watchdog. */
export class RendererHealth {
  #active = false;
  #pending: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    readonly send: (token: string) => void,
    readonly unresponsive: () => void,
    readonly responsive: () => void,
  ) {}

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#probe();
  }

  stop(): void {
    this.#active = false;
    this.#pending = undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  acknowledge(token: unknown): void {
    if (!this.#active || typeof token !== 'string' || token !== this.#pending) return;
    clearTimeout(this.#timer);
    this.#pending = undefined;
    this.responsive();
    this.#timer = setTimeout(() => this.#probe(), 2000);
  }

  #probe(): void {
    if (!this.#active) return;
    const token = randomUUID();
    this.#pending = token;
    const due = Date.now() + 8000;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.#active || this.#pending !== token) return;
      // A sleeping/stalled main process cannot diagnose renderer health from an old deadline.
      if (Date.now() > due + 2000) {
        this.#probe();
        return;
      }
      this.unresponsive();
      // Keep the same token so a delayed genuine reply can mark the interface responsive.
    }, 8000);
    try {
      this.send(token);
    } catch {
      this.stop(); // Destruction/crash has its own authoritative recovery event.
    }
  }
}
