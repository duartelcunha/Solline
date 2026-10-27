import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  IntegrationMetrics,
  IntegrationStep,
  Race,
  RaceIntegration,
  RaceLane,
  SessionState,
  SplitCheckRef,
} from '@solline/protocol';
import type { Reviewer } from '../quality/reviewer.ts';
import { failures, verify, type CheckVerdict } from '../verify/verify.ts';
import type { Worktree, WorktreeManager } from '../worktrees/worktrees.ts';
import type { CheckContext } from './assembler.ts';
import { STOPPED, type LaneProject, type LaneSessions, type SessionCreateResult } from './lanes.ts';

/**
 * A integração de uma repartição: as partes juntam-se uma a uma numa worktree própria (a ponta),
 * pela ordem de quem produz primeiro, e depois de cada uma correm as verificações dessa parte. Quem
 * decide são as verificações, não um modelo. Um conflito pára tudo com a ponta limpa; um modelo só
 * propõe a resolução (numa sessão normal que o Duarte vê) e a ponta só avança se o branch ficar
 * juntado e a verificação passar. No fim, as verificações todas e o revisor, com contexto limpo, lê
 * o diff integrado contra o pedido original. Nada arranca sozinho depois de um reinício.
 */

/** O que a integração precisa do SessionManager, além do que as pistas já usam. */
export interface IntegrationSessions extends LaneSessions {
  /** O que correr para verificar o trabalho desta sessão. */
  checkContext(sessionId: string): CheckContext;
  /** O último custo total que a sessão comunicou. */
  costOf(sessionId: string): number | null;
  /** Põe uma worktree à disposição de `startAfter` com esta chave. */
  anchor(key: string, worktree: Worktree): void;
  unanchor(key: string): void;
}

export type IntegrationWorktrees = Pick<
  WorktreeManager,
  | 'createFrom'
  | 'commitAll'
  | 'mergeBranch'
  | 'contains'
  | 'isClean'
  | 'linkDependencies'
  | 'baseline'
  | 'diff'
  | 'bring'
  | 'remove'
  | 'orphans'
>;

/** Uma pista na ordem de integração. */
export interface MergeLane {
  sessionId: string;
  title: string;
  agent: RaceLane['agent'];
  model: string | null;
  part: RaceLane['part'];
  index: number;
  after: number | null;
  zero: boolean;
}

/** O que se sabe da integração de uma repartição enquanto o motor está de pé. */
interface Live {
  /** A ponta atual: a worktree da integração ou, depois de um conflito, a de quem o resolveu. */
  tip: Worktree;
  /** O commit de onde as pistas partiram: o diff integrado conta-se face a ele. */
  base: string;
  /** As sessões de resolução abertas (fecham com a repartição). */
  resolvers: string[];
  /** Que sessão é dona de cada worktree que não é a original (pasta -> sessão). */
  owners: Map<string, string>;
  abort: AbortController;
}

const MAX_BRIEF = 240;

function brief(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_BRIEF ? flat : `${flat.slice(0, MAX_BRIEF - 1).trimEnd()}…`;
}

const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

/**
 * A ordem de juntar: a parte zero, depois cada parte de que outras dependem antes das que dela
 * partem, e as restantes por índice. Quem produz vem sempre antes de quem consome o que ele fez.
 */
export function mergeOrder<T extends Pick<MergeLane, 'index' | 'after' | 'zero'>>(
  lanes: readonly T[],
): T[] {
  const left = [...lanes].sort((a, b) => a.index - b.index);
  const done = new Set<number>();
  const ordered: T[] = [];
  while (left.length > 0) {
    const known = (index: number | null) =>
      index === null || done.has(index) || !left.some((l) => l.index === index);
    const ready = left.filter((l) => known(l.after));
    const pool = ready.length > 0 ? ready : left;
    const producer = (l: T) => left.some((o) => o !== l && o.after === l.index);
    const next = pool.find((l) => l.zero) ?? pool.find((l) => producer(l)) ?? (pool[0] as T);
    left.splice(left.indexOf(next), 1);
    done.add(next.index);
    ordered.push(next);
  }
  return ordered;
}

