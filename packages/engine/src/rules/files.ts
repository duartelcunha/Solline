import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NativeRuleFile, ProjectRule, RulesConflict } from '@solline/protocol';
import { renderAgentsMd, renderClaudeMd } from './render.ts';

/**
 * Os ficheiros que a Solline escreve na pasta do projeto, só quando o utilizador pede. Cada um
 * começa com um marcador com o hash do resto do conteúdo: a Solline só reescreve um ficheiro que
 * ela própria escreveu e que ninguém editou depois. Nunca cria ligações simbólicas.
 */
export const NATIVE_FILES: readonly NativeRuleFile[] = ['AGENTS.md', 'CLAUDE.md'];

const MARKER = /^<!-- solline:rules v1 sha256=([0-9a-f]{64}) -->\n/;
/** Mais do que isto não é um ficheiro de instruções para importar. */
const MAX_READ_BYTES = 400_000;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Um ficheiro de fim de linha CRLF (git no Windows) conta como o mesmo conteúdo. */
function unified(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function withMarker(body: string): string {
  return `<!-- solline:rules v1 sha256=${sha256(body)} -->\n${body}`;
}

/**
 * absent: não existe. current: exportação da Solline por editar e igual ao que sairia agora.
 * stale: exportação por editar, de regras que entretanto mudaram. edited: tinha marcador e foi
 * editado. unmarked: escrito à mão. unsafe: não é um ficheiro normal (ligação simbólica, pasta).
 */
export type FileState = 'absent' | 'current' | 'stale' | 'edited' | 'unmarked' | 'unsafe';

interface Inspected {
  state: FileState;
  /** O conteúdo sem o marcador, quando se leu (vazio em absent e unsafe). */
  body?: string;
  marked?: boolean;
}

async function readCapped(file: string, size: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, MAX_READ_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function inspect(cwd: string, name: NativeRuleFile, expected: string): Promise<Inspected> {
  const file = path.join(cwd, name);
  let size: number;
  try {
    const info = await lstat(file);
    if (!info.isFile()) return { state: 'unsafe' };
    size = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'unsafe' };
  }
  if (size > MAX_READ_BYTES) return { state: 'unmarked' };
  const text = unified(await readCapped(file, size));
  const marker = MARKER.exec(text);
  if (!marker) return { state: 'unmarked', body: text, marked: false };
  const body = text.slice(marker[0].length);
  if (sha256(body) !== marker[1]) return { state: 'edited', body, marked: true };
  return { state: sha256(expected) === marker[1] ? 'current' : 'stale', body, marked: true };
}

function expectedBodies(rules: readonly ProjectRule[]): Record<NativeRuleFile, string> {
  return { 'AGENTS.md': renderAgentsMd(rules), 'CLAUDE.md': renderClaudeMd() };
}

/** O estado dos dois ficheiros face às regras de agora (para evitar dar as mesmas regras duas vezes). */
export async function nativeCoverage(
  cwd: string,
  rules: readonly ProjectRule[],
): Promise<Record<NativeRuleFile, FileState>> {
  const bodies = expectedBodies(rules);
  const [agents, claude] = await Promise.all(
    NATIVE_FILES.map((name) => inspect(cwd, name, bodies[name])),
  );
  return { 'AGENTS.md': agents?.state ?? 'absent', 'CLAUDE.md': claude?.state ?? 'absent' };
}

const CONFLICT_MESSAGE: Record<RulesConflict['reason'], (name: string) => string> = {
  unmarked: (name) =>
    `O ${name} já existe e não foi escrito pela Solline. Nada foi escrito. Podes adotá-lo (importar as regras dele) ou apagá-lo.`,
  edited: (name) =>
    `O ${name} foi editado depois de a Solline o escrever. Nada foi escrito. Podes adotá-lo (importar o que lá está) ou apagá-lo.`,
  unsafe: (name) =>
    `O ${name} não é um ficheiro normal (por exemplo uma ligação simbólica). Nada foi escrito.`,
};

function conflictOf(name: NativeRuleFile, state: FileState): RulesConflict | undefined {
  const reason =
    state === 'unmarked'
      ? 'unmarked'
      : state === 'edited'
        ? 'edited'
        : state === 'unsafe'
          ? 'unsafe'
          : null;
  return reason ? { path: name, reason, message: CONFLICT_MESSAGE[reason](name) } : undefined;
}

async function writeNew(file: string, content: string): Promise<void> {
  const temporary = `${file}.solline-${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  try {
    // O rename troca o ficheiro (ou a ligação, se alguém a pôs entretanto) sem a seguir.
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Escreve o AGENTS.md (as regras) e o CLAUDE.md (`@AGENTS.md`). Se algum dos dois for escrito à
 * mão, editado ou não for um ficheiro normal, não escreve nenhum e devolve o conflito.
 */
export async function exportRules(
  cwd: string,
  rules: readonly ProjectRule[],
): Promise<{ written: string[] } | { conflict: RulesConflict }> {
  const bodies = expectedBodies(rules);
  for (const name of NATIVE_FILES) {
    const conflict = conflictOf(name, (await inspect(cwd, name, bodies[name])).state);
    if (conflict) return { conflict };
  }
  const written: string[] = [];
  for (const name of NATIVE_FILES) {
    await writeNew(path.join(cwd, name), withMarker(bodies[name]));
    written.push(name);
  }
  return { written };
}

export interface NativeFile {
  name: NativeRuleFile;
  state: 'read' | 'missing' | 'exported' | 'unsafe';
  /** O texto a importar (sem o marcador da Solline), só em `read`. */
  text?: string;
  /** Escrito à mão (ou exportação editada): tem regras que o agente também lê da pasta. */
  handWritten?: boolean;
}

/** Lê os ficheiros de instruções da raiz para importar. Só ficheiros normais, nunca ligações. */
export async function readNativeFiles(cwd: string, only?: NativeRuleFile): Promise<NativeFile[]> {
  const names = only ? [only] : NATIVE_FILES;
  const files: NativeFile[] = [];
  for (const name of names) {
    // O esperado é irrelevante aqui: só interessa se há marcador e se bate certo.
    const found = await inspect(cwd, name, '');
    if (found.state === 'absent') files.push({ name, state: 'missing' });
    else if (found.state === 'unsafe') files.push({ name, state: 'unsafe' });
    else if (found.state === 'current' || found.state === 'stale')
      files.push({ name, state: 'exported' });
    else if (found.body === undefined) files.push({ name, state: 'unsafe' });
    else files.push({ name, state: 'read', text: found.body, handWritten: true });
  }
  return files;
}
