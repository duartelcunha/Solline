import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConversationRewind } from '@solline/protocol';
import { ShadowGit } from './git.ts';
import { SessionCheckpoints } from './session-checkpoints.ts';

export interface CheckpointStoreOptions {
  /** Onde vivem os repositórios sombra. */
  root?: string | undefined;
  /** Executável do git; por omissão o do PATH. */
  git?: string | undefined;
}

/** As pastas de execuções anteriores saem ao fim deste tempo (as sessões não sobrevivem). */
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Um repositório sombra por pasta de projeto, partilhado pelas sessões dessa pasta: cada
 * sessão tem o seu índice, e os objetos repetidos guardam-se uma vez. Tudo vive numa pasta
 * desta execução do motor, porque as sessões ainda só existem em memória.
 * shortcut: quando as sessões passarem a ter histórico (M3), os checkpoints passam a refs
 * por sessão e a limpeza passa a gc.
 */
export class CheckpointStore {
  readonly #root: string;
  readonly #run: string;
  readonly #git: string | undefined;
  readonly #repos = new Map<string, Promise<void>>();

  constructor(options: CheckpointStoreOptions = {}) {
    this.#root = options.root ?? path.join(tmpdir(), 'solline-checkpoints');
    this.#run = path.join(this.#root, `run-${Date.now()}-${process.pid}`);
    this.#git = options.git;
    void this.#sweep();
  }

  open(
    sessionId: string,
    cwd: string,
    conversationRewind: () => ConversationRewind,
  ): SessionCheckpoints {
    const resolved = path.resolve(cwd);
    const key = createHash('sha1')
      .update(process.platform === 'linux' ? resolved : resolved.toLowerCase())
      .digest('hex')
      .slice(0, 16);
    const git = new ShadowGit({
      gitDir: path.join(this.#run, `${key}.git`),
      workTree: resolved,
      executable: this.#git,
    });
    let repoReady = this.#repos.get(key);
    if (!repoReady) {
      repoReady = git.init();
      // Uma falha no init deixa tentar de novo na próxima sessão.
      repoReady.catch(() => this.#repos.delete(key));
      this.#repos.set(key, repoReady);
    }
    return new SessionCheckpoints({ git, sessionId, repoReady, conversationRewind });
  }

  /** Apaga a pasta desta execução (ao fechar o motor). */
  async dispose(): Promise<void> {
    await rm(this.#run, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  /** Execuções antigas que não fecharam bem (o motor caiu, por exemplo). */
  async #sweep(): Promise<void> {
    const entries = await readdir(this.#root).catch(() => [] as string[]);
    const now = Date.now();
    for (const name of entries) {
      if (!name.startsWith('run-')) continue;
      const dir = path.join(this.#root, name);
      if (dir === this.#run) continue;
      const info = await stat(dir).catch(() => null);
      if (info && now - info.mtimeMs > STALE_MS) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
