import type {
  CheckSpec,
  Checks,
  FileDiff,
  Quality,
  ReviewScope,
  ReviewTrigger,
} from '@solline/protocol';
import { ProjectChecks, checkFixMessage } from '../checks/project-checks.ts';
import type { RunCommand } from '../checks/run.ts';
import { draftFilesOf } from '../handoff/drafter.ts';
import { reviewWorth } from '../quality/gating.ts';
import type { Reviewer } from '../quality/reviewer.ts';
import { NO_REVIEW, fixMessage } from '../quality/session-quality.ts';
import { RepairLoop } from '../repair/loop.ts';
import { renderStart } from '../rules/render.ts';
import { PortAllocator } from '../workspace/ports.ts';
import { reviewerRequestFor, syncTaskState } from './task-state.ts';
import type { SessionEntry, SessionHost } from './types.ts';

/**
 * Coordena verificações do projeto, ciclo automático de reparação e segunda opinião (revisor).
 * Garante que o revisor lê o `originalIntent` real em vez de resumos escritos por outros modelos.
 */
export class SessionQualityCoordinator {
  readonly #host: SessionHost;

  constructor(host: SessionHost) {
    this.#host = host;
  }

  /**
   * A confiança de um projeto mudou no main. As sessões abertas continuam como arrancaram;
   * a próxima retoma já usa a confiança nova, para os dois lados.
   */
  setProjectTrust(projectId: string, trusted: boolean): void {
    for (const entry of this.#host.sessions.values()) {
      if (entry.info.projectId === projectId) entry.trusted = trusted;
    }
    // As verificações seguem a confiança já: sem ela, nada corre a partir de agora.
    for (const checks of this.#checksOf(projectId)) checks.setTrusted(trusted);
  }

  /** As verificações de um projeto mudaram no main (já com a tua confirmação). */
  async setProjectChecks(projectId: string, checks: CheckSpec[] | null): Promise<void> {
    await Promise.all(this.#checksOf(projectId).map((c) => c.configure(checks)));
  }

  #checksOf(projectId: string): ProjectChecks[] {
    return [...this.#host.checks.entries()]
      .filter(([cwd]) => this.#host.checkProjects.get(cwd) === projectId)
      .map(([, checks]) => checks);
  }

  checks(sessionId: string): Checks {
    return this.#projectChecks(sessionId).state;
  }

  /** Volta a correr as verificações agora; o resultado chega por session.checks. */
  async runChecks(sessionId: string): Promise<Checks> {
    const checks = this.#projectChecks(sessionId);
    if (!checks.state.trusted)
      throw new Error('As verificações só correm em projetos de confiança');
    const last = this.#host.memoryOf(sessionId).checkpoints?.timeline().checkpoints.at(-1);
    void checks.run(last?.state === 'done' ? last.turnId : null, { manual: true });
    return checks.state;
  }

  /** Manda a falha de uma verificação ao agente da sessão. */
  async fixCheck(sessionId: string, id: string): Promise<string> {
    const failure = this.#projectChecks(sessionId).failure(id);
    if (!failure) throw new Error('Essa verificação já não está a falhar');
    return (await this.#host.send(sessionId, checkFixMessage(failure.spec, failure.result)))
      .turnId;
  }

  #projectChecks(sessionId: string): ProjectChecks {
    const { info } = this.#host.get(sessionId);
    const checks = this.#host.checks.get(info.cwd);
    if (!checks) throw new Error('As verificações não estão disponíveis');
    return checks;
  }

  /** Abre (uma vez por pasta) as verificações e espalha cada mudança pelas sessões de lá. */
  checksFor(
    projectId: string,
    cwd: string,
    trusted: boolean,
    saved: CheckSpec[] | null,
    port?: number,
  ): void {
    if (!this.#host.checksOptions || this.#host.checks.has(cwd)) return;
    const checks = new ProjectChecks({
      cwd,
      saved,
      trusted,
      ...(port !== undefined ? { env: PortAllocator.env(port) } : {}),
      ...this.#host.checksOptions,
      emit: (state) => {
        for (const entry of this.#host.sessions.values()) {
          if (entry.info.cwd !== cwd) continue;
          this.#host.emit({
            kind: 'event',
            type: 'session.checks',
            sessionId: entry.info.id,
            checks: state,
          });
          void this.maybeRepair(entry.info.id, state);
        }
      },
    });
    this.#host.checks.set(cwd, checks);
    this.#host.checkProjects.set(cwd, projectId);
    void checks.refresh();
  }

  checkContext(sessionId: string): {
    specs: CheckSpec[];
    env: Record<string, string>;
    run: RunCommand | undefined;
  } {
    const { info } = this.#host.get(sessionId);
    const state = this.#host.checks.get(info.cwd)?.state;
    return {
      specs: state?.trusted ? state.specs.filter((s) => s.enabled) : [],
      env: info.port !== undefined ? PortAllocator.env(info.port) : {},
      run: this.#host.checksOptions?.run,
    };
  }

  quality(sessionId: string): Quality {
    this.#host.get(sessionId);
    return (
      this.#host.memoryOf(sessionId).quality?.state ?? {
        available: false,
        enabled: false,
        review: NO_REVIEW,
        stats: { fixed: 0, dismissed: 0, total: 0 },
      }
    );
  }

  setQualityEnabled(sessionId: string, enabled: boolean): Quality {
    this.#host.get(sessionId);
    const quality = this.#host.memoryOf(sessionId).quality;
    if (!quality) throw new Error('A segunda opinião não está disponível');
    return quality.setEnabled(enabled);
  }

  /**
   * Revê agora: o último turno com checkpoint (por omissão) ou, com scope 'session', tudo o que
   * a sessão mudou. A pedido ('manual') e antes de trazer ('bring') revê sempre, sem o limiar
   * das 20 linhas.
   */
  async reviewNow(
    sessionId: string,
    how: { trigger?: ReviewTrigger | undefined; scope?: ReviewScope | undefined } = {},
  ): Promise<Quality> {
    this.#host.get(sessionId);
    const memory = this.#host.memoryOf(sessionId);
    if (!memory.quality) throw new Error('A segunda opinião não está disponível');
    const last = memory.checkpoints?.timeline().checkpoints.at(-1);
    if (!last || last.state !== 'done') throw new Error('Ainda não há nenhum turno acabado');
    // Não espera pelo fim (uma revisão leva segundos); o resultado chega por session.quality.
    const trigger = how.trigger === 'turn' ? 'manual' : (how.trigger ?? 'manual');
    void this.review(sessionId, last.turnId, { trigger, scope: how.scope ?? 'turn' }).catch(
      (error) => this.#host.backgroundFailure(sessionId, error),
    );
    return memory.quality.state;
  }

  /** Pede ao agente da sessão para corrigir os achados escolhidos. */
  async fix(sessionId: string, ids: readonly string[]): Promise<string> {
    const quality = this.#host.memoryOf(sessionId).quality;
    const findings = quality?.pick(ids) ?? [];
    if (!quality || findings.length === 0) throw new Error('Esses achados já não existem');
    const { turnId } = await this.#host.send(sessionId, fixMessage(findings));
    quality.resolve(
      findings.map((f) => f.id),
      'fixed',
    );
    return turnId;
  }

  /** Descarta achados: ficam marcados (e contados) e a interface deixa de os mostrar. */
  dismiss(sessionId: string, ids: readonly string[]): Quality {
    this.#host.get(sessionId);
    const quality = this.#host.memoryOf(sessionId).quality;
    if (!quality) throw new Error('A segunda opinião não está disponível');
    if (quality.pick(ids).length === 0) throw new Error('Esses achados já não existem');
    return quality.resolve(ids, 'dismissed');
  }

  /**
   * A segunda opinião sobre um turno (ou, com scope 'session', sobre tudo o que a sessão mudou).
   * No fim de um turno só se revê o que vale a pena (20 linhas ou mais, ou um caminho sensível);
   * a pedido e antes de trazer revê-se sempre. Uma falha fica no estado, nunca como "limpo".
   */
  async review(
    sessionId: string,
    turnId: string,
    how: { trigger: ReviewTrigger; scope: ReviewScope } = { trigger: 'turn', scope: 'turn' },
  ): Promise<void> {
    const entry = this.#host.sessions.get(sessionId);
    const memory = this.#host.memory.get(sessionId);
    const checkpoints = memory?.checkpoints;
    if (!entry || !memory?.quality || !checkpoints?.available) return;
    const timeline = checkpoints.timeline().checkpoints;
    const whole = how.scope === 'session';
    if (!whole) {
      const checkpoint = timeline.find((c) => c.turnId === turnId);
      if (!checkpoint || checkpoint.stats.files === 0) return;
    }
    const worktrees = this.#host.worktrees;
    const worktree = memory.worktree;
    const diffOf = async (): Promise<FileDiff[]> =>
      whole
        ? worktree && worktrees
          ? (await worktrees.diff(worktree)).map((f) => f.diff)
          : checkpoints.diff({ kind: 'session' })
        : checkpoints.diff({ kind: 'turn', turnId });
    // Só os turnos pequenos e banais saem aqui em silêncio (o estado e os achados anteriores ficam).
    // Uma falha ao calcular o diff não se esconde: segue e chega ao estado como erro.
    let ready: { diff: FileDiff[] } | { error: unknown } | undefined;
    if (how.trigger === 'turn') {
      try {
        const diff = await diffOf();
        if (!reviewWorth(diff).worth) return;
        ready = { diff };
      } catch (error) {
        ready = { error };
      }
    }
    const reviewer = await this.#reviewerOf(entry);
    if (!reviewer) return;
    const completed = this.#host.beforeEffect('quality.run', sessionId);
    const request = reviewerRequestFor(memory.taskState, memory.turns, turnId, whole);
    await memory.quality.review(
      turnId,
      async () => {
        if (ready && 'error' in ready) throw ready.error;
        const diff = ready?.diff ?? (await diffOf());
        if (diff.length === 0) return null;
        if (whole) {
          memory.taskState = syncTaskState(memory.taskState, {
            files: draftFilesOf(diff),
          });
        }
        const rules = this.#startupRules(entry.info.projectId);
        return { cwd: entry.info.cwd, diff, request, rules };
      },
      {
        trigger: how.trigger,
        ...(reviewer.vendor
          ? {
              reviewer: {
                vendor: reviewer.vendor,
                ...(reviewer.model ? { model: reviewer.model } : {}),
                sameVendor: entry.info.agent === reviewer.vendor,
              },
            }
          : {}),
      },
      reviewer,
    );
    completed();
  }

  /** As verificações do projeto depois de um turno que mudou ficheiros. */
  async check(sessionId: string, turnId: string): Promise<void> {
    const entry = this.#host.sessions.get(sessionId);
    const checkpoint = this.#host.memory
      .get(sessionId)
      ?.checkpoints?.timeline()
      .checkpoints.find((c) => c.turnId === turnId);
    // As pistas de uma corrida verificam-se quando a corrida as ordena (com a base ao lado).
    if (!entry || entry.info.raceId || !checkpoint || checkpoint.stats.files === 0) return;
    // Um turno novo pode ter começado enquanto o checkpoint fechava: não verificar a meio dele.
    const memory = this.#host.memory.get(sessionId);
    if (
      memory?.openTurn ||
      memory?.cycle.busy ||
      memory?.cycle.queue.items.length ||
      entry.info.state !== 'idle'
    )
      return;
    const checks = this.#host.checks.get(entry.info.cwd);
    if (!checks) return;
    const completed = this.#host.beforeEffect('checks.autoRun', sessionId);
    await checks.run(turnId);
    completed();
  }

  async #reviewerOf(entry: SessionEntry): Promise<Reviewer | undefined> {
    return this.#host.pickReviewer
      ? this.#host.pickReviewer(entry.info.agent, entry.trusted)
      : this.#host.reviewer;
  }

