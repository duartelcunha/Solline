import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

/** O que se lê das regras do projeto: o suficiente para as convenções, não para um livro. */
export const MAX_RULES_CHARS = 8_000;
const FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

async function readCapped(file: string, limit: number): Promise<string | null> {
  try {
    // Só ficheiros normais na raiz: uma ligação simbólica podia apontar para fora do projeto.
    const info = await lstat(file);
    if (!info.isFile()) return null;
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size, limit * 4));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8').slice(0, limit);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * O CLAUDE.md e o AGENTS.md da raiz do projeto, cortados, para o revisor julgar o diff pelas
 * regras do projeto. Só se chama em projetos de confiança. É só texto: não carrega hooks nem
 * permissões, que é o que as definições do projeto (settingSources) trariam.
 */
export async function readProjectRules(cwd: string): Promise<string | undefined> {
  const parts: string[] = [];
  let left = MAX_RULES_CHARS;
  for (const name of FILES) {
    if (left <= 0) break;
    const text = (await readCapped(path.join(cwd, name), left))?.trim();
    if (!text) continue;
    const part = `## ${name}\n${text}`;
    parts.push(part);
    left -= part.length;
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
