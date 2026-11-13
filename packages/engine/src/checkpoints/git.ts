import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Um git sombra: o repositório vive na pasta de dados da app e olha para a pasta do projeto
 * como árvore de trabalho. Nunca toca no .git do utilizador, no índice dele nem nos hooks:
 * só comandos de canalização, com a configuração global e de sistema desligadas.
 */

export interface GitResult {
  stdout: Buffer;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Ignorados sempre, além do .gitignore do projeto (que o git lê da árvore de trabalho). */
const DEFAULT_EXCLUDES = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.DS_Store',
  'Thumbs.db',
];

/**
 * Atributos com prioridade sobre os .gitattributes do projeto: guardar os bytes tal como
 * estão (sem conversão de fins de linha nem filtros como o LFS), para rebobinar dar o
 * ficheiro exato.
 */
const ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n';

/**
 * Configuração do repositório sombra, escrita de uma vez. Sem gc automático: os objetos dos
 * checkpoints não têm refs e vivem enquanto a pasta desta execução do motor existir.
 */
const CONFIG = `[core]
	repositoryformatversion = 0
	bare = true
	autocrlf = false
	safecrlf = false
	fsmonitor = false
	filemode = false
	ignoreCase = ${process.platform === 'linux' ? 'false' : 'true'}
	longpaths = true
	quotePath = false
	untrackedCache = false
[advice]
	addEmbeddedRepo = false
[gc]
	auto = 0
`;

const DEFAULT_TIMEOUT_MS = 60_000;

const MISSING = 'Não encontrei o git: instala o Git para ter checkpoints';

let resolved: string | null = null;

/**
 * O git do PATH como caminho absoluto, procurado só em pastas absolutas: nunca na pasta do
 * projeto, onde um repositório podia plantar um git.exe (o Windows procura primeiro na pasta
 * atual quando se passa só o nome). No Git for Windows, o git.exe da pasta cmd é um lançador que
 * arranca outro processo: vai-se direto ao binário verdadeiro, que custa metade a arrancar.
 */
export function resolveGit(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
): string | null {
  const win = process.platform === 'win32';
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, win ? 'git.exe' : 'git');
    if (!exists(candidate)) continue;
    if (win && path.basename(dir).toLowerCase() === 'cmd') {
      for (const flavour of ['ucrt64', 'mingw64', 'clangarm64']) {
        const real = path.join(dir, '..', flavour, 'bin', 'git.exe');
        if (exists(real)) return path.normalize(real);
      }
    }
    return candidate;
  }
  return null;
}

function defaultGit(): string | null {
  if (!resolved) resolved = resolveGit();
  return resolved;
}

export interface ShadowGitOptions {
  /** Pasta do repositório sombra (bare), na pasta de dados. */
  gitDir: string;
  /** Pasta do projeto. */
  workTree: string;
  /** Executável do git; por omissão o do PATH. */
  executable?: string | undefined;
  timeoutMs?: number | undefined;
}

export class ShadowGit {
  readonly gitDir: string;
  readonly workTree: string;
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #env: Record<string, string>;

  constructor(options: ShadowGitOptions) {
    this.gitDir = options.gitDir;
    this.workTree = options.workTree;
    this.#executable = options.executable ?? defaultGit() ?? '';
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#env = shadowEnv(this.gitDir, this.workTree);
  }

  /** O mesmo repositório sombra a olhar para outra pasta (os objetos são os mesmos). */
  withWorkTree(workTree: string): ShadowGit {
    return new ShadowGit({
      gitDir: this.gitDir,
      workTree,
      executable: this.#executable,
      timeoutMs: this.#timeoutMs,
    });
  }

  /** Cria o repositório (uma chamada ao git: cada uma custa ~100 ms no Windows). */
  async init(): Promise<void> {
    await mkdir(this.gitDir, { recursive: true });
    await this.run(['init', '--bare', '--quiet', this.gitDir], { bare: true });
    await writeFile(path.join(this.gitDir, 'config'), CONFIG);
    await mkdir(path.join(this.gitDir, 'info'), { recursive: true });
    await writeFile(path.join(this.gitDir, 'info', 'exclude'), DEFAULT_EXCLUDES.join('\n') + '\n');
    await writeFile(path.join(this.gitDir, 'info', 'attributes'), ATTRIBUTES);
  }

