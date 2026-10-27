import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileCitation } from './keys.ts';

/** Mais do que isto não se cita (e não se lê para tirar o hash). */
export const MAX_CITED_BYTES = 1_048_576;

/** O que a leitura de um ficheiro do projeto deu. `reason` diz porque não foi possível. */
export type ReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'missing' | 'outside' | 'too-big' | 'binary' | 'unreadable' };

/** Lê ficheiros de uma pasta de projeto (injetável nos testes). */
export interface ProjectFiles {
  read(root: string, relative: string): Promise<ReadResult>;
}

/** Nomes de dispositivos do Windows (abrir `src/nul` ou `CON` não é abrir um ficheiro). */
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** O que o Windows não aceita num nome, e os `:` de fluxos alternativos (`a.ts:fluxo`). */
const FORBIDDEN = /[:<>"|?*\p{Cc}]/u;

/**
 * Um caminho citado, relativo à raiz do projeto, com `/`: sem caminhos absolutos, letras de
 * unidade, `..`, NUL, `:`, nomes de dispositivos nem barras duplas. `undefined` se não serve.
 */
export function normalizeCitedPath(raw: string): string | undefined {
  if (FORBIDDEN.test(raw)) return undefined;
  const slashed = raw.trim().replaceAll(String.fromCharCode(92), '/');
  if (!slashed || slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) return undefined;
  const parts = slashed.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..' || DEVICE.test(part)))
    return undefined;
  return parts.join('/');
}

/** O ficheiro real dentro da pasta (resolve ligações simbólicas e recusa o que sai dela). */
export const nodeFiles: ProjectFiles = {
  async read(root, relative) {
    try {
      const [realRoot, file] = await Promise.all([
        realpath(root),
        realpath(path.resolve(root, relative)),
      ]);
      const inside = path.relative(realRoot, file);
      if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside))
        return { ok: false, reason: 'outside' };
      const info = await stat(file);
      if (!info.isFile()) return { ok: false, reason: 'missing' };
      if (info.size > MAX_CITED_BYTES) return { ok: false, reason: 'too-big' };
      const buffer = await readFile(file);
      if (buffer.includes(0)) return { ok: false, reason: 'binary' };
      return { ok: true, text: buffer.toString('utf8') };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // Um erro passageiro (ficheiro ocupado, sem permissão) não prova que o ficheiro mudou.
      return {
        ok: false,
        reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable',
      };
    }
  },
};

function linesOf(text: string): string[] {
  const flat = text.replaceAll('\r\n', '\n');
  return (flat.endsWith('\n') ? flat.slice(0, -1) : flat).split('\n');
}

/** Quantas linhas tem o texto (um ficheiro vazio tem uma). */
export function lineCount(text: string): number {
  return linesOf(text).length;
}

/**
 * O hash do que a citação mostra: as linhas do intervalo (ou o ficheiro todo sem `line`), com
 * CRLF contado como LF. `undefined` se o intervalo já não existe (o ficheiro encurtou).
 */
export function hashCited(text: string, citation: FileCitation): string | undefined {
  const lines = linesOf(text);
  let body: string;
  if (citation.line === undefined) body = lines.join('\n');
  else {
    const end = citation.endLine ?? citation.line;
    if (citation.line > lines.length || end > lines.length) return undefined;
    body = lines.slice(citation.line - 1, end).join('\n');
  }
  return createHash('sha256').update(body).digest('hex');
}

/** O commit existe no repositório da pasta. Falha (sem git, sem repositório) conta como "não existe". */
export function gitCommitExists(cwd: string, sha: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['cat-file', '-e', `${sha}^{commit}`],
      { cwd, timeout: 5_000, windowsHide: true },
      (error) => resolve(!error),
    );
  });
}
