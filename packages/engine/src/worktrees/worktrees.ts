import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorktreeStats } from '@solline/protocol';
import { resolveGit } from '../checkpoints/git.ts';
import { parseRaw } from '../checkpoints/session-checkpoints.ts';
import { parseNumstat, parsePatch, type RawFile } from '../checkpoints/unified-diff.ts';

/**
 * As worktrees das sessões: quando um projeto já tem uma sessão a trabalhar na pasta, a
 * seguinte ganha uma worktree e um branch próprios, na pasta de dados da Solline (o projeto
 * fica limpo). "Trazer" faz merge do branch para o branch atual do projeto.
 *
 * Cada worktree tem ao lado um <pasta>.json com o branch, a base e o projeto: é o que permite
 * mostrar as que ficaram por trazer depois de a app fechar (as sessões só vivem em memória).
 */

export interface Worktree {
  /** Pasta da worktree (a raiz do repositório lá dentro). */
  path: string;
  /** Pasta onde a sessão trabalha: a mesma subpasta do projeto, dentro da worktree. */
  cwd: string;
  branch: string;
  /** O commit de onde a sessão partiu (ou o do último "Trazer"). */
  base: string;
  /** Raiz do repositório do projeto. */
  top: string;
  projectId: string;
  /** Sufixo de 4 letras: fica no nome da pasta e do branch. */
  suffix: string;
}

interface Meta {
  branch: string;
  base: string;
  top: string;
  cwd: string;
  projectId: string;
  suffix: string;
}

export interface BringResult {
  merged: boolean;
  /** Ficheiros em conflito (o merge foi desfeito no projeto). */
  conflicts: string[];
  /** O branch do projeto que recebeu (ou ia receber) o merge. */
  into: string;
}

const TIMEOUT_MS = 60_000;
const NO_STATS: WorktreeStats = { files: 0, additions: 0, deletions: 0 };

/** O título em minúsculas, sem acentos, até quatro palavras ligadas por hífen. */
export function slug(title: string): string {
  return (
    title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
      .slice(0, 4)
      .join('-')
      .slice(0, 40) || 'sessao'
  );
}

