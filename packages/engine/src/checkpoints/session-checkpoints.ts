import { lstat, mkdir, readdir, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Checkpoint,
  ConversationRewind,
  DiffScope,
  DiffStats,
  FileDiff,
  ReviewAction,
  Timeline,
} from '@solline/protocol';
import { GitError, type ShadowGit } from './git.ts';
import {
  hunkPatch,
  parseNumstat,
  parsePatch,
  type FileEntry,
  type RawFile,
} from './unified-diff.ts';

/** Acima disto a pasta não leva checkpoints (copiá-la toda a cada turno não compensa). */
const MAX_FILES = 20_000;

const EMPTY_STATS: DiffStats = { files: 0, additions: 0, deletions: 0 };
/** Modos que não se restauram nem se mostram: submódulos e links simbólicos. */
const SKIPPED_MODES = new Set(['160000', '120000']);

interface Entry {
  checkpoint: Checkpoint;
  /** Árvore do disco antes do turno. */
  before: string;
  /** Árvore no fim do turno; null enquanto corre. */
  after: string | null;
}

interface UndoEntry {
  label: string;
  baseline: string;
  /** Árvore do disco antes da ação; os paths voltam a ela. */
  worktree: string;
  paths: string[];
  acceptedAt: Map<string, number>;
  rewoundTo: string | null;
}

interface TreeItem {
  mode: string;
  sha: string;
}

/**
 * Os checkpoints de uma sessão. Cada turno guarda a árvore do disco antes e no fim; "rever"
 * compara o que já aceitaste (a base de revisão) com o disco. Aceitar move a base; rejeitar e
 * rebobinar escrevem no disco, sempre com um passo de "Desfazer".
 */
