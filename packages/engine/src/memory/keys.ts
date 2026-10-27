import { createHash } from 'node:crypto';
import type { MemoryCitation, MemoryEvidence } from '@solline/protocol';

/** O resumo de um texto de memória por projeto: é o que se lembra de uma memória esquecida. */
export function memoryKey(projectId: string | null, text: string): string {
  return createHash('sha256')
    .update(`${projectId ?? ''}:${text.trim().toLowerCase()}`)
    .digest('hex');
}

/** Uma citação de ficheiro (as de commit não têm prova que mude). */
export type FileCitation = Extract<MemoryCitation, { path: string }>;

export function isFileCitation(citation: MemoryCitation): citation is FileCitation {
  return 'path' in citation;
}

/** Identifica um intervalo citado: a mesma citação dá sempre a mesma chave. */
export function citationKey(c: {
  path: string;
  line?: number | undefined;
  endLine?: number | undefined;
}): string {
  return `${c.path}:${c.line ?? ''}-${c.endLine ?? ''}`;
}

export function evidenceKey(e: MemoryEvidence): string {
  return citationKey(e);
}

/** Como se mostra uma citação ao agente e ao utilizador: `src/a.ts:12-20`, `src/a.ts` ou `commit abc1234`. */
export function describeCitation(citation: MemoryCitation): string {
  if (!isFileCitation(citation)) return `commit ${citation.commit.toLowerCase()}`;
  if (citation.line === undefined) return citation.path;
  const end =
    citation.endLine !== undefined && citation.endLine !== citation.line
      ? `-${citation.endLine}`
      : '';
  return `${citation.path}:${citation.line}${end}`;
}
