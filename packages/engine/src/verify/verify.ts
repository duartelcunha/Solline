import type { CheckSpec } from '@solline/protocol';
import { runCommand, type RunCommand } from '../checks/run.ts';

/**
 * O Verificador: o sinal objetivo antes de qualquer opinião. Corre as verificações do projeto
 * numa pasta de trabalho e, para as que falham, volta a corrê-las na base (a mesma pasta antes da
 * mudança) para separar o que a mudança partiu do que já estava partido (ou é instável). Serve as
 * corridas (M4) e, mais tarde, a segunda opinião, a CI e os objetivos longos.
 */

export interface CheckVerdict {
  id: string;
  label: string;
  state: 'passed' | 'failed' | 'timeout';
  /** O fim da saída, quando falhou. */
  tail: string | null;
  /** Já falhava na base: não conta contra a mudança. */
  preexisting: boolean;
}

/** Uma pasta com o código da base, para comparar; dispose() limpa-a. */
export interface Baseline {
  cwd: string;
  dispose: () => Promise<void>;
}

export interface VerifyOptions {
  /** As verificações a correr (só as ligadas). */
  specs: readonly CheckSpec[];
  /** Cria a pasta da base só se alguma verificação falhar (custa um checkout). */
  baseline?: () => Promise<Baseline | null>;
  env?: Record<string, string>;
  signal?: AbortSignal;
  run?: RunCommand;
}

export async function verify(cwd: string, options: VerifyOptions): Promise<CheckVerdict[]> {
  const run = options.run ?? runCommand;
  const signal = options.signal ?? new AbortController().signal;
  const once = (spec: CheckSpec, where: string) =>
    run(spec.command, { cwd: where, signal, ...(options.env ? { env: options.env } : {}) });
  const results = await Promise.all(options.specs.map((spec) => once(spec, cwd)));
  const verdicts: CheckVerdict[] = options.specs.map((spec, i) => {
    const result = results[i] ?? { state: 'failed' as const, tail: null };
    return {
      id: spec.id,
      label: spec.label,
      state: result.state,
      tail: result.tail,
      preexisting: false,
    };
  });
  const failing = verdicts.filter((v) => v.state !== 'passed');
  if (failing.length === 0 || !options.baseline) return verdicts;
  const base = await options.baseline().catch(() => null);
  if (!base) return verdicts;
  try {
    await Promise.all(
      failing.map(async (verdict) => {
        const spec = options.specs.find((s) => s.id === verdict.id);
        if (!spec) return;
        const before = await once(spec, base.cwd);
        verdict.preexisting = before.state !== 'passed';
      }),
    );
  } finally {
    await base.dispose().catch(() => undefined);
  }
  return verdicts;
}

/** Quanto pesa o que falhou por culpa da mudança (para ordenar: menos é melhor). */
export function failures(verdicts: readonly CheckVerdict[]): number {
  return verdicts.filter((v) => v.state !== 'passed' && !v.preexisting).length;
}