export class SessionCheckpoints {
  readonly #git: ShadowGit;
  readonly #sessionId: string;
  readonly #conversationRewind: () => ConversationRewind;
  readonly #entries: Entry[] = [];
  readonly #undo: UndoEntry[] = [];
  /** Para cada ficheiro aceite, quantos checkpoints havia nesse momento (ver rewindFiles). */
  #acceptedAt = new Map<string, number>();
  #base = '';
  #baseline = '';
  #pending: DiffStats = EMPTY_STATS;
  #rewoundTo: string | null = null;
  #unavailable: string | undefined;
  #lock: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(options: {
    git: ShadowGit;
    sessionId: string;
    /** Init partilhado do repositório (um por projeto). */
    repoReady: Promise<void>;
    conversationRewind: () => ConversationRewind;
  }) {
    this.#git = options.git;
    this.#sessionId = options.sessionId;
    this.#conversationRewind = options.conversationRewind;
    this.ready = this.#serial(async () => {
      try {
        await options.repoReady;
        await rm(path.join(this.#git.gitDir, `${this.#index}.lock`), { force: true });
        const refused = refusedFolder(this.#git.workTree);
        if (refused) throw new Error(refused);
        const files = await this.#git.countFiles(MAX_FILES, this.#index);
        if (files > MAX_FILES) {
          throw new Error(`a pasta tem mais de ${MAX_FILES.toLocaleString('pt-PT')} ficheiros`);
        }
        this.#base = await this.#snapshot();
        this.#baseline = this.#base;
      } catch (error) {
        this.#unavailable = reasonFor(error);
      }
    });
  }

  get #index(): string {
    return `index-${this.#sessionId}`;
  }

  get available(): boolean {
    return this.#unavailable === undefined;
  }

  timeline(): Timeline {
    return {
      available: this.available,
      ...(this.#unavailable ? { reason: this.#unavailable } : {}),
      checkpoints: this.#entries.map((e) => ({ ...e.checkpoint })),
      pending: this.#pending,
      undo: this.#undo.at(-1)?.label ?? null,
      conversationRewind: this.#conversationRewind(),
      rewoundTo: this.#rewoundTo,
    };
  }

  has(turnId: string): boolean {
    return this.#entries.some((e) => e.checkpoint.turnId === turnId);
  }

  /**
   * Guarda o disco antes de a mensagem seguir. staged resolve quando o git já leu a pasta (a
   * mensagem pode seguir); done quando o checkpoint está na linha do tempo. Uma falha aqui
   * nunca trava a conversa: os checkpoints ficam indisponíveis e pronto.
   */
  beginTurn(turnId: string, text: string): { staged: Promise<void>; done: Promise<void> } {
    let release: () => void = () => undefined;
    const staged = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = this.#serial(async () => {
      try {
        if (!this.available) return;
        await this.#stage();
        release();
        const before = await this.#tree();
        this.#entries.push({
          before,
          after: null,
          checkpoint: {
            turnId,
            index: this.#entries.length + 1,
            title: titleOf(text),
            at: Date.now(),
            state: 'running',
            stats: EMPTY_STATS,
          },
        });
        this.#rewoundTo = null;
      } catch (error) {
        this.#unavailable = reasonFor(error);
      } finally {
        release();
      }
    });
    return { staged, done };
  }

  /** Fecha o turno que corre: guarda o disco no fim e conta o que mudou. */
  endTurn(): Promise<void> {
    return this.#serial(async () => {
      const entry = this.#entries.at(-1);
      if (!this.available || !entry || entry.after) return;
      try {
        entry.after = await this.#snapshot();
        entry.checkpoint = {
          ...entry.checkpoint,
          state: 'done',
          stats: await this.#stats(entry.before, entry.after),
        };
        this.#pending = await this.#stats(this.#baseline, entry.after);
      } catch (error) {
        this.#unavailable = reasonFor(error);
      }
    });
  }

  /** Volta a contar o que está por rever (o disco pode ter mudado por fora). */
  refresh(): Promise<Timeline> {
    return this.#serial(async () => {
      if (this.available) this.#pending = await this.#stats(this.#baseline, await this.#snapshot());
      return this.timeline();
    });
  }

  diff(scope: DiffScope): Promise<FileDiff[]> {
    return this.#serial(async () => {
      this.#require();
      const { from, to } = await this.#range(scope);
      return (await this.#diff(from, to)).map((f) => f.diff);
    });
  }

  apply(action: ReviewAction, filePath?: string, hunkId?: string): Promise<Timeline> {
    return this.#serial(async () => {
      this.#require();
      if (hunkId && !filePath) throw new Error('Falta o ficheiro do hunk');
      const now = await this.#snapshot();
      const files = await this.#diff(this.#baseline, now);
      const targets = filePath ? files.filter((f) => f.diff.path === filePath) : files;
      if (filePath && targets.length === 0) {
        throw new Error('Este ficheiro já não tem nada por rever');
      }
      const file = targets[0];
      const hunk = hunkId ? file?.hunks.find((h) => h.hunk.id === hunkId) : undefined;
      if (hunkId && !hunk) throw new Error('Este hunk mudou entretanto; o diff foi atualizado');
      if (targets.length === 0) return this.timeline();

      const paths = targets.map((f) => f.diff.path);
      this.#pushUndo(labelFor(action, filePath, hunkId), now, paths);
      try {
        if (action === 'accept') await this.#accept(now, paths, file, hunk, Boolean(filePath));
        else if (file && hunk) {
          await this.#git.run(['apply', '-R', '--whitespace=nowarn', '-'], {
            input: hunkPatch(file, hunk),
          });
        } else await this.#restore(this.#baseline, paths);
      } catch (error) {
        this.#undo.pop();
        if (!(error instanceof GitError)) throw error;
        throw new Error('Não deu: o ficheiro mudou entretanto. Lê o diff de novo.', {
          cause: error,
        });
      }
      this.#rewoundTo = null;
      this.#pending = await this.#stats(this.#baseline, await this.#snapshot());
      return this.timeline();
    });
  }

  async #accept(
    now: string,
    paths: string[],
    file: RawFile | undefined,
    hunk: RawFile['hunks'][number] | undefined,
    onlyFile: boolean,
  ): Promise<void> {
    if (file && hunk) {
      this.#baseline = await this.#withReviewIndex(this.#baseline, async (index) => {
        await this.#git.run(['apply', '--cached', '--whitespace=nowarn', '-'], {
          index,
          input: hunkPatch(file, hunk),
        });
      });
    } else if (onlyFile) {
      this.#baseline = await this.#withReviewIndex(this.#baseline, (index) =>
        this.#copyEntries(now, paths, index),
      );
    } else {
      this.#baseline = now;
    }
    const count = this.#entries.length;
    for (const p of paths) this.#acceptedAt.set(p, count);
  }

  undo(): Promise<Timeline> {
    return this.#serial(async () => {
      this.#require();
      const entry = this.#undo.pop();
      if (!entry) throw new Error('Não há nada para desfazer');
      await this.#restore(entry.worktree, entry.paths);
      this.#baseline = entry.baseline;
      this.#acceptedAt = entry.acceptedAt;
      this.#rewoundTo = entry.rewoundTo;
      this.#pending = await this.#stats(this.#baseline, await this.#snapshot());
      return this.timeline();
    });
  }

  /**
   * Põe os ficheiros como estavam antes do turno. Só mexe no que o git sombra conhece (o que
   * o .gitignore deixa de fora não muda). Fica um passo de "Desfazer" para voltar ao presente.
   */
  rewindFiles(turnId: string): Promise<void> {
    return this.#serial(async () => {
      this.#require();
      const target = this.#entry(turnId);
      const now = await this.#snapshot();
      const changed = (await this.#diffEntries(target.before, now)).map((e) => e.path);
      this.#pushUndo(
        `Rebobinar ficheiros para antes do turno ${target.checkpoint.index}`,
        now,
        changed,
      );
      if (changed.length > 0) await this.#restore(target.before, changed);
      // O que aceitaste depois de este turno começar desapareceu do disco: sai também da base.
      const since = target.checkpoint.index - 1;
      const accepted = changed.filter((p) => (this.#acceptedAt.get(p) ?? -1) >= since);
      if (accepted.length > 0) {
        this.#baseline = await this.#withReviewIndex(this.#baseline, (index) =>
          this.#copyEntries(target.before, accepted, index),
        );
        for (const p of accepted) this.#acceptedAt.delete(p);
      }
      this.#rewoundTo = turnId;
      this.#pending = await this.#stats(this.#baseline, await this.#snapshot());
    });
  }

  /** A conversa voltou a antes deste turno: ele e os seguintes saem da linha do tempo. */
  truncate(turnId: string): Promise<void> {
    return this.#serial(() => {
      const index = this.#entries.findIndex((e) => e.checkpoint.turnId === turnId);
      if (index !== -1) this.#entries.splice(index);
      if (this.#rewoundTo && !this.has(this.#rewoundTo)) this.#rewoundTo = null;
      return Promise.resolve();
    });
  }

  /** Apaga os índices desta sessão; os objetos vão com a pasta desta execução do motor. */
  dispose(): Promise<void> {
    return this.#serial(async () => {
      for (const name of [this.#index, `review-${this.#sessionId}`]) {
        await rm(path.join(this.#git.gitDir, name), { force: true });
      }
    });
  }

  // --- por dentro -------------------------------------------------------------------------

  #require(): void {
    if (this.#unavailable)
      throw new Error(`Os checkpoints não estão disponíveis: ${this.#unavailable}`);
  }

  #entry(turnId: string): Entry {
    const entry = this.#entries.find((e) => e.checkpoint.turnId === turnId);
    if (!entry) throw new Error('Este turno não tem checkpoint');
    return entry;
  }

  async #range(scope: DiffScope): Promise<{ from: string; to: string }> {
    switch (scope.kind) {
      case 'review':
        return { from: this.#baseline, to: await this.#snapshot() };
      case 'session':
        return { from: this.#base, to: await this.#snapshot() };
      case 'turn': {
        const entry = this.#entry(scope.turnId);
        return { from: entry.before, to: entry.after ?? (await this.#snapshot()) };
      }
    }
  }

  #pushUndo(label: string, worktree: string, paths: string[]): void {
    this.#undo.push({
      label,
      baseline: this.#baseline,
      worktree,
      paths,
      acceptedAt: new Map(this.#acceptedAt),
      rewoundTo: this.#rewoundTo,
    });
    // Chega para desfazer uma sessão de revisão; os mais antigos saem.
    if (this.#undo.length > 50) this.#undo.shift();
  }

  /** A árvore do disco agora. O índice da sessão faz isto ser rápido a partir da segunda vez. */
  async #snapshot(): Promise<string> {
    await this.#stage();
    return this.#tree();
  }

  /** Passa o disco para o índice da sessão (a parte que lê a pasta). */
  async #stage(): Promise<void> {
    // --ignore-errors: um ficheiro trancado (comum no Windows) não estraga o checkpoint todo.
    await this.#git.run(['add', '--all', '--ignore-errors', '--', '.'], {
      index: this.#index,
      okCodes: [0, 1],
    });
  }

  #tree(): Promise<string> {
    return this.#git.text(['write-tree'], { index: this.#index });
  }

  async #stats(from: string, to: string): Promise<DiffStats> {
    if (from === to) return EMPTY_STATS;
    const entries = await this.#diffEntries(from, to);
    return entries.reduce<DiffStats>(
      (acc, e) => ({
        files: acc.files + 1,
        additions: acc.additions + e.additions,
        deletions: acc.deletions + e.deletions,
      }),
      EMPTY_STATS,
    );
  }

  /** Os ficheiros que mudam entre duas árvores, sem submódulos nem links simbólicos. */
  async #diffEntries(from: string, to: string): Promise<(FileEntry & { skipped: boolean })[]> {
    if (from === to) return [];
    const common = ['--no-renames', '--no-ext-diff', '--no-textconv', from, to];
    const [raw, numstat] = await Promise.all([
      this.#git.run(['diff', '--raw', '-z', ...common], { bare: true }),
      this.#git.run(['diff', '--numstat', '-z', ...common], { bare: true }),
    ]);
    const counts = parseNumstat(numstat.stdout);
    return parseRaw(raw.stdout).map((r) => {
      const count = counts.get(r.path) ?? { additions: 0, deletions: 0, binary: false };
      return { ...r, ...count };
    });
  }

  async #diff(from: string, to: string): Promise<RawFile[]> {
    const entries = await this.#diffEntries(from, to);
    if (entries.length === 0) return [];
    const patch = await this.#git.run(
      [
        'diff',
        '--no-color',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '-U3',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        from,
        to,
      ],
      { bare: true },
    );
    return parsePatch(patch.stdout, entries).filter((_, i) => !entries[i]?.skipped);
  }

  /** Carrega uma árvore num índice à parte, deixa mexer e devolve a árvore nova. */
  async #withReviewIndex(tree: string, change: (index: string) => Promise<void>): Promise<string> {
    const index = `review-${this.#sessionId}`;
    await this.#git.run(['read-tree', tree], { index });
    await change(index);
    return this.#git.text(['write-tree'], { index });
  }

  /** Copia para o índice as entradas destes paths tal como estão na árvore (ou tira-as). */
  async #copyEntries(tree: string, paths: readonly string[], index: string): Promise<void> {
    const items = await this.#lsTree(tree, paths);
    const lines = paths.map((p) => {
      const item = items.get(p);
      return item ? `${item.mode} ${item.sha}\t${p}\0` : `0 ${'0'.repeat(40)}\t${p}\0`;
    });
    await this.#git.run(['update-index', '-z', '--index-info'], { index, input: lines.join('') });
  }

  async #lsTree(tree: string, paths: readonly string[]): Promise<Map<string, TreeItem>> {
    const items = new Map<string, TreeItem>();
    for (let i = 0; i < paths.length; i += 200) {
      const chunk = paths.slice(i, i + 200);
      const out = await this.#git.run(['ls-tree', '-z', '-r', tree, '--', ...chunk], {
        bare: true,
      });
      for (const record of out.stdout.toString('utf8').split('\0')) {
        const tab = record.indexOf('\t');
        if (tab === -1) continue;
        const [mode, , sha] = record.slice(0, tab).split(' ');
        if (mode && sha) items.set(record.slice(tab + 1), { mode, sha });
      }
    }
    return items;
  }

  /** Escreve no disco estes paths como estão na árvore; os que lá não existem são apagados. */
  async #restore(tree: string, paths: readonly string[]): Promise<void> {
    const root = await realpath(this.#git.workTree);
    const items = await this.#lsTree(tree, paths);
    for (const rel of paths) {
      const item = items.get(rel);
      if (item && SKIPPED_MODES.has(item.mode)) continue;
      const target = await safeTarget(root, rel);
      if (item) {
        const blob = await this.#git.run(['cat-file', 'blob', item.sha], { bare: true });
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, blob.stdout);
      } else {
        await unlink(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await removeEmptyParents(root, path.dirname(target));
      }
    }
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.catch(() => undefined);
    return run;
  }
}