/** Ambiente do git sem as variáveis que o mandariam para outro repositório. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|NAMESPACE)$/i.test(key),
    ),
  );
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

export class WorktreeManager {
  readonly #root: string;
  readonly #git: string;

  constructor(options: { root: string; git?: string }) {
    this.#root = options.root;
    this.#git = options.git ?? resolveGit() ?? 'git';
  }

  get root(): string {
    return this.#root;
  }

  async #run(
    cwd: string,
    args: string[],
    allowFail = false,
    extraEnv: Record<string, string> = {},
  ): Promise<{ code: number; out: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        this.#git,
        ['-c', 'core.quotepath=false', ...args],
        {
          cwd,
          env: { ...gitEnv(), ...extraEnv },
          windowsHide: true,
          timeout: TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          if (code !== 0 && !allowFail) {
            reject(new Error(`git ${args[0]}: ${(stderr || String(error?.message)).trim()}`));
            return;
          }
          resolve({ code, out: stdout });
        },
      );
    });
  }

  /** A raiz do repositório de uma pasta, ou null se não for git (ou ainda não tiver commits). */
  async repoOf(dir: string): Promise<string | null> {
    const top = await this.#run(dir, ['rev-parse', '--show-toplevel'], true).catch(() => null);
    if (!top || top.code !== 0) return null;
    const head = await this.#run(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], true);
    return head.code === 0 ? path.resolve(top.out.trim()) : null;
  }

  /** Cria a worktree de uma sessão a partir do HEAD do projeto; null se a pasta não for git. */
  async create(projectPath: string, projectId: string): Promise<Worktree | null> {
    const top = await this.repoOf(projectPath);
    if (!top) return null;
    const base = (await this.#run(top, ['rev-parse', 'HEAD'])).out.trim();
    return this.#add(top, path.relative(top, path.resolve(projectPath)), base, projectId);
  }

  /** Uma worktree irmã de outra: o mesmo projeto, a mesma pasta e o mesmo commit de partida. */
  async createFrom(sibling: Worktree): Promise<Worktree> {
    return this.#add(
      sibling.top,
      path.relative(sibling.path, sibling.cwd),
      sibling.base,
      sibling.projectId,
    );
  }

  /**
   * Uma worktree nova que parte do resultado de outra: grava tudo o que a outra tem por gravar
   * e usa esse commit como base (e não a base da outra). A outra fica como estava, só com o
   * commit a mais; o diff dela face à sua base não muda.
   */
  async createAfter(sibling: Worktree): Promise<Worktree> {
    await this.commitAll(sibling, 'Solline: parte concluída');
    const head = (await this.#run(sibling.path, ['rev-parse', 'HEAD'])).out.trim();
    return this.#add(
      sibling.top,
      path.relative(sibling.path, sibling.cwd),
      head,
      sibling.projectId,
    );
  }

  async #add(top: string, rel: string, base: string, projectId: string): Promise<Worktree> {
    const suffix = randomBytes(3)
      .toString('base64url')
      .replace(/[^a-z0-9]/gi, 'x')
      .slice(0, 4)
      .toLowerCase();
    const branch = `solline/sessao-${suffix}`;
    const dir = path.join(this.#root, projectId, suffix);
    await mkdir(path.dirname(dir), { recursive: true });
    await this.#run(top, ['worktree', 'add', '--quiet', '-b', branch, dir, base]);
    const wt: Worktree = {
      path: dir,
      cwd: path.join(dir, rel),
      branch,
      base,
      top,
      projectId,
      suffix,
    };
    await this.#save(wt);
    return wt;
  }

  /** Dá ao branch o nome da primeira mensagem (solline/<título>-<4 letras>). */
  async rename(wt: Worktree, title: string): Promise<Worktree> {
    const branch = `solline/${slug(title)}-${wt.suffix}`;
    if (branch === wt.branch) return wt;
    await this.#run(wt.path, ['branch', '-m', wt.branch, branch]);
    const next = { ...wt, branch };
    await this.#save(next);
    return next;
  }

  /** Reconcile a crash between Git branch rename and its metadata/event, without writing. */
  async recover(wt: Worktree): Promise<Worktree> {
    const relative = path.relative(this.#root, wt.path);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('A worktree recuperada está fora da pasta da Solline.');
    const canonical = (value: string) =>
      process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const top = (await this.#run(wt.path, ['rev-parse', '--show-toplevel'])).out.trim();
    if (canonical(top) !== canonical(wt.path))
      throw new Error('A worktree recuperada já não corresponde à pasta guardada.');
    const branch = (await this.#run(wt.path, ['symbolic-ref', '--short', 'HEAD'])).out.trim();
    if (!branch.startsWith('solline/') || !branch.endsWith(`-${wt.suffix}`))
      throw new Error('O branch da worktree mudou fora da Solline; confirma-o antes de continuar.');
    const actualCommon = (await this.#run(wt.path, ['rev-parse', '--git-common-dir'])).out.trim();
    const expectedCommon = (await this.#run(wt.top, ['rev-parse', '--git-common-dir'])).out.trim();
    if (
      canonical(path.resolve(wt.path, actualCommon)) !==
      canonical(path.resolve(wt.top, expectedCommon))
    )
      throw new Error('A worktree já não pertence ao projeto guardado.');
    await this.#run(wt.path, ['cat-file', '-e', `${wt.base}^{commit}`]);
    return { ...wt, branch };
  }

  /**
   * O que a worktree mudou face à base, ficheiro a ficheiro e hunk a hunk (contando o que está
   * por gravar e os ficheiros novos), num índice só seu: nem o do agente nem o das contas, que
   * podem estar a correr ao mesmo tempo.
   */
  async diff(wt: Worktree): Promise<RawFile[]> {
    const file = `${wt.path}.${randomBytes(4).toString('hex')}.index`;
    const index = { GIT_INDEX_FILE: file };
    const common = ['--cached', '--no-renames', '--no-ext-diff', '--no-textconv', wt.base];
    let raw: Buffer, numstat: Buffer, patch: Buffer;
    try {
      await this.#run(wt.path, ['read-tree', 'HEAD'], false, index);
      await this.#run(wt.path, ['add', '-A'], false, index);
      [raw, numstat, patch] = await Promise.all([
        this.#runBuffer(wt.path, ['diff', '--raw', '-z', ...common], index),
        this.#runBuffer(wt.path, ['diff', '--numstat', '-z', ...common], index),
        this.#runBuffer(
          wt.path,
          ['diff', '--no-color', '-U3', '--src-prefix=a/', '--dst-prefix=b/', ...common],
          index,
        ),
      ]);
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
    const counts = parseNumstat(numstat);
    const entries = parseRaw(raw)
      .filter((r) => !r.skipped)
      .map((r) => ({
        ...r,
        ...(counts.get(r.path) ?? { additions: 0, deletions: 0, binary: false }),
      }));
    return entries.length ? parsePatch(patch, entries) : [];
  }

  /**
   * Os ficheiros em que o trabalho de duas worktrees chocaria se se juntasse agora (um merge de
   * mentira, sem escrever em nenhum branch). Conta o que cada uma tem por gravar: cada estado
   * vira um commit solto, feito num índice temporário, sem tocar nos branches nem no índice dos
   * agentes. Sem conflitos, devolve uma lista vazia.
   */
  async collisions(a: Worktree, b: Worktree): Promise<string[]> {
    const [left, right] = await Promise.all([this.#snapshot(a), this.#snapshot(b)]);
    const merged = await this.#run(
      a.top,
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', left, right],
      true,
    );
    if (merged.code === 0) return [];
    if (merged.code !== 1) throw new Error(`git merge-tree: código ${merged.code}`);
    // <árvore>\0<ficheiro>\0…\0\0: os ficheiros em conflito vêm logo a seguir à árvore.
    const names: string[] = [];
    for (const token of merged.out.split('\0').slice(1)) {
      if (!token) break;
      names.push(token);
    }
    return [...new Set(names)];
  }

  /** O estado atual da worktree (com o que está por gravar) num commit solto, filho do HEAD. */
  async #snapshot(wt: Worktree): Promise<string> {
    const file = `${wt.path}.${randomBytes(8).toString('hex')}.index`;
    const index = { GIT_INDEX_FILE: file };
    try {
      await this.#run(wt.path, ['read-tree', 'HEAD'], false, index);
      await this.#run(wt.path, ['add', '-A'], false, index);
      const tree = (await this.#run(wt.path, ['write-tree'], false, index)).out.trim();
      const { out } = await this.#run(
        wt.path,
        [
          '-c',
          'user.name=Solline',
          '-c',
          'user.email=solline@localhost',
          '-c',
          'commit.gpgsign=false',
          'commit-tree',
          tree,
          '-p',
          'HEAD',
          '-m',
          'Solline: estado temporário',
        ],
        false,
        index,
      );
      return out.trim();
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  /** Como #run, mas devolve os bytes (o patch volta ao git tal como saiu). */
  async #runBuffer(cwd: string, args: string[], extraEnv: Record<string, string>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(
        this.#git,
        ['-c', 'core.quotepath=false', ...args],
        {
          cwd,
          env: { ...gitEnv(), ...extraEnv },
          windowsHide: true,
          timeout: TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'buffer',
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  }

  /** O que a sessão mudou desde a base, contando os ficheiros por gravar e os novos. */
  async stats(wt: Worktree): Promise<WorktreeStats> {
    // Cada contagem tem o seu índice: atualizar o cabeçalho e fechar uma sessão podem
    // contar ao mesmo tempo. Um read-tree partilhado apagava as mudanças da outra contagem.
    const file = `${wt.path}.${randomBytes(8).toString('hex')}.index`;
    const index = { GIT_INDEX_FILE: file };
    let out: string;
    try {
      await this.#run(wt.path, ['read-tree', 'HEAD'], false, index);
      await this.#run(wt.path, ['add', '-A'], false, index);
      ({ out } = await this.#run(
        wt.path,
        ['diff', '--cached', '--numstat', wt.base],
        false,
        index,
      ));
    } finally {
      await rm(file, { force: true });
    }
    let files = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of out.split('\n')) {
      const [a, d] = line.split('\t');
      if (a === undefined || d === undefined) continue;
      files++;
      additions += Number(a) || 0;
      deletions += Number(d) || 0;
    }
    return { files, additions, deletions };
  }

  /**
   * Traz o trabalho para o projeto: grava as mudanças da worktree num commit e faz merge no
   * branch atual do projeto. Com conflitos, desfaz o merge no projeto e devolve a lista.
   */
  async bring(wt: Worktree, message: string): Promise<{ result: BringResult; wt: Worktree }> {
    const into = (await this.#run(wt.top, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
    // Num commit solto, o merge ficava fora de qualquer branch e perdia-se depois.
    if (into === 'HEAD') {
      throw new Error('O projeto não está num branch: muda para um antes de trazer.');
    }
    await this.commitAll(wt, message);
    const merge = await this.#run(
      wt.top,
      ['merge', '--no-ff', '--no-edit', '-m', `Trazer ${wt.branch}`, wt.branch],
      true,
    );
    if (merge.code !== 0) {
      const { out } = await this.#run(wt.top, ['diff', '--name-only', '--diff-filter=U'], true);
      const conflicts = out.split('\n').filter(Boolean);
      await this.#run(wt.top, ['merge', '--abort'], true);
      if (conflicts.length === 0)
        throw new Error('O projeto tem mudanças por gravar que o merge pisaria');
      return { result: { merged: false, conflicts, into }, wt };
    }
    const head = (await this.#run(wt.path, ['rev-parse', 'HEAD'])).out.trim();
    const next = { ...wt, base: head };
    await this.#save(next);
    return { result: { merged: true, conflicts: [], into }, wt: next };
  }

  /**
   * Junta um branch na worktree (merge sem avanço rápido, num commit só seu). Com conflitos, apanha
   * os ficheiros e desfaz o merge: a worktree fica limpa, como estava. Quem chama grava antes o
   * que a worktree da parte tem por gravar (só o que está em commit entra no merge).
   */
  async mergeBranch(
    tip: Worktree,
    branch: string,
    message: string,
  ): Promise<{ merged: boolean; conflicts: string[] }> {
    // Uma worktree por gravar não se mistura com o merge: gravar primeiro, nunca perder nada.
    await this.commitAll(tip, 'Solline: estado antes de juntar');
    const email = await this.#run(tip.path, ['config', 'user.email'], true);
    const identity =
      email.code === 0 && email.out.trim()
        ? []
        : ['-c', 'user.name=Solline', '-c', 'user.email=solline@localhost'];
    const merge = await this.#run(
      tip.path,
      [...identity, 'merge', '--no-ff', '--no-edit', '-m', message, branch],
      true,
    );
    if (merge.code === 0) return { merged: true, conflicts: [] };
    const { out } = await this.#run(tip.path, ['diff', '--name-only', '--diff-filter=U'], true);
    const conflicts = out.split('\n').filter(Boolean);
    await this.#run(tip.path, ['merge', '--abort'], true);
    if (conflicts.length === 0)
      throw new Error(`Não consegui juntar ${branch}: o merge falhou sem conflitos.`);
    return { merged: false, conflicts };
  }

  /** O branch já está todo no HEAD desta worktree (um merge dele já aconteceu). */
  async contains(wt: Pick<Worktree, 'path'>, branch: string): Promise<boolean> {
    const r = await this.#run(wt.path, ['merge-base', '--is-ancestor', branch, 'HEAD'], true);
    return r.code === 0;
  }

  /** A worktree não tem nada por gravar (ficheiros ignorados pelo git não contam). */
  async isClean(wt: Pick<Worktree, 'path'>): Promise<boolean> {
    const { out } = await this.#run(wt.path, ['status', '--porcelain'], true);
    return out.trim() === '';
  }

  /**
   * Uma pasta com o código da base da worktree (antes da mudança), para o Verificador comparar.
   * As dependências não estão no git: liga-se o node_modules da worktree (junção no Windows).
   */
  async baseline(wt: Worktree): Promise<{ cwd: string; dispose: () => Promise<void> }> {
    const dir = path.join(this.#root, '.base', randomBytes(4).toString('hex'));
    await mkdir(path.dirname(dir), { recursive: true });
    await this.#run(wt.top, ['worktree', 'add', '--quiet', '--detach', dir, wt.base]);
    const rel = path.relative(wt.path, wt.cwd);
    const cwd = path.join(dir, rel);
    await this.#linkDependencies(wt.cwd, cwd);
    return {
      cwd,
      dispose: async () => {
        await this.#run(wt.top, ['worktree', 'remove', '--force', dir], true);
        await rm(dir, { recursive: true, force: true });
        await this.#run(wt.top, ['worktree', 'prune'], true);
      },
    };
  }

  /** O node_modules de uma worktree ligado noutra pasta (junção no Windows), se existir. */
  async linkDependencies(from: Worktree, to: Worktree): Promise<void> {
    await this.#linkDependencies(from.cwd, to.cwd);
  }

  async #linkDependencies(fromCwd: string, toCwd: string): Promise<void> {
    const deps = path.join(fromCwd, 'node_modules');
    const exists = await stat(deps).then(
      () => true,
      () => false,
    );
    if (exists)
      await symlink(deps, path.join(toCwd, 'node_modules'), 'junction').catch(() => undefined);
  }

  /**
   * Aplica patches (um por pedaço, em bytes) à worktree, no índice e nos ficheiros. Cada um tem
   * de encaixar tal como saiu do diff; se um não encaixar, para e diz qual.
   */
  async apply(wt: Worktree, patches: readonly { label: string; patch: Buffer }[]): Promise<void> {
    const file = `${wt.path}.${randomBytes(4).toString('hex')}.patch`;
    try {
      for (const { label, patch } of patches) {
        await writeFile(file, patch);
        await this.#run(wt.path, ['apply', '--index', '--whitespace=nowarn', file]).catch(
          (error: unknown) => {
            throw new Error(
              `O pedaço de ${label} não encaixa: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        );
      }
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  /** Destes nomes (relativos a `dir`), os que o .gitignore do projeto ignora. */
  async ignored(dir: string, names: readonly string[]): Promise<Set<string>> {
    if (names.length === 0) return new Set();
    const { out } = await this.#run(dir, ['check-ignore', '--', ...names], true);
    return new Set(out.split('\n').filter(Boolean));
  }

  /** Grava num commit tudo o que a worktree tem por gravar (nada, se estiver limpa). */
  async commitAll(wt: Worktree, message: string): Promise<void> {
    await this.#run(wt.path, ['add', '-A']);
    const staged = await this.#run(wt.path, ['diff', '--cached', '--quiet'], true);
    if (staged.code !== 0) await this.#commit(wt.path, message);
  }

  /** Destes nomes (relativos a `dir`), os que o git do projeto versiona. */
  async tracked(dir: string, names: readonly string[]): Promise<Set<string>> {
    if (names.length === 0) return new Set();
    const { out } = await this.#run(dir, ['ls-files', '--', ...names], true);
    return new Set(out.split('\n').filter(Boolean));
  }

  /** O branch já está todo no branch atual do projeto (nada se perde ao apagá-lo). */
  async merged(wt: Pick<Worktree, 'top' | 'branch'>): Promise<boolean> {
    const r = await this.#run(wt.top, ['merge-base', '--is-ancestor', wt.branch, 'HEAD'], true);
    return r.code === 0;
  }

  /**
   * Tira a worktree. branch: 'always' apaga o branch (deitar fora), 'if-merged' só se já estiver
   * no projeto, 'keep' guarda-o. Na dúvida, o branch fica.
   */
  async remove(
    wt: Pick<Worktree, 'path' | 'top' | 'branch'>,
    branch: 'always' | 'if-merged' | 'keep',
  ): Promise<void> {
    const drop = branch === 'always' || (branch === 'if-merged' && (await this.merged(wt)));
    await this.#run(wt.top, ['worktree', 'remove', '--force', wt.path], true);
    await rm(wt.path, { recursive: true, force: true });
    await this.#run(wt.top, ['worktree', 'prune'], true);
    if (drop) await this.#run(wt.top, ['branch', '-D', wt.branch], true);
    await rm(`${wt.path}.json`, { force: true });
    await rm(`${wt.path}.index`, { force: true });
  }

  /** As worktrees no disco que nenhuma sessão aberta usa (ficaram de outra vez). */
  async orphans(known: ReadonlySet<string>): Promise<Worktree[]> {
    const found: Worktree[] = [];
    const projects = await readdir(this.#root).catch(() => [] as string[]);
    for (const projectId of projects) {
      const dir = path.join(this.#root, projectId);
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const file of files.filter((f) => f.endsWith('.json'))) {
        const wtPath = path.join(dir, file.slice(0, -5));
        if (known.has(wtPath)) continue;
        const exists = await stat(wtPath).then(
          (s) => s.isDirectory(),
          () => false,
        );
        if (!exists) continue;
        try {
          const meta = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as Meta;
          found.push({ ...meta, path: wtPath });
        } catch {
          // Um ficheiro estragado não esconde os outros.
        }
      }
    }
    return found;
  }

  /** Os +/− de uma worktree sem a tocar se já não existir. */
  async statsOrNone(wt: Worktree): Promise<WorktreeStats> {
    return this.stats(wt).catch(() => NO_STATS);
  }

  async #commit(cwd: string, message: string): Promise<void> {
    const email = await this.#run(cwd, ['config', 'user.email'], true);
    // Sem identidade no git, o commit sai em nome da Solline em vez de falhar.
    const identity =
      email.code === 0 && email.out.trim()
        ? []
        : ['-c', 'user.name=Solline', '-c', 'user.email=solline@localhost'];
    await this.#run(cwd, [...identity, 'commit', '--quiet', '-m', message]);
  }

  async #save(wt: Worktree): Promise<void> {
    const meta: Meta = {
      branch: wt.branch,
      base: wt.base,
      top: wt.top,
      cwd: wt.cwd,
      projectId: wt.projectId,
      suffix: wt.suffix,
    };
    await writeFile(`${wt.path}.json`, JSON.stringify(meta, null, 2));
  }
}
