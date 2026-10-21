import { constants } from 'node:fs';
import { access, copyFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SetupSpec } from '@solline/protocol';

/**
 * Preparar uma worktree nova: o que não está no git (dependências, .env) não vem com ela. A
 * sugestão sai do projeto: o setup do conductor.json, se houver; senão instalar com o gestor do
 * lock. Os .env copiam-se da raiz do projeto, só os que não estão versionados e sem pisar nada.
 */

export const SETUP_TIMEOUT_MS = 10 * 60_000;

const INSTALL: readonly [lock: string, command: string][] = [
  ['pnpm-lock.yaml', 'pnpm install'],
  ['bun.lock', 'bun install'],
  ['bun.lockb', 'bun install'],
  ['yarn.lock', 'yarn install'],
  ['package-lock.json', 'npm install'],
];

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** O comando que a Solline sugere para preparar uma worktree deste projeto. */
export async function detectSetup(cwd: string): Promise<SetupSpec> {
  try {
    const conductor: unknown = JSON.parse(await readFile(join(cwd, 'conductor.json'), 'utf8'));
    const scripts = (conductor as { scripts?: { setup?: unknown } } | null)?.scripts;
    if (typeof scripts?.setup === 'string' && scripts.setup.trim()) {
      return { command: scripts.setup.trim(), copyEnv: true };
    }
  } catch {
    // Sem conductor.json (ou ilegível): segue para o gestor de pacotes.
  }
  for (const [lock, command] of INSTALL) {
    if (await exists(join(cwd, lock))) return { command, copyEnv: true };
  }
  if (await exists(join(cwd, 'package.json'))) return { command: 'npm install', copyEnv: true };
  return { command: '', copyEnv: true };
}

/** Os .env* da raiz do projeto (ficheiros, não pastas). */
export async function envFilesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile() && /^\.env/.test(e.name)).map((e) => e.name);
}

/**
 * Copia os .env* não versionados da raiz para a worktree. Nunca pisa um que já lá esteja; os
 * versionados já vieram com o git. Devolve os que copiou.
 */
export async function copyEnvFiles(
  from: string,
  to: string,
  tracked: ReadonlySet<string>,
): Promise<string[]> {
  const copied: string[] = [];
  for (const name of await envFilesIn(from)) {
    if (tracked.has(name)) continue;
    try {
      await copyFile(join(from, name), join(to, name), constants.COPYFILE_EXCL);
      copied.push(name);
    } catch {
      // Já existe na worktree (ou não se lê): fica como está.
    }
  }
  return copied;
}