/** git diff --raw -z: ":modo modo sha sha S\0path\0". */
function parseRaw(out: Buffer): { path: string; status: FileEntry['status']; skipped: boolean }[] {
  const parts = out.toString('utf8').split('\0');
  const entries: { path: string; status: FileEntry['status']; skipped: boolean }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    const file = parts[i + 1];
    if (!meta?.startsWith(':') || !file) continue;
    const [srcMode = '', dstMode = '', , , code = ''] = meta.slice(1).split(' ');
    entries.push({
      path: file,
      status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified',
      skipped: SKIPPED_MODES.has(srcMode) || SKIPPED_MODES.has(dstMode),
    });
  }
  return entries;
}

/**
 * O caminho no disco para um path do git, sem sair da pasta do projeto: nem por "..", nem por
 * uma pasta que seja um link para fora, nem a escrever através de um link simbólico.
 */
async function safeTarget(root: string, rel: string): Promise<string> {
  const target = path.resolve(root, rel);
  if (!isInside(root, target) || target === root) {
    throw new Error(`Caminho fora do projeto: ${rel}`);
  }
  let dir = path.dirname(target);
  for (;;) {
    const real = await realpath(dir).catch(() => null);
    if (real) {
      if (!isInside(root, real)) throw new Error(`Caminho fora do projeto: ${rel}`);
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`Caminho fora do projeto: ${rel}`);
    dir = up;
  }
  const stat = await lstat(target).catch(() => null);
  if (stat?.isSymbolicLink()) throw new Error(`Não mexo em links simbólicos: ${rel}`);
  if (stat?.isDirectory()) throw new Error(`Há uma pasta onde devia estar um ficheiro: ${rel}`);
  return target;
}