  /**
   * Corre o git com o ambiente sombra. index escolhe o ficheiro de índice (cada sessão e
   * cada uso tem o seu); bare corre sem árvore de trabalho.
   */
  run(
    args: readonly string[],
    options: {
      index?: string | undefined;
      input?: Buffer | string | undefined;
      bare?: boolean | undefined;
      /** Códigos de saída que não são erro (git diff --exit-code, por exemplo). */
      okCodes?: readonly number[] | undefined;
    } = {},
  ): Promise<GitResult> {
    const env: Record<string, string> = { ...this.#env };
    if (options.bare) delete env.GIT_WORK_TREE;
    if (options.index) env.GIT_INDEX_FILE = path.join(this.gitDir, options.index);
    const okCodes = options.okCodes ?? [0];
    if (!this.#executable) return Promise.reject(new GitError(MISSING, null, ''));
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, args, {
        cwd: options.bare ? this.gitDir : this.workTree,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new GitError(`git ${args[0]}: sem resposta em ${this.#timeoutMs / 1000} s`, null, err),
        );
      }, this.#timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        err = (err + chunk.toString('utf8')).slice(-4_000);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new GitError(`git não arrancou: ${error.message}`, null, err));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== null && okCodes.includes(code)) {
          resolve({ stdout: Buffer.concat(out), stderr: err });
        } else {
          const first = err.trim().split('\n')[0] ?? '';
          reject(new GitError(`git ${args[0]} falhou (${code}): ${first}`, code, err));
        }
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input ?? '');
    });
  }

  /**
   * Conta os ficheiros que um checkpoint guardaria (o .gitignore conta), sem passar do
   * limite: a contagem pára logo que o passa. Serve para recusar pastas enormes antes de as
   * copiar para o repositório sombra.
   */
  countFiles(limit: number, index: string): Promise<number> {
    const env: Record<string, string> = {
      ...this.#env,
      GIT_INDEX_FILE: path.join(this.gitDir, index),
    };
    if (!this.#executable) return Promise.reject(new GitError(MISSING, null, ''));
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.#executable,
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: this.workTree, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let count = 0;
      let settled = false;
      const done = (value: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        done(limit + 1);
      }, this.#timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        for (const byte of chunk) if (byte === 0) count++;
        if (count > limit) {
          child.kill();
          done(count);
        }
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new GitError(`git não arrancou: ${error.message}`, null, ''));
      });
      child.on('close', () => done(count));
    });
  }

  async text(
    args: readonly string[],
    options: Parameters<ShadowGit['run']>[1] = {},
  ): Promise<string> {
    return (await this.run(args, options)).stdout.toString('utf8').trim();
  }
}

/** O git existe nesta máquina? Devolve a versão ou null. Sem caminho, usa resolveGit(); um nome solto não corre. */
export async function gitVersion(executable?: string): Promise<string | null> {
  const git = executable ?? resolveGit();
  if (!git || !path.isAbsolute(git)) return null;
  try {
    const shadow = new ShadowGit({
      gitDir: process.cwd(),
      workTree: process.cwd(),
      executable: git,
    });
    return await shadow.text(['--version'], { bare: true });
  } catch {
    return null;
  }
}

/**
 * Sem nada do git do utilizador: tira as variáveis GIT_* do anfitrião, desliga a configuração
 * global e de sistema (hooksPath, fsmonitor, filtros, assinatura) e trata os caminhos como
 * literais.
 */
function shadowEnv(gitDir: string, workTree: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^GIT_/i.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workTree,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(gitDir, 'empty-global-config'),
    GIT_LITERAL_PATHSPECS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ATTR_NOSYSTEM: '1',
    LC_ALL: 'C',
    MSYS_NO_PATHCONV: '1',
    MSYS2_ARG_CONV_EXCL: '*',
  };
}