/** Os números da integração: custo somado, tempo (a mais lenta e a soma de todas), conflitos e falhas. */
export function integrationMetrics(
  race: Race,
  integration: Pick<RaceIntegration, 'steps' | 'final'>,
  costUsd: number | null,
): IntegrationMetrics {
  const spans = (race.split?.lanes ?? []).flatMap((lane) =>
    lane.settledAt === null ? [] : [Math.max(0, Math.round(lane.settledAt - lane.startedAt))],
  );
  return {
    costUsd,
    slowestMs: spans.length ? Math.max(...spans) : 0,
    totalMs: spans.reduce((sum, ms) => sum + ms, 0),
    conflicts: integration.steps.filter((s) => s.conflicts.length > 0).length,
    failures: integration.final
      ? integration.final.failures
      : integration.steps.reduce((sum, s) => sum + s.failures, 0),
  };
}

/**
 * O que sobrevive a um reinício: uma integração a meio ou pronta mas por trazer volta a "acabada"
 * (a worktree da ponta fica como órfã, que se traz ou se deita fora na lista); uma já trazida só
 * falta fechar; um conflito fica registado, mas a sessão que o resolvia já não existe.
 */
export function restoreIntegration(race: Race): void {
  const integration = race.integration;
  if (!integration) {
    if (race.phase === 'assembling' || race.phase === 'assembled') race.phase = 'done';
    return;
  }
  if (integration.state === 'brought' && integration.brought) {
    race.phase = 'assembled';
  } else if (integration.state === 'conflict') {
    if (integration.conflict) integration.conflict.resolver = null;
    race.phase = 'done';
  } else {
    race.integration = null;
    race.phase = 'done';
  }
}

export class Integration {
  readonly #sessions: IntegrationSessions;
  readonly #worktrees: IntegrationWorktrees;
  readonly #reviewer: Reviewer | undefined;
  readonly #changed: (race: Race) => void;
  readonly #live = new Map<string, Live>();
  readonly #busy = new Set<string>();
  /** O estado de cada sessão que se viu mudar (para saber quando a de resolução acabou). */
  readonly #states = new Map<string, { state: SessionState; started: boolean }>();
  #stopping = false;

  constructor(options: {
    sessions: IntegrationSessions;
    worktrees: IntegrationWorktrees;
    reviewer?: Reviewer | undefined;
    changed: (race: Race) => void;
  }) {
    this.#sessions = options.sessions;
    this.#worktrees = options.worktrees;
    this.#reviewer = options.reviewer;
    this.#changed = options.changed;
  }

