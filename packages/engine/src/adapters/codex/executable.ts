import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** A versão do Codex que foi revista e para a qual os tipos do protocolo foram gerados. */
export const REVIEWED_CODEX_VERSION = '0.163.0';

export interface CodexExecutable {
  path: string;
  version: string | null;
  source: 'bundled' | 'path';
}

function triple(arch: string): { pkg: string; target: string } {
  return arch === 'arm64'
    ? { pkg: '@openai/codex-win32-arm64', target: 'aarch64-pc-windows-msvc' }
    : { pkg: '@openai/codex-win32-x64', target: 'x86_64-pc-windows-msvc' };
}

/** A pasta vendor/<alvo> tem o codex.exe e um codex-package.json com a versão. */
function fromVendor(vendor: string, source: CodexExecutable['source']): CodexExecutable | null {
  const exe = path.join(vendor, 'bin', 'codex.exe');
  if (!existsSync(exe)) return null;
  let version: string | null = null;
  try {
    version =
      (
        JSON.parse(readFileSync(path.join(vendor, 'codex-package.json'), 'utf8')) as {
          version?: string;
        }
      ).version ?? null;
  } catch {
    // sem versão: o detect diz que não está revista
  }
  return { path: exe, version, source };
}

export interface ResolveCodexOptions {
  resolve?: (specifier: string) => string;
  arch?: string;
  platform?: string;
  /** Para testes: o PATH a procurar. */
  pathEnv?: string;
}

/**
 * O codex.exe nativo (nunca o bin/codex.js do npm). Primeiro o que vem com o motor
 * (desenvolvimento); senão o que estiver instalado com npm -g, procurado só em pastas
 * absolutas do PATH (nunca na pasta atual).
 */
export function resolveCodexExecutable(options: ResolveCodexOptions = {}): CodexExecutable | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return null;
  const { pkg, target } = triple(options.arch ?? process.arch);
  const resolve = options.resolve ?? createRequire(import.meta.url).resolve;
  try {
    const bundled = fromVendor(
      path.join(path.dirname(resolve(`${pkg}/package.json`)), 'vendor', target),
      'bundled',
    );
    if (bundled) return bundled;
  } catch {
    // não vem com o motor (app instalada): procura no PATH
  }
  const entries = (options.pathEnv ?? process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry));
  for (const dir of entries) {
    // npm -g põe um codex.cmd na pasta do prefixo e o pacote em <prefixo>\node_modules.
    if (!existsSync(path.join(dir, 'codex.cmd')) && !existsSync(path.join(dir, 'codex'))) continue;
    for (const vendor of [
      path.join(
        dir,
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        ...pkg.split('/'),
        'vendor',
        target,
      ),
      path.join(dir, 'node_modules', ...pkg.split('/'), 'vendor', target),
    ]) {
      const found = fromVendor(vendor, 'path');
      if (found) return found;
    }
  }
  return null;
}