  #startupRules(projectId: string): string | undefined {
    if (!this.#host.rules) return undefined;
    return renderStart(this.#host.rules.deliver(projectId), {
      target: 'instructions',
      readTool: true,
    });
  }

  setRepair(sessionId: string, enabled: boolean): ReturnType<RepairLoop['view']> {
    this.#host.get(sessionId);
    const loop = this.repairOf(sessionId);
    loop.setEnabled(enabled);
    this.emitRepair(sessionId);
    if (enabled) {
      const checks = this.#host.checks.get(this.#host.get(sessionId).info.cwd);
      if (checks) void this.maybeRepair(sessionId, checks.state);
    }
    return loop.view();
  }

  cancelRepair(sessionId: string): ReturnType<RepairLoop['view']> {
    this.#host.get(sessionId);
    const loop = this.repairOf(sessionId);
    loop.cancel();
    this.emitRepair(sessionId);
    return loop.view();
  }

  async maybeRepair(sessionId: string, state: Checks): Promise<void> {
    const loop = this.#host.repairs.get(sessionId);
    if (!loop || !loop.view().enabled) return;
    const decision = loop.see({
      turnId: state.turnId,
      outcomes: state.results.map((result) => ({
        id: result.id,
        state: result.state,
        tail: result.tail,
      })),
    });
    this.emitRepair(sessionId);
    if (!decision.fixId) return;
    try {
      await this.fixCheck(sessionId, decision.fixId);
      loop.markSent();
      this.emitRepair(sessionId);
      const memory = this.#host.memory.get(sessionId);
      if (memory) {
        memory.taskState = syncTaskState(memory.taskState, {
          repairFixes: loop.view().fixes,
        });
      }
    } catch {
      // A mensagem não seguiu. Não conta como correção.
    }
  }

  repairOf(sessionId: string): RepairLoop {
    const existing = this.#host.repairs.get(sessionId);
    if (existing) return existing;
    const created = new RepairLoop();
    this.#host.repairs.set(sessionId, created);
    return created;
  }

  emitRepair(sessionId: string): void {
    const loop = this.#host.repairs.get(sessionId);
    if (!loop) return;
    this.#host.emit({ kind: 'event', type: 'session.repair', sessionId, repair: loop.view() });
  }
}
