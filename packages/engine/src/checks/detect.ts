import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckSpec } from '@solline/protocol';

/** O gestor de pacotes sai do ficheiro de lock; sem lock, npm. */
const LOCKS: readonly [file: string, runner: string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun run'],
  ['bun.lockb', 'bun run'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm run'],
];

/** Os scripts que a Solline reconhece, pela ordem em que aparecem. Os testes vêm desligados. */
const KNOWN: readonly { id: string; label: string; scripts: string[]; enabled: boolean }[] = [
  { id: 'typecheck', label: 'Tipos', scripts: ['typecheck', 'type-check', 'tsc'], enabled: true },
  { id: 'lint', label: 'Lint', scripts: ['lint'], enabled: true },
  { id: 'test', label: 'Testes', scripts: ['test'], enabled: false },
];

async function runnerFor(cwd: string): Promise<string> {
  for (const [file, runner] of LOCKS) {
    const found = await access(join(cwd, file)).then(
      () => true,
      () => false,
    );
    if (found) return runner;
  }
  return 'npm run';
}

/**
 * As verificações de um projeto JavaScript, lidas dos scripts da raiz do package.json. Sem
 * package.json (ou ilegível) não há nenhuma: a lista fica vazia até a escreveres.
 */
export async function detectChecks(cwd: string): Promise<CheckSpec[]> {
  let scripts: Record<string, unknown>;
  try {
    const pkg: unknown = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    const raw = (pkg as { scripts?: unknown } | null)?.scripts;
    if (!raw || typeof raw !== 'object') return [];
    scripts = raw as Record<string, unknown>;
  } catch {
    return [];
  }
  const runner = await runnerFor(cwd);
  const specs: CheckSpec[] = [];
  for (const known of KNOWN) {
    const script = known.scripts.find((name) => typeof scripts[name] === 'string');
    if (!script) continue;
    specs.push({
      id: known.id,
      label: known.label,
      command: `${runner} ${script}`,
      enabled: known.enabled,
    });
  }
  return specs;
}
