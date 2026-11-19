import type { CheckResult, CheckSpec, Checks } from '@solline/protocol';
import { CircuitOpenError, CircuitRegistry } from '../kernel/circuit-breaker.ts';
import { detectChecks } from './detect.ts';
import { runCommand, type CommandOutcome, type RunCommand } from './run.ts';

class CheckInfraError extends Error {
  readonly outcome: CommandOutcome;

  constructor(outcome: CommandOutcome) {
    super(outcome.tail ?? 'Falha ao arrancar a verificação');
    this.outcome = outcome;
  }
}

const DEFAULT_RESET_MS = 60_000;
const OPEN_MESSAGE =
  'A verificação falhou a arrancar várias vezes seguidas; em pausa temporária. Usa "Correr agora" para tentar de novo.';

/**
 * As verificações de um projeto, partilhadas pelas suas sessões: uma ronda de cada vez (uma
 * nova cancela a que vai a meio), só com confiança, e avisa sempre que o estado muda.
 */
export class ProjectChecks {
  readonly #cwd: string;
  readonly #run: RunCommand;
  readonly #detect: (cwd: string) => Promise<CheckSpec[]>;
  readonly #emit: (checks: Checks) => void;
  readonly #env: Record<string, string>;
  readonly #circuits: CircuitRegistry;
  readonly #now: () => number;
  readonly #breakerResetMs: number;
  #saved: CheckSpec[] | null;
  #state: Checks;
  #running: AbortController | null = null;

  constructor(options: {
    cwd: string;
    saved: CheckSpec[] | null;
    trusted: boolean;
    emit: (checks: Checks) => void;
    /** Variáveis para os comandos (as portas da sessão). */
    env?: Record<string, string>;
    run?: RunCommand;
    detect?: (cwd: string) => Promise<CheckSpec[]>;
    recovery?: Checks;
    circuits?: CircuitRegistry | undefined;
    now?: (() => number) | undefined;
    breakerResetMs?: number | undefined;
  }) {
    this.#cwd = options.cwd;
    this.#saved = options.saved;
    this.#emit = options.emit;
    this.#env = options.env ?? {};
    this.#run = options.run ?? runCommand;
    this.#detect = options.detect ?? detectChecks;
    this.#circuits = options.circuits ?? new CircuitRegistry();
    this.#now = options.now ?? Date.now;
    this.#breakerResetMs = options.breakerResetMs ?? DEFAULT_RESET_MS;
    this.#state = options.recovery ?? {
      trusted: options.trusted,
      specs: options.saved ?? [],
      detected: options.saved === null,
      turnId: null,
      results: [],
    };
  }

  get state(): Checks {
    return this.#state;
  }

  /** Lê de novo a lista (o package.json pode ter mudado); avisa se mudou. */
  async refresh(): Promise<void> {
    const specs = this.#saved ?? (await this.#detect(this.#cwd));
    const detected = this.#saved === null;
    if (
      JSON.stringify(specs) === JSON.stringify(this.#state.specs) &&
      detected === this.#state.detected
    )
      return;
    this.#set({ ...this.#state, specs, detected });
  }

  /** Guardaste uma lista nova (null: volta à do package.json). Os resultados antigos caem. */
  async configure(saved: CheckSpec[] | null): Promise<void> {
    for (const spec of this.#state.specs) this.#circuits.reset(`check:${spec.id}`);
    this.#saved = saved;
    this.reset();
    await this.refresh();
  }

  setTrusted(trusted: boolean): void {
    if (trusted === this.#state.trusted) return;
    if (!trusted) this.#running?.abort();
    this.#set({ ...this.#state, trusted, ...(trusted ? {} : { turnId: null, results: [] }) });
  }

  /** Começou outro turno: a ronda a meio já não diz nada sobre os ficheiros. */
  cancel(): void {
    if (!this.#running) return;
    this.#running.abort();
    this.#running = null;
    this.#set({ ...this.#state, turnId: null, results: [] });
  }

  /** Esquece os resultados (rebobinaste ou desfizeste: já não batem com os ficheiros). */
  reset(): void {
    this.#running?.abort();
    this.#running = null;
    if (this.#state.turnId !== null || this.#state.results.length > 0)
      this.#set({ ...this.#state, turnId: null, results: [] });
  }

  /** Corre as verificações ligadas, todas ao mesmo tempo. Sem confiança, não corre nada. */
  async run(turnId: string | null, options?: { manual?: boolean | undefined }): Promise<void> {
    if (!this.#state.trusted) return;
    this.#running?.abort();
    const abort = new AbortController();
    this.#running = abort;
    await this.refresh();
    if (abort.signal.aborted) return;
    const enabled = this.#state.specs.filter((s) => s.enabled);
    if (options?.manual) {
      for (const spec of enabled) this.#circuits.reset(`check:${spec.id}`);
    }
    this.#set({
      ...this.#state,
      turnId,
      results: enabled.map((s) => ({ id: s.id, state: 'running', tail: null, durationMs: null })),
    });
    await Promise.all(
      enabled.map(async (spec) => {
        const breaker = this.#circuits.getOrCreate(`check:${spec.id}`, {
          threshold: 2,
          resetMs: this.#breakerResetMs,
          now: this.#now,
        });
        let result: CheckResult;
        try {
          const outcome = await breaker.execute(
            async () => {
              const ran = await this.#run(spec.command, {
                cwd: this.#cwd,
                signal: abort.signal,
                env: this.#env,
              });
              if (ran.infraError) throw new CheckInfraError(ran);
              return ran;
            },
            {
              tripOn: (error) =>
                !abort.signal.aborted &&
                !(error instanceof Error && error.message === 'cancelled'),
            },
          );
          result = {
            id: spec.id,
            state: outcome.state,
            tail: outcome.tail,
            durationMs: outcome.durationMs,
          };
        } catch (error) {
          if (abort.signal.aborted) return;
          if (error instanceof CheckInfraError) {
            result = {
              id: spec.id,
              state: error.outcome.state,
              tail: error.outcome.tail,
              durationMs: error.outcome.durationMs,
            };
          } else if (error instanceof CircuitOpenError) {
            result = { id: spec.id, state: 'failed', tail: OPEN_MESSAGE, durationMs: 0 };
          } else {
            return;
          }
        }
        if (abort.signal.aborted) return;
        this.#set({
          ...this.#state,
          results: this.#state.results.map((r) => (r.id === spec.id ? result : r)),
        });
      }),
    );
    if (this.#running === abort) this.#running = null;
  }

  /** A verificação e o seu resultado, se falhou na última ronda. */
  failure(id: string): { spec: CheckSpec; result: CheckResult } | null {
    const spec = this.#state.specs.find((s) => s.id === id);
    const result = this.#state.results.find((r) => r.id === id);
    if (!spec || !result || (result.state !== 'failed' && result.state !== 'timeout')) return null;
    return { spec, result };
  }

  dispose(): void {
    this.#running?.abort();
    this.#running = null;
  }

  #set(next: Checks): void {
    this.#state = next;
    this.#emit(next);
  }
}

/** A mensagem que segue para o agente quando mandas uma falha. */
export function checkFixMessage(spec: CheckSpec, result: CheckResult): string {
  const what = result.state === 'timeout' ? `passou o limite de 3 minutos` : 'falhou';
  return [
    `Depois do teu último turno, a verificação "${spec.label}" (\`${spec.command}\`) ${what}. Corrige a causa; não desligues a verificação nem a contornes.`,
    '',
    '```',
    result.tail ?? '',
    '```',
  ].join('\n');
}
