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

/** git diff --name-status -z --no-renames: "A\0path\0M\0path\0…". */
export function parseNameStatus(out: Buffer): { path: string; status: FileStatus }[] {
  const parts = out.toString('utf8').split('\0');
  const entries: { path: string; status: FileStatus }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i];
    const file = parts[i + 1];
    if (!code || !file) continue;
    const status: FileStatus = code.startsWith('A')
      ? 'added'
      : code.startsWith('D')
        ? 'deleted'
        : 'modified';
    entries.push({ path: file, status });
  }
  return entries;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parte o patch inteiro pelos "diff --git". As secções vêm pela mesma ordem que a lista de
 * ficheiros (o git ordena as duas da mesma forma), por isso casam uma a uma.
 */
export function parsePatch(patch: Buffer, files: readonly FileEntry[]): RawFile[] {
  const lines = patch.toString('latin1').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ')) sections.push([line]);
    else sections.at(-1)?.push(line);
  }
  return files.map((entry, index) => parseSection(entry, sections[index] ?? []));
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