  observe(event: { sessionId: string; state: SessionState }): void {
    const seen = this.#states.get(event.sessionId);
    this.#states.set(event.sessionId, {
      state: event.state,
      started: Boolean(seen?.started) || !STOPPED.has(event.state),
    });
  }

  /** Na paragem do motor as verificações param e nada novo se junta. */
  stop(): void {
    this.#stopping = true;
    for (const live of this.#live.values()) live.abort.abort();
  }

  /** As worktrees das pontas ainda em uso (não são órfãs). */
  paths(races: readonly Race[]): string[] {
    return races.flatMap((race) =>
      race.kind === 'split' && race.phase !== 'closed' && race.integration
        ? [race.integration.tip.path]
        : [],
    );
  }

  /**
   * Junta as partes pela ordem, uma a uma, com a verificação de cada uma. Pára no primeiro
   * conflito (a ponta fica no último estado bom) e devolve a repartição nesse estado.
   */
  async integrate(race: Race): Promise<Race> {
    return this.#guard(race, async () => {
      this.#requireIdle(race);
      if (race.integration) {
        throw new Error(
          race.integration.state === 'conflict'
            ? 'A integração parou num conflito: resolve-o e continua.'
            : 'Esta repartição já está integrada.',
        );
      }
      const pending = race.split?.pending ?? [];
      if (pending.length > 0) {
        const titles = pending.map((p) => `«${p.part.title}»`).join(', ');
        throw new Error(
          `Ainda há partes por arrancar (${titles}): lança-as ou fecha a repartição.`,
        );
      }
      if (race.lanes.length === 0) throw new Error('Não há nenhuma parte para integrar.');
      if (race.lanes.some((l) => !STOPPED.has(l.state)))
        throw new Error('Há partes ainda a trabalhar: espera que acabem.');
      const ordered = this.#ordered(race);
      for (const lane of ordered)
        if (!this.#sessions.worktreeOf(lane.sessionId))
          throw new Error(`A parte «${lane.title}» já não está aberta: não há o que juntar.`);
      const first = this.#sessions.worktreeOf((ordered[0] as MergeLane).sessionId) as Worktree;

      race.phase = 'assembling';
      this.#changed(race);
      let tip: Worktree | undefined;
      try {
        tip = await this.#worktrees.createFrom(first);
        await this.#worktrees.linkDependencies(first, tip).catch(() => undefined);
        const live: Live = {
          tip,
          base: first.base,
          resolvers: [],
          owners: new Map(),
          abort: new AbortController(),
        };
        this.#live.set(race.id, live);
        race.integration = {
          state: 'merging',
          tip: { branch: tip.branch, path: tip.path, top: tip.top, base: first.base },
          steps: [],
          conflict: null,
          final: null,
          review: null,
          warnings: [],
          metrics: integrationMetrics(race, { steps: [], final: null }, this.#cost(race, null)),
          brought: null,
        };
        this.#changed(race);
        await this.#run(race, live);
      } catch (error) {
        // Uma integração que nem arrancou não deixa nada para trás.
        this.#live.delete(race.id);
        race.integration = null;
        race.phase = 'done';
        if (tip) await this.#worktrees.remove(tip, 'always').catch(() => undefined);
        this.#changed(race);
        throw error;
      }
      return race;
    });
  }

  /**
   * Abre a sessão que resolve o conflito: uma sessão normal (visível, com quem a quiser guiar),
   * cuja worktree parte do estado atual da ponta. O agente é o de quem produz primeiro.
   */
  async resolve(
    race: Race,
    project: LaneProject,
    checks: readonly SplitCheckRef[] = [],
  ): Promise<{ race: Race; session: SessionCreateResult }> {
    return this.#guard(race, async () => {
      const integration = race.integration;
      if (!integration || integration.state !== 'conflict' || !integration.conflict)
        throw new Error('Não há nenhum conflito para resolver.');
      const conflict = integration.conflict;
      if (conflict.resolver)
        throw new Error('Já há uma sessão a resolver este conflito: fala com ela.');
      const live = await this.#liveOf(race);
      const lanes = this.#ordered(race);
      const clashing = lanes.find((l) => l.sessionId === conflict.sessionId);
      const mergedIds = new Set(integration.steps.filter((s) => s.merged).map((s) => s.sessionId));
      const merged = lanes.filter((l) => mergedIds.has(l.sessionId));
      const producer = lanes.find((l) => l.zero) ?? merged[0] ?? clashing;
      if (!producer || !clashing)
        throw new Error('As partes desta repartição já não estão disponíveis.');

      const key = `tip:${race.id}`;
      let created: SessionCreateResult;
      this.#sessions.anchor(key, this.#current(live));
      try {
        created = await this.#sessions.create({
          ...project,
          agent: producer.agent,
          ...(producer.model ? { model: producer.model } : {}),
          worktree: 'always',
          raceId: race.id,
          startAfter: key,
        });
      } finally {
        this.#sessions.unanchor(key);
      }
      const id = created.session.id;
      const own = this.#sessions.worktreeOf(id);
      if (own) live.owners.set(own.path, id);
      live.resolvers.push(id);
      const label = this.#checkLabel(clashing, checks);
      try {
        await this.#sessions.send(id, resolveMessage(race.text, clashing, conflict, merged, label));
      } catch (error) {
        live.resolvers.pop();
        if (own) live.owners.delete(own.path);
        await this.#sessions.close(id, 'discard', true).catch(() => undefined);
        throw error;
      }
      conflict.resolver = id;
      this.#changed(race);
      return { race, session: created };
    });
  }

  /**
   * Retoma depois de a sessão de resolução acabar: o merge tem de estar gravado (worktree limpa e
   * branch juntado). A ponta passa a ser a worktree dela, corre a verificação do passo e segue
   * com as partes que faltam.
   */
  async continue(race: Race): Promise<Race> {
    return this.#guard(race, async () => {
      const integration = race.integration;
      if (!integration || integration.state !== 'conflict' || !integration.conflict)
        throw new Error('Não há nenhum conflito a retomar.');
      const conflict = integration.conflict;
      const resolver = conflict.resolver;
      if (!resolver)
        throw new Error(
          'Ainda ninguém está a resolver o conflito: abre primeiro a sessão de resolução.',
        );
      const seen = this.#states.get(resolver);
      if (!seen?.started || !STOPPED.has(seen.state))
        throw new Error('A sessão de resolução ainda está a trabalhar: espera que acabe.');
      const own = this.#sessions.worktreeOf(resolver);
      if (!own) throw new Error('A sessão de resolução já não está aberta.');
      if (!(await this.#worktrees.isClean(own)))
        throw new Error(
          'A sessão de resolução ainda tem mudanças por gravar: pede-lhe que grave o merge num commit.',
        );
      if (!(await this.#worktrees.contains(own, conflict.branch)))
        throw new Error(
          `O branch «${conflict.branch}» ainda não foi juntado: pede à sessão de resolução que faça o merge e o grave.`,
        );
      const live = await this.#liveOf(race);
      const lane = this.#ordered(race).find((l) => l.sessionId === conflict.sessionId);
      const before = { integration: structuredClone(integration), phase: race.phase };
      race.phase = 'assembling';
      integration.state = 'merging';
      this.#changed(race);
      live.abort = new AbortController();
      let verdicts: CheckVerdict[];
      try {
        verdicts = lane ? await this.#verifyStep(lane, own, live.abort.signal) : [];
      } catch (error) {
        // Nada se perde: volta ao conflito como estava, com a sessão de resolução ainda lá.
        race.integration = before.integration;
        race.phase = before.phase;
        this.#changed(race);
        throw error;
      }
      if (live.abort.signal.aborted) return race;
      const old = live.tip;
      live.tip = own;
      live.owners.set(own.path, resolver);
      integration.tip = { ...integration.tip, branch: own.branch, path: own.path, top: own.top };
      const title = lane?.title ?? conflict.sessionId;
      const recorded = stepOf(title, conflict.sessionId, true, conflict.files, verdicts);
      const step = integration.steps.find((s) => s.sessionId === conflict.sessionId);
      if (step) Object.assign(step, recorded);
      else integration.steps.push(recorded);
      integration.conflict = null;
      this.#changed(race);
      await this.#retire(live, old);
      await this.#run(race, live);
      return race;
    });
  }

  /** Traz o resultado para o branch atual do projeto. Com conflitos, o projeto fica como estava. */
  async bring(
    race: Race,
  ): Promise<{ race: Race; merged: boolean; conflicts: string[]; into: string }> {
    return this.#guard(race, async () => {
      const integration = race.integration;
      if (!integration || integration.state !== 'ready' || integration.brought)
        throw new Error('Não há nenhuma integração por trazer.');
      const live = await this.#liveOf(race);
      const title = race.text.split('\n')[0]?.trim().slice(0, 72) ?? '';
      const { result, wt } = await this.#worktrees.bring(
        this.#current(live),
        `Repartição: ${title}`,
      );
      if (result.merged) {
        live.tip = wt;
        integration.tip = { ...integration.tip, branch: wt.branch };
        integration.brought = { into: result.into };
        integration.state = 'brought';
        this.#changed(race);
      }
      return { race, merged: result.merged, conflicts: result.conflicts, into: result.into };
    });
  }

  /**
   * Fecha o que é da integração: as sessões de resolução e a worktree da ponta (o branch só se
   * ficou no projeto, se já foi trazida; senão deita-se fora).
   */
  async close(race: Race): Promise<void> {
    if (this.#busy.has(race.id)) throw new Error('Espera que a integração acabe antes de fechar.');
    const live = this.#live.get(race.id);
    for (const id of live?.resolvers ?? []) {
      await this.#sessions.close(id, 'discard', true).catch((error: unknown) => {
        if (this.#sessions.worktreeOf(id)) throw error;
      });
    }
    const tip = race.integration?.tip;
    if (tip) await this.#worktrees.remove(tip, race.integration?.brought ? 'if-merged' : 'always');
    this.#live.delete(race.id);
  }

  async #guard<T>(race: Race, job: () => Promise<T>): Promise<T> {
    if (this.#stopping) throw new Error('O motor está a fechar; nada de novo se integra.');
    if (this.#busy.has(race.id)) throw new Error('A integração já está a correr.');
    this.#busy.add(race.id);
    try {
      return await job();
    } finally {
      this.#busy.delete(race.id);
    }
  }

  #requireIdle(race: Race): void {
    if (race.phase === 'running')
      throw new Error('As partes ainda estão a trabalhar: espera que acabem.');
    if (race.phase === 'closed') throw new Error('A repartição já está fechada.');
    if (race.phase === 'assembling') throw new Error('A integração já está a correr.');
    if (race.phase === 'assembled') throw new Error('Esta repartição já está integrada.');
    if (race.phase !== 'done') throw new Error('Só se integra uma repartição acabada.');
  }

  /** As pistas pela ordem de juntar. */
  #ordered(race: Race): MergeLane[] {
    const infos = race.split?.lanes ?? [];
    return mergeOrder(
      race.lanes.map((lane, position): MergeLane => {
        const info = infos.find((i) => i.sessionId === lane.sessionId);
        return {
          sessionId: lane.sessionId,
          title: lane.part?.title ?? lane.sessionId,
          agent: lane.agent,
          model: lane.model,
          part: lane.part,
          index: info?.index ?? position,
          after: info?.after ?? null,
          zero: lane.part?.zero === true,
        };
      }),
    );
  }

  /** O que se sabe da ponta; depois de um reinício, volta a achá-la entre as worktrees no disco. */
  async #liveOf(race: Race): Promise<Live> {
    const known = this.#live.get(race.id);
    if (known) return known;
    const saved = race.integration?.tip;
    if (!saved) throw new Error('Esta repartição não tem integração.');
    const found = (await this.#worktrees.orphans(new Set())).find((w) =>
      samePath(w.path, saved.path),
    );
    if (!found) throw new Error('A worktree da integração já não existe.');
    const live: Live = {
      tip: found,
      base: saved.base,
      resolvers: [],
      owners: new Map(),
      abort: new AbortController(),
    };
    this.#live.set(race.id, live);
    return live;
  }

  /** A worktree da ponta com o branch de agora (uma sessão pode ter-lhe mudado o nome). */
  #current(live: Live): Worktree {
    const owner = live.owners.get(live.tip.path);
    return (owner ? this.#sessions.worktreeOf(owner) : undefined) ?? live.tip;
  }

  /** A ponta anterior já está toda na nova: sai a sessão dona dela ou a worktree da integração. */
  async #retire(live: Live, old: Worktree): Promise<void> {
    const owner = live.owners.get(old.path);
    if (owner) {
      live.owners.delete(old.path);
      live.resolvers = live.resolvers.filter((id) => id !== owner);
      await this.#sessions.close(owner, 'discard', true).catch(() => undefined);
    } else {
      await this.#worktrees.remove(old, 'always').catch(() => undefined);
    }
  }

  #cost(race: Race, previous: number | null): number | null {
    const costs = race.lanes.map((l) => this.#sessions.costOf(l.sessionId));
    const known = costs.filter((c): c is number => c !== null);
    return known.length > 0 ? known.reduce((sum, c) => sum + c, 0) : previous;
  }

  #checkLabel(lane: MergeLane, checks: readonly SplitCheckRef[]): string | null {
    const id = lane.part?.check;
    if (!id) return null;
    return checks.find((c) => c.id === id)?.label ?? id;
  }

  /** Verifica a ponta com a verificação própria da parte (só essa), a base ao lado. */
  async #verifyStep(lane: MergeLane, tip: Worktree, signal: AbortSignal): Promise<CheckVerdict[]> {
    const id = lane.part?.check;
    if (!id) return [];
    const context = this.#sessions.checkContext(lane.sessionId);
    const specs = context.specs.filter((s) => s.id === id);
    if (specs.length === 0) return [];
    return verify(tip.cwd, {
      specs,
      baseline: () => this.#worktrees.baseline(tip),
      env: context.env,
      ...(context.run ? { run: context.run } : {}),
      signal,
    });
  }

  /** Junta as partes que faltam, uma a uma; pára no primeiro conflito e fecha no fim. */
  async #run(race: Race, live: Live): Promise<void> {
    const integration = race.integration as RaceIntegration;
    const signal = live.abort.signal;
    const done = new Set(integration.steps.filter((s) => s.merged).map((s) => s.sessionId));
    const ordered = this.#ordered(race);
    for (const lane of ordered) {
      if (done.has(lane.sessionId)) continue;
      if (signal.aborted) return;
      const own = this.#sessions.worktreeOf(lane.sessionId);
      if (!own) throw new Error(`A parte «${lane.title}» já não está aberta: não há o que juntar.`);
      // Só o que está em commit entra no merge: a pista grava antes o que ainda tem por gravar.
      await this.#worktrees.commitAll(own, 'Solline: parte concluída');
      const tip = this.#current(live);
      let result: { merged: boolean; conflicts: string[] };
      try {
        result = await this.#worktrees.mergeBranch(tip, own.branch, `Integrar «${lane.title}»`);
      } catch (error) {
        // Um merge que o git recusa sem conflitos vai para a mesma mão que um conflito: uma sessão.
        integration.warnings.push(error instanceof Error ? error.message : String(error));
        result = { merged: false, conflicts: [] };
      }
      if (signal.aborted) return;
      if (!result.merged) {
        integration.steps.push(stepOf(lane.title, lane.sessionId, false, result.conflicts, []));
        integration.conflict = {
          sessionId: lane.sessionId,
          branch: own.branch,
          files: result.conflicts,
          resolver: null,
        };
        integration.state = 'conflict';
        integration.metrics = integrationMetrics(
          race,
          integration,
          this.#cost(race, integration.metrics.costUsd),
        );
        race.phase = 'done';
        this.#changed(race);
        return;
      }
      const verdicts = await this.#verifyStep(lane, tip, signal);
      if (signal.aborted) return;
      integration.steps.push(stepOf(lane.title, lane.sessionId, true, [], verdicts));
      this.#changed(race);
    }
    await this.#finish(race, live);
  }

  /** Depois da última parte: as verificações todas, uma vez, e a revisão do diff integrado. */
  async #finish(race: Race, live: Live): Promise<void> {
    const integration = race.integration as RaceIntegration;
    const signal = live.abort.signal;
    const tip = this.#current(live);
    const first = this.#ordered(race)[0];
    const context = first ? this.#sessions.checkContext(first.sessionId) : undefined;
    const verdicts =
      context && context.specs.length > 0
        ? await verify(tip.cwd, {
            specs: context.specs,
            baseline: () => this.#worktrees.baseline(tip),
            env: context.env,
            ...(context.run ? { run: context.run } : {}),
            signal,
          })
        : [];
    if (signal.aborted) return;
    integration.final = { checks: summary(verdicts), failures: failures(verdicts) };

    integration.review = null;
    if (this.#reviewer) {
      try {
        const files = await this.#worktrees.diff({ ...tip, base: live.base });
        const found =
          files.length === 0
            ? []
            : await this.#reviewer({
                cwd: tip.cwd,
                diff: files.map((f) => f.diff),
                request: race.text,
                signal,
              });
        integration.review = found.map((f) => ({ id: randomUUID(), ...f }));
      } catch (error) {
        if (signal.aborted) return;
        integration.warnings.push(
          `A revisão do resultado falhou: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (signal.aborted) return;
    integration.metrics = integrationMetrics(
      race,
      integration,
      this.#cost(race, integration.metrics.costUsd),
    );
    integration.state = 'ready';
    race.phase = 'assembled';
    this.#changed(race);
  }
}

const summary = (verdicts: readonly CheckVerdict[]) =>
  verdicts.map((c) => ({ label: c.label, state: c.state, preexisting: c.preexisting }));

function stepOf(
  title: string,
  sessionId: string,
  merged: boolean,
  conflicts: readonly string[],
  verdicts: readonly CheckVerdict[],
): IntegrationStep {
  return {
    sessionId,
    title,
    merged,
    conflicts: [...conflicts],
    checks: summary(verdicts),
    failures: failures(verdicts),
  };
}

/** A primeira mensagem da sessão que resolve o conflito: o que juntar, onde, e o que cada parte queria. */
export function resolveMessage(
  request: string,
  clashing: Pick<MergeLane, 'title' | 'part'>,
  conflict: { branch: string; files: readonly string[] },
  merged: readonly Pick<MergeLane, 'title' | 'part'>[],
  checkLabel: string | null,
): string {
  const contract = (lane: Pick<MergeLane, 'title' | 'part'>) => {
    const part = lane.part;
    if (!part) return `- «${lane.title}»`;
    const extra = [
      part.interfaces.trim() ? `interfaces: ${brief(part.interfaces)}` : '',
      part.expected.trim() ? `esperado: ${brief(part.expected)}` : '',
    ].filter(Boolean);
    return `- «${lane.title}»: ${brief(part.goal)}${extra.length ? ` (${extra.join('; ')})` : ''}`;
  };
  const lines = [
    `Estamos a juntar as partes de um pedido maior: «${brief(request)}».`,
    '',
    `Faz merge do branch \`${conflict.branch}\` (parte «${clashing.title}») neste branch e resolve os conflitos em:`,
    ...conflict.files.map((file) => `- ${file}`),
    '',
    'Mantém a intenção das duas partes. O que cada uma queria:',
    ...(merged.length ? ['Já juntadas:', ...merged.map(contract)] : []),
    'A juntar agora:',
    contract(clashing),
    '',
    checkLabel
      ? `Quando acabares, corre a verificação «${checkLabel}» do projeto e grava o merge num commit.`
      : 'Quando acabares, grava o merge num commit.',
  ];
  return lines.join('\n');
}
