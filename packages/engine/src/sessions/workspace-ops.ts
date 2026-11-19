import { isAbsolute, relative, resolve } from 'node:path';
import type { CheckSpec, Orphan, SetupState, Workspace } from '@solline/protocol';
import { runCommand, type RunCommand } from '../checks/run.ts';
import type { RawFile } from '../checkpoints/unified-diff.ts';
import { textOf } from '../review.ts';
import { verify, type CheckVerdict } from '../verify/verify.ts';
import { PortAllocator } from '../workspace/ports.ts';
import { SETUP_TIMEOUT_MS, copyEnvFiles, detectSetup, envFilesIn } from '../workspace/setup.ts';
import type { Worktree, WorktreeManager } from '../worktrees/worktrees.ts';
import {
  NO_STATS,
  type CloseSessionResult,
  type SessionEntry,
  type SessionHost,
  type SessionMemory,
} from './types.ts';

/**
 * Coordena pastas de sessão, worktrees git (colocação, branch, trazer, órfãs), preparação de
 * worktree, gravação de commit e push/PR.
 */
export class SessionWorkspaceCoordinator {
  readonly #host: SessionHost;
  #setHandedTo: ((sessionId: string, handedTo: string | null) => void) | undefined;

  constructor(host: SessionHost) {
    this.#host = host;
  }

  bindHandedTo(setter: (sessionId: string, handedTo: string | null) => void): void {
    this.#setHandedTo = setter;
  }

