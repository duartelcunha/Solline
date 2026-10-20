import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Pacote do SDK que traz o binário do Claude Code para esta plataforma
 * (por exemplo @anthropic-ai/claude-agent-sdk-win32-x64).
 */
export function platformPackageName(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
}

export function binaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'claude.exe' : 'claude';
}

/**
 * Dentro do app.asar não se pode executar nada: o electron-builder deixa o pacote
 * em app.asar.unpacked (asarUnpack) e é para lá que apontamos.
 */
export function toUnpackedPath(filePath: string): string {
  return filePath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

export interface ResolveOptions {
  /** true quando corre a partir da app instalada. */
  packaged: boolean;
  /** Para testes: resolve um especificador como o require.resolve. */
  resolve?: (specifier: string) => string;
  platform?: string;
  arch?: string;
}

/**
 * Caminho a passar em pathToClaudeCodeExecutable.
 * Em desenvolvimento devolve undefined e o SDK encontra o binário sozinho.
 */
export function resolveClaudeExecutable(options: ResolveOptions): string | undefined {
  if (!options.packaged) return undefined;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const resolve = options.resolve ?? createRequire(import.meta.url).resolve;
  const manifest = resolve(`${platformPackageName(platform, arch)}/package.json`);
  return toUnpackedPath(path.join(path.dirname(manifest), binaryName(platform)));
}
