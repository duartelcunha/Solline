import { createHash } from 'node:crypto';
import type { DiffLine, FileDiff, FileStatus, Hunk } from '@solline/protocol';

/**
 * Lê o patch do git diff e parte-o em ficheiros e hunks. O texto é lido byte a byte
 * (latin1) para o patch de um hunk voltar ao git exatamente como saiu; só a cópia para a
 * interface passa a UTF-8.
 */

export interface RawHunk {
  hunk: Hunk;
  /** As linhas do hunk em bytes (latin1), com o "@@" e os "\ No newline". */
  raw: string[];
}

export interface RawFile {
  diff: FileDiff;
  /** Cabeçalho do ficheiro no patch ("diff --git", modos, "---", "+++"), em bytes. */
  header: string[];
  hunks: RawHunk[];
}

export interface FileEntry {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Acima disto um ficheiro só mostra as contas (o diff inteiro seria ilegível). */
export const MAX_FILE_LINES = 4_000;

/** git diff --numstat -z --no-renames: "adds\tdels\tpath\0" por ficheiro ("-" num binário). */
export function parseNumstat(
  out: Buffer,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const record of out.toString('utf8').split('\0')) {
    if (!record) continue;
    const [adds, dels, ...rest] = record.split('\t');
    const file = rest.join('\t');
    if (!file || adds === undefined || dels === undefined) continue;
    const binary = adds === '-' || dels === '-';
    map.set(file, {
      additions: binary ? 0 : Number(adds),
      deletions: binary ? 0 : Number(dels),
      binary,
    });
  }
  return map;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parte o patch inteiro pelos "diff --git" e casa cada secção com o ficheiro pelo caminho do
 * cabeçalho (não pela ordem: uma mudança de tipo, ficheiro para link, dá duas secções). Um
 * ficheiro com mais de uma secção fica sem hunks; quem chama já o deixa de fora.
 */
export function parsePatch(patch: Buffer, files: readonly FileEntry[]): RawFile[] {
  // O Git for Windows pode escrever o patch com CRLF. O `\r` colado ao caminho
  // faz a secção não casar com o --raw e o hunk desaparece.
  const lines = patch.toString('latin1').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const byPath = new Map<string, string[][]>();
  let current: string[] | undefined;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = [line];
      const file = headerPath(line);
      if (file !== null) byPath.set(file, [...(byPath.get(file) ?? []), current]);
    } else current?.push(line);
  }
  return files.map((entry) => {
    const sections = byPath.get(entry.path) ?? [];
    return parseSection(entry, sections.length === 1 ? (sections[0] ?? []) : []);
  });
}

/** O caminho de "diff --git a/P b/P" (sem renomeações, P é igual dos dois lados). */
export function headerPath(line: string): string | null {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const quoted = unquote(rest);
    return quoted?.startsWith('a/') ? quoted.slice(2) : null;
  }
  const length = (rest.length - 5) / 2;
  if (!Number.isInteger(length) || !rest.startsWith('a/')) return null;
  return utf8(rest.slice(2, 2 + length));
}

/** Uma string entre aspas à maneira do C, como o git escreve caminhos com caracteres especiais. */
function unquote(text: string): string | null {
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    '"': 34,
    '\\': 92,
    a: 7,
    b: 8,
    f: 12,
    v: 11,
  };
  for (let i = 1; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (ch === '"') return Buffer.from(bytes).toString('utf8');
    if (ch !== '\\') {
      bytes.push(ch.charCodeAt(0) & 0xff);
      continue;
    }
    const next = text[++i] ?? '';
    const octal = /^[0-7]{3}$/.exec(text.slice(i, i + 3));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 2;
    } else if (next in simple) bytes.push(simple[next] ?? 0);
    else return null;
  }
  return null;
}

function parseSection(entry: FileEntry, section: string[]): RawFile {
  const header: string[] = [];
  const hunks: RawHunk[] = [];
  let current: { raw: string[]; lines: DiffLine[]; meta: RegExpExecArray } | undefined;
  let oldNo = 0;
  let newNo = 0;
  const finish = () => {
    if (!current) return;
    const [, os, ol, ns, nl] = current.meta;
    const raw = current.raw;
    hunks.push({
      raw,
      hunk: {
        id: hunkId(entry.path, raw),
        header: utf8(raw[0] ?? ''),
        oldStart: Number(os),
        oldLines: ol === undefined ? 1 : Number(ol),
        newStart: Number(ns),
        newLines: nl === undefined ? 1 : Number(nl),
        lines: current.lines,
      },
    });
    current = undefined;
  };
  let total = 0;
  for (const line of section) {
    const meta = HUNK_HEADER.exec(line);
    if (meta) {
      finish();
      current = { raw: [line], lines: [], meta };
      oldNo = Number(meta[1]);
      newNo = Number(meta[3]);
      continue;
    }
    if (!current) {
      header.push(line);
      continue;
    }
    current.raw.push(line);
    const marker = line[0];
    const text = utf8(line.slice(1)).replace(/\r$/, '');
    if (marker === ' ')
      current.lines.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ });
    else if (marker === '+') current.lines.push({ kind: 'add', text, oldNo: null, newNo: newNo++ });
    else if (marker === '-') current.lines.push({ kind: 'del', text, oldNo: oldNo++, newNo: null });
    // "\ No newline at end of file" fica só no raw.
    total++;
  }
  finish();
  const truncated = total > MAX_FILE_LINES;
  return {
    header,
    hunks: truncated ? [] : hunks,
    diff: {
      path: entry.path,
      status: entry.status,
      binary: entry.binary,
      additions: entry.additions,
      deletions: entry.deletions,
      hunks: truncated ? [] : hunks.map((h) => h.hunk),
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

/** O patch de um só hunk, pronto para o git apply. */
export function hunkPatch(file: RawFile, hunk: RawHunk): Buffer {
  return Buffer.from([...file.header, ...hunk.raw, ''].join('\n'), 'latin1');
}

function hunkId(file: string, raw: readonly string[]): string {
  const hash = createHash('sha1');
  hash.update(file);
  hash.update('\0');
  for (const line of raw) hash.update(line + '\n', 'latin1');
  return hash.digest('hex').slice(0, 16);
}

function utf8(latin1: string): string {
  return Buffer.from(latin1, 'latin1').toString('utf8');
}