  /**
   * Onde trabalha uma sessão nova: a primeira de um projeto na pasta dele; com outra já lá, numa
   * worktree (se o projeto for git) ou na mesma pasta, marcada como partilhada.
   */
  async placeFor(
    projectId: string,
    projectPath: string,
    always = false,
    after?: string,
  ): Promise<{ cwd: string; workspace: Workspace; worktree?: Worktree; key: string }> {
    if (always) {
      // As pistas de uma corrida: cada uma na sua worktree, sempre (sem git não há corrida).
      // Uma parte que segue outra (repartição) parte do resultado dela, não do HEAD do projeto.
      const sibling = after
        ? (this.#host.memory.get(after)?.worktree ?? this.#host.anchors.get(after))
        : undefined;
      if (after && !sibling) throw new Error('A parte anterior já não está disponível.');
      const worktree = sibling
        ? await this.#host.worktrees?.createAfter(sibling)
        : await this.#host.worktrees?.create(projectPath, projectId);
      if (!worktree)
        throw new Error('As corridas precisam de um projeto git com pelo menos um commit');
      return {
        cwd: worktree.cwd,
        workspace: { kind: 'worktree', branch: worktree.branch, stats: NO_STATS },
        worktree,
        key: '',
      };
    }
    const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const slot = `${projectId}\0${norm(projectPath)}`;
    const taken =
      this.#host.placing.has(slot) ||
      [...this.#host.sessions.values()].some(
        (e) => e.info.projectId === projectId && norm(e.info.cwd) === norm(projectPath),
      );
    if (!taken) {
      // Reservada já, antes de qualquer espera: a segunda sessão a chegar vai para uma worktree.
      this.#host.placing.add(slot);
      return { cwd: projectPath, workspace: { kind: 'project' }, key: slot };
    }
    const worktree = await this.#host.worktrees?.create(projectPath, projectId).catch((error) => {
      console.error('[worktrees] não consegui criar a worktree:', error);
      return null;
    });
    if (!worktree) return { cwd: projectPath, workspace: { kind: 'shared' }, key: '' };
    return {
      cwd: worktree.cwd,
      workspace: { kind: 'worktree', branch: worktree.branch, stats: NO_STATS },
      worktree,
      key: '',
    };
  }

  async nameBranch(sessionId: string, text: string): Promise<void> {
    const memory = this.#host.memory.get(sessionId);
    if (!memory?.worktree || !this.#host.worktrees) return;
    try {
      memory.worktree = await this.#host.worktrees.rename(memory.worktree, text);
      await this.emitWorkspace(sessionId);
    } catch (error) {
      console.error('[worktrees] não consegui dar nome ao branch:', error);
    }
  }

  async emitWorkspace(sessionId: string): Promise<void> {
    const entry = this.#host.sessions.get(sessionId);
    const worktree = this.#host.memory.get(sessionId)?.worktree;
    if (!entry || !worktree || !this.#host.worktrees) return;
    const stats = await this.#host.worktrees.statsOrNone(worktree);
    const workspace: Workspace = { kind: 'worktree', branch: worktree.branch, stats };
    entry.info.workspace = workspace;
    this.#host.emit({ kind: 'event', type: 'session.workspace', sessionId, workspace });
  }

  /**
   * O resultado de uma pista, para a corrida o ordenar: o que mudou face à base e as verificações
   * do projeto (as que falham voltam a correr na base, para não culpar a pista do que já falhava).
   */
  async outcome(
    sessionId: string,
    checkContext: {
      specs: CheckSpec[];
      env: Record<string, string>;
      run: RunCommand | undefined;
    },
    signal?: AbortSignal,
  ): Promise<{ cwd: string; files: RawFile[]; checks: CheckVerdict[] }> {
    const { info } = this.#host.get(sessionId);
    // O nome do branch ainda está a correr um git. O diff a seguir usa o mesmo
    // repositório: esperar evita dois cadeados e um git parado até ao timeout.
    await this.#host.memory.get(sessionId)?.naming;
    const worktree = this.worktreeOf(sessionId);
    const worktrees = this.#host.worktrees;
    if (!worktree || !worktrees) throw new Error('Esta sessão não tem worktree');
    const files = await worktrees.diff(worktree);
    const { specs, env, run } = checkContext;
    const checks =
      files.length === 0 || specs.length === 0
        ? []
        : await verify(info.cwd, {
            specs,
            baseline: () => worktrees.baseline(worktree),
            env,
            ...(run ? { run } : {}),
            ...(signal ? { signal } : {}),
          });
    return { cwd: info.cwd, files, checks };
  }

  /** A worktree da sessão, se tiver uma. */
  worktreeOf(sessionId: string): Worktree | undefined {
    return this.#host.memory.get(sessionId)?.worktree;
  }

  /**
   * Grava a worktree com a mensagem do utilizador. Os hooks do projeto correm.
   * Não faz merge nem push. Sem email no git, falha e pede a identidade.
   */
  async saveCommit(sessionId: string, message: string): Promise<{ sha: string | null }> {
    const entry = this.#host.get(sessionId);
    const memory = this.#host.memoryOf(sessionId);
    this.#host.requireActive(entry);
    this.#host.requireIdle(entry, memory, 'gravar');
    const worktree = memory.worktree;
    if (!worktree || !this.#host.worktrees) throw new Error('Gravar só numa worktree.');
    const saved = await this.#host.worktrees.commitMessage(worktree, message);
    await this.emitWorkspace(sessionId);
    return saved;
  }

  /** Repositório e branch, para a confirmação. Não envia nada. */
  async pullTarget(sessionId: string): Promise<{ repo: string; branch: string }> {
    const worktree = this.#pullWorktree(sessionId);
    return { repo: await this.#requireWorktrees().remoteRepo(worktree), branch: worktree.branch };
  }

  /** Envia o branch da worktree. O PR abre-se depois, e só se a confirmação já passou. */
  async pushPull(sessionId: string): Promise<{ cwd: string; branch: string }> {
    const entry = this.#host.get(sessionId);
    const memory = this.#host.memoryOf(sessionId);
    this.#host.requireActive(entry);
    this.#host.requireIdle(entry, memory, 'enviar o branch');
    const worktree = this.#pullWorktree(sessionId);
    await this.#requireWorktrees().pushBranch(worktree);
    return { cwd: worktree.path, branch: worktree.branch };
  }

  #pullWorktree(sessionId: string): Worktree {
    const worktree = this.#host.memoryOf(sessionId).worktree;
    if (!worktree) throw new Error('Abrir o PR só numa worktree.');
    return worktree;
  }

  /** Traz o trabalho da worktree para o branch atual do projeto. */
  async bring(sessionId: string): Promise<{ merged: boolean; conflicts: string[]; into: string }> {
    const entry = this.#host.get(sessionId);
    const memory = this.#host.memoryOf(sessionId);
    this.#host.requireActive(entry);
    this.#host.requireIdle(entry, memory, 'trazer o trabalho');
    if (!memory.worktree || !this.#host.worktrees)
      throw new Error('Esta sessão trabalha na pasta do projeto');
    if (memory.closing) throw new Error('A sessão está a fechar');
    this.#requireProjectIdle(memory.worktree.top);
    const done = memory.cycle
      .exclusive('trazer o trabalho', () => this.#bring(sessionId, memory))
      .finally(() => {
        memory.bringing = undefined;
      });
    memory.bringing = done;
    return done;
  }

  async #bring(
    sessionId: string,
    memory: SessionMemory,
  ): Promise<{ merged: boolean; conflicts: string[]; into: string }> {
    await memory.naming;
    if (!memory.worktree || !this.#host.worktrees)
      throw new Error('Esta sessão trabalha na pasta do projeto');
    const first = memory.turns.find((t) => t.role === 'user');
    const title = (first ? textOf(first).split('\n')[0] : undefined)?.slice(0, 72) || 'sessão';
    const { result, wt } = await this.#host.worktrees.bring(memory.worktree, `Solline: ${title}`);
    memory.worktree = wt;
    const view = this.#host.recoveryViews.get(sessionId);
    if (view)
      view.conflicts = result.merged ? null : { files: result.conflicts, into: result.into };
    await this.emitWorkspace(sessionId);
    return result;
  }

  /**
   * Fecha a sessão. Uma worktree com mudanças por trazer pede escolha primeiro: trazer, guardar
   * o branch ou deitar fora. Sem mudanças (ou já trazida), a pasta e o branch saem.
   */
  async close(
    sessionId: string,
    choice?: 'bring' | 'keep' | 'discard',
    dropQueue = false,
  ): Promise<CloseSessionResult> {
    const entry = this.#host.get(sessionId);
    const memory = this.#host.memoryOf(sessionId);
    // A meio de uma passagem a worktree está a mudar de dono: fechar agora podia apagá-la.
    if (this.#host.handingOff.has(sessionId))
      throw new Error('A passagem de testemunho está a meio: espera que acabe.');
    const queued = memory.cycle.queue.items.length;
    if (queued > 0 && !dropQueue) return { closed: false, queued };
    // A fechar: um "Trazer" que comece agora recusa (não se apaga a worktree a meio dele).
    memory.closing = true;
    try {
      return await this.#close(sessionId, entry, memory, choice);
    } finally {
      memory.closing = false;
    }
  }

  async #close(
    sessionId: string,
    entry: SessionEntry,
    memory: SessionMemory,
    choice: 'bring' | 'keep' | 'discard' | undefined,
  ): Promise<CloseSessionResult> {
    await memory.bringing?.catch(() => undefined);
    await memory.naming;
    const worktree = memory.worktree;
    // Passagens de testemunho: quem a passou a esta sessão (os herdeiros) não pode ficar a apontar
    // para uma sessão fechada nem sem pasta. Se esta passou a outra, eles passam a apontar para
    // essa; se é esta que tem a pasta, ela volta ao primeiro herdeiro, com a worktree (que é dos
    // dois: nada se pergunta, nada se apaga) e os outros passam a apontar para ele.
    const heirs = [...this.#host.sessions.values()].filter(
      (other) => other.info.id !== sessionId && other.info.handedTo === sessionId,
    );
    const onward = entry.info.handedTo;
    const heir = onward ? undefined : heirs[0];
    const returns = Boolean(heir && worktree && !this.#host.memory.get(heir.info.id)?.worktree);
    if (worktree && this.#host.worktrees && !returns) {
      // Uma contagem que falha conta como "há mudanças": pergunta em vez de apagar.
      const stats = await this.#host.worktrees
        .stats(worktree)
        .catch(() => ({ files: 1, additions: 0, deletions: 0 }));
      if (stats.files > 0) {
        if (!choice) return { closed: false, stats };
        if (choice === 'bring') {
          memory.closing = false;
          const result = await this.bring(sessionId);
          memory.closing = true;
          if (!result.merged)
            return { closed: false, conflicts: result.conflicts, into: result.into };
        }
        if (choice === 'keep') {
          // Guardar o branch é guardar o trabalho: o que não está em commit grava-se antes.
          const first = memory.turns.find((t) => t.role === 'user');
          const title =
            (first ? textOf(first).split('\n')[0] : undefined)?.slice(0, 72) || 'sessão';
          await this.#host.worktrees.commitAll(worktree, `Solline: ${title}`);
        }
      }
    }
    // Só agora se sabe que fecha: a fila deita-se fora aqui, nunca antes.
    memory.cycle.clear();
    this.#host.sessions.delete(sessionId);
    this.#host.memory.delete(sessionId);
    this.#host.consult?.sessionClosed(sessionId);
    for (const other of heirs) {
      const to = onward ?? (other === heir ? null : (heir?.info.id ?? null));
      this.#setHandedTo?.(other.info.id, to === other.info.id ? null : to);
    }
    if (returns && heir && worktree) {
      const heirMemory = this.#host.memoryOf(heir.info.id);
      heirMemory.worktree = worktree;
      heirMemory.named = true;
      await this.emitWorkspace(heir.info.id);
    }
    memory.preparing?.abort();
    this.#host.ports.release(sessionId);
    entry.brain?.revoke();
    await entry.adapter.close().catch(() => undefined);
    memory.quality?.dispose();
    await memory.checkpoints?.dispose();
    const cwd = entry.info.cwd;
    if (![...this.#host.sessions.values()].some((e) => e.info.cwd === cwd)) {
      this.#host.checks.get(cwd)?.dispose();
      this.#host.checks.delete(cwd);
      this.#host.checkProjects.delete(cwd);
    }
    if (worktree && this.#host.worktrees && !returns) {
      const current = memory.worktree ?? worktree;
      const branch = choice === 'discard' ? 'always' : choice === 'keep' ? 'keep' : 'if-merged';
      await this.#host.worktrees.remove(current, branch).catch((error) => {
        console.error('[worktrees] não consegui tirar a worktree:', error);
      });
    }
    return { closed: true };
  }

  /** As worktrees que alguém usa: as das sessões abertas e as que outros reclamaram. */
  #open(): Set<string> {
    return new Set([
      ...[...this.#host.memory.values()].flatMap((m) => (m.worktree ? [m.worktree.path] : [])),
      ...this.#host.claimed(),
    ]);
  }

  async orphans(): Promise<Orphan[]> {
    const worktrees = this.#host.worktrees;
    if (!worktrees) return [];
    const found = await worktrees.orphans(this.#open());
    return Promise.all(
      found.map(async (wt) => ({
        id: `${wt.projectId}/${wt.suffix}`,
        projectId: wt.projectId,
        branch: wt.branch,
        stats: await worktrees.statsOrNone(wt),
      })),
    );
  }

  async #orphan(id: string): Promise<Worktree> {
    const wt = (await this.#host.worktrees?.orphans(this.#open()))?.find(
      (w) => `${w.projectId}/${w.suffix}` === id,
    );
    if (!wt) throw new Error('Essa worktree já não existe');
    return wt;
  }

  async bringOrphan(id: string): Promise<{ merged: boolean; conflicts: string[]; into: string }> {
    const worktrees = this.#requireWorktrees();
    const wt = await this.#orphan(id);
    this.#requireProjectIdle(wt.top);
    const { result, wt: next } = await worktrees.bring(wt, `Solline: ${wt.branch}`);
    if (result.merged) await worktrees.remove(next, 'if-merged');
    return result;
  }

  async discardOrphan(id: string): Promise<void> {
    await this.#requireWorktrees().remove(await this.#orphan(id), 'always');
  }

  /**
   * Trazer escreve na pasta do projeto: as sessões que lá trabalham têm de estar paradas, e as
   * verificações delas recomeçam do zero (os ficheiros mudaram por baixo).
   */
  #requireProjectIdle(top: string): void {
    const norm = (p: string) => resolve(p).toLowerCase();
    for (const e of this.#host.sessions.values()) {
      const m = this.#host.memory.get(e.info.id);
      if (!m || m.worktree) continue;
      const rel = relative(norm(top), norm(e.info.cwd));
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      this.#host.requireIdle(
        e,
        m,
        'trazer o trabalho para o projeto (há uma sessão a trabalhar lá)',
      );
      this.#host.checks.get(e.info.cwd)?.reset();
    }
  }

  #requireWorktrees(): WorktreeManager {
    if (!this.#host.worktrees) throw new Error('As worktrees estão desligadas');
    return this.#host.worktrees;
  }

  /**
   * Prepara a worktree de uma sessão: copia os .env da raiz e corre o comando do projeto (ou a
   * sugestão). O que escreveres entretanto espera na fila; uma falha não bloqueia a sessão.
   */
  async prepare(sessionId: string, projectPath: string, worktreeCwd: string): Promise<void> {
    const entry = this.#host.sessions.get(sessionId);
    const memory = this.#host.memory.get(sessionId);
    if (!entry || !memory) return;
    memory.preparing?.abort();
    const abort = new AbortController();
    memory.preparing = abort;
    const started = Date.now();
    const report = (setup: SetupState) => {
      entry.info.setup = setup;
      this.#host.emit({ kind: 'event', type: 'session.setup', sessionId, setup });
    };
    report({ state: 'running', tail: null, durationMs: null });
    try {
      const saved = this.#host.setups.get(entry.info.projectId);
      if (!saved) {
        // Sem preparação guardada: a sugestão (que o repo pode mudar num git pull) só corre
        // depois de a aprovares, uma vez, com a confirmação nativa do main.
        const suggestion = await detectSetup(projectPath);
        if (abort.signal.aborted) return;
        report({
          state: 'approval',
          command: suggestion.command,
          tail: null,
          durationMs: null,
        });
        return;
      }
      const spec = saved;
      if (spec.copyEnv && this.#host.worktrees) {
        const names = await envFilesIn(projectPath);
        // Só os que o git ignora: um .env não ignorado entraria no commit do "Trazer".
        const ignored = await this.#host.worktrees.ignored(projectPath, names);
        const skip = new Set(names.filter((n) => !ignored.has(n)));
        await copyEnvFiles(projectPath, worktreeCwd, skip);
      }
      if (abort.signal.aborted) return;
      let outcome: { state: 'passed' | 'failed' | 'timeout'; tail: string | null } = {
        state: 'passed',
        tail: null,
      };
      if (spec.command.trim()) {
        const run = this.#host.checksOptions?.run ?? runCommand;
        outcome = await run(spec.command, {
          cwd: worktreeCwd,
          signal: abort.signal,
          timeoutMs: SETUP_TIMEOUT_MS,
          env: {
            ...(entry.info.port !== undefined ? PortAllocator.env(entry.info.port) : {}),
            SOLLINE_ROOT_PATH: projectPath,
            SOLLINE_WORKSPACE_PATH: worktreeCwd,
          },
        });
      }
      if (abort.signal.aborted) return;
      report({
        state: outcome.state === 'passed' ? 'done' : 'failed',
        tail: outcome.tail,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      report({
        state: 'failed',
        tail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      });
    } finally {
      if (memory.preparing === abort) memory.preparing = undefined;
      // Pronta ou não, a fila segue: uma falha vê-se e repete-se, não bloqueia.
      if (!abort.signal.aborted && !entry.info.archived) memory.cycle.release();
    }
  }

  /** Volta a preparar a worktree da sessão. */
  async retrySetup(sessionId: string): Promise<void> {
    const entry = this.#host.get(sessionId);
    const memory = this.#host.memoryOf(sessionId);
    if (!memory.worktree) throw new Error('Esta sessão trabalha na pasta do projeto');
    if (!entry.trusted) throw new Error('Preparar só corre em projetos de confiança');
    const project = memory.worktree;
    const projectPath = resolve(project.top, relative(project.path, project.cwd));
    memory.cycle.hold();
    void this.prepare(sessionId, projectPath, project.cwd);
  }
}