/** Pastas que nunca se copiam: a raiz de um disco, a pasta pessoal e a temporária. */
function refusedFolder(folder: string): string | undefined {
  const resolved = path.resolve(folder);
  const same = (a: string, b: string) =>
    process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
  if (path.dirname(resolved) === resolved) return 'a pasta é a raiz do disco';
  if (same(resolved, path.resolve(homedir()))) return 'a pasta é a tua pasta pessoal';
  if (same(resolved, path.resolve(tmpdir()))) return 'a pasta é a pasta temporária';
  return undefined;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function removeEmptyParents(root: string, dir: string): Promise<void> {
  let current = dir;
  while (isInside(root, current) && current !== root) {
    const entries = await readdir(current).catch(() => null);
    if (!entries || entries.length > 0) return;
    await rmdir(current).catch(() => undefined);
    current = path.dirname(current);
  }
}

function titleOf(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function labelFor(action: ReviewAction, filePath?: string, hunkId?: string): string {
  const what = hunkId ? 'o hunk' : filePath ? path.basename(filePath) : 'tudo';
  return action === 'accept' ? `Aceitar ${what}` : `Rejeitar ${what}`;
}

function reasonFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/não arrancou|ENOENT/i.test(message)) return 'o git não está instalado nesta máquina';
  if (/sem resposta/i.test(message)) return 'a pasta é grande demais para guardar checkpoints';
  return message;
}
