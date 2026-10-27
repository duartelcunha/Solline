import path from 'node:path';
import type {
  EngineEvent,
  Race,
  RaceLane,
  SplitCheckRef,
  SplitPart,
  SplitPartSpec,
  SplitPending,
  SplitWarning,
} from '@solline/protocol';
import type { WorktreeManager } from '../worktrees/worktrees.ts';
import {
  Lanes,
  STOPPED,
  type LaneProject,
  type LaneSessions,
  type SessionCreateResult,
} from './lanes.ts';
import { RaceRegistry } from './race-registry.ts';
import { reviewPlan } from './split-review.ts';
import { outOfScope } from './zones.ts';

/**
 * As repartições: um pedido cortado em partes diferentes, cada uma uma sessão normal na sua
 * worktree. A parte zero corre sozinha primeiro; as partes que se tocam correm uma a seguir à
 * outra, cada uma a partir do resultado da anterior; as outras correm juntas. Os agentes não
 * falam entre si: cada um recebe um contrato escrito no início e, quando uma parte acaba um turno,
 * os outros recebem um resumo curto do que mudou (só num sentido, pela fila). Mexer fora do
 * contrato ou chocar com outra parte gera um aviso, nunca mata o agente. Nada arranca sozinho
 * depois de um reinício: as partes por arrancar ficam só listadas.
 */

/** O que o gestor precisa do SessionManager. */
export interface SplitSessions extends LaneSessions {
  /** Os resumos vão sempre pela fila: nunca interrompem o que o agente está a fazer. */
  send(sessionId: string, text: string, how?: 'queue'): Promise<unknown>;
  /** O que o agente disse no fim do último turno (vazio se ainda não disse nada). */
  laneDigest(sessionId: string): string;
}

export type SplitWorktrees = Pick<WorktreeManager, 'diff' | 'collisions'>;

export type SplitBegin = LaneProject & {
  /** O pedido original, como o utilizador o escreveu. */
  text: string;
  parts: readonly SplitPartSpec[];
  /** As verificações do projeto (as partes têm de apontar para uma delas). */
  checkRefs: readonly SplitCheckRef[];
};

const MAX_FILES = 12;
const MAX_NOTE = 300;
const MAX_REQUEST = 200;

/** Texto numa só linha, com um limite (reticências se cortar). */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** A linha que abre a primeira mensagem de uma pista: que parte é e o pedido original. */
export function splitIntro(number: number, total: number, request: string): string {
  return `Esta é a parte ${number} de ${total} de um pedido maior: «${oneLine(request, MAX_REQUEST)}».`;
}

/**
 * O contrato de uma parte, em texto simples: o objetivo, onde pode e onde não pode mexer (as zonas
 * das outras partes contam como proibidas), as interfaces combinadas, o resultado esperado e a
 * verificação a correr no fim.
 */
export function contractMessage(
  part: SplitPart,
  others: readonly Pick<SplitPart, 'title' | 'allowed'>[],
  checks: readonly SplitCheckRef[] = [],
): string {
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`);
  const lines = [`A tua parte é «${part.title}».`, `Objetivo: ${part.goal.trim()}`, ''];
  lines.push('Podes mexer em:');
  lines.push(
    ...(part.allowed.length ? list(part.allowed) : ['- o que for preciso para o objetivo']),
  );
  const forbidden = [
    ...part.forbidden,
    ...others
      .filter((other) => other.allowed.length > 0)
      .map((other) => `${other.allowed.join(', ')} (parte «${other.title}»)`),
  ];
  if (forbidden.length) lines.push('', 'Não mexas em:', ...list(forbidden));
  if (part.interfaces.trim()) lines.push('', 'Interfaces combinadas:', part.interfaces.trim());
  if (part.expected.trim()) lines.push('', 'Resultado esperado:', part.expected.trim());
  if (part.check) {
    const label = checks.find((c) => c.id === part.check)?.label ?? part.check;
    lines.push('', `Quando acabares, corre a verificação «${label}» do projeto.`);
  }
  return lines.join('\n');
}

/** A última frase do que o agente disse, com um limite. */
export function lastSentence(text: string, max = MAX_NOTE): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const last = flat.split(/(?<=[.!?…])\s+/).at(-1) ?? '';
  return last.length <= max ? last : `${last.slice(0, max - 1).trimEnd()}…`;
}

interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

/** O resumo que as outras partes recebem: os ficheiros mudados com +/− e a última nota. */
export function digestMessage(title: string, files: readonly ChangedFile[], note: string): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const shown = sorted
    .slice(0, MAX_FILES)
    .map((f) => `${f.path} (+${f.additions} −${f.deletions})`)
    .join(', ');
  const more = sorted.length > MAX_FILES ? ` e mais ${sorted.length - MAX_FILES} ficheiros` : '';
  const last = note ? ` Última nota: ${note}` : '';
  return `A parte «${title}» mudou: ${shown}${more}.${last}\nÉ só informação: não respondas, usa-a se te afetar.`;
}

/** O que se sabe de uma repartição enquanto o motor está de pé (não se grava). */
interface Run {
  project: LaneProject;
  checks: readonly SplitCheckRef[];
  /** As partes lançadas (as que não caíram na revisão), para o contrato e a posição de cada uma. */
  launched: readonly { index: number; part: SplitPart }[];
  /** A sessão de cada parte que já arrancou. */
  sessionOf: Map<number, string>;
  /** Pistas que já acabaram o primeiro turno (já não recebem resumos). */
  finished: Set<string>;
  /** O último resumo que cada pista deu, para não o repetir quando nada mudou. */
  digests: Map<string, string>;
  /** Partes que não conseguiram abrir: ficam por arrancar e nunca se tentam outra vez. */
  failed: Set<number>;
  /** O trabalho que segue a cada fim de turno, um de cada vez. */
  queue: Promise<void>;
  closing: boolean;
}

export class SplitManager {
  readonly #sessions: SplitSessions;
  readonly #worktrees: SplitWorktrees | undefined;
  readonly #registry: RaceRegistry;
  readonly #emit: (event: EngineEvent) => void;
  readonly #core: Lanes;
  readonly #runs = new Map<string, Run>();
  #stopping = false;

  constructor(options: {
    sessions: SplitSessions;
    emit: (event: EngineEvent) => void;
    registry?: RaceRegistry;
    /** Sem worktrees não há resumos, avisos de âmbito nem de colisões (só o lançamento). */
    worktrees?: SplitWorktrees | undefined;
  }) {
    this.#sessions = options.sessions;
    this.#worktrees = options.worktrees;
    this.#emit = options.emit;
    this.#registry = options.registry ?? new RaceRegistry(options.emit);
    this.#core = new Lanes(options.sessions);
  }

  /**
   * Lança a repartição. A revisão corre aqui (nunca se confia na interface): as partes sem
   * verificação válida não se lançam. Arrancam já as que não esperam por ninguém; as outras ficam
   * em `split.pending` até a anterior acabar.
   */
  async begin(payload: SplitBegin): Promise<{ race: Race; sessions: SessionCreateResult[] }> {
    const { text, parts, checkRefs, ...project } = payload;
    const review = reviewPlan(
      parts.map((spec) => spec.part),
      checkRefs.map((c) => c.id),
    );
    const dropped = new Set(review.dropped.map((d) => d.index));
    const launched = parts.flatMap((spec, index) =>
      dropped.has(index) ? [] : [{ index, part: spec.part }],
    );
    if (launched.length === 0)
      throw new Error('Nenhuma parte tem uma verificação válida: não há nada para lançar.');

    // A parte zero vai sozinha à frente; cada cadeia arranca depois dela (ou já) e cada parte
    // parte do resultado da anterior da sua cadeia.
    const after = new Map<number, number | null>();
    const zero = launched.find((l) => l.part.zero)?.index ?? null;
    if (zero !== null) after.set(zero, null);
    for (const group of review.sequential) {
      if (group[0] === zero) continue;
      group.forEach((index, position) =>
        after.set(index, position === 0 ? zero : (group[position - 1] ?? null)),
      );
    }
    const pending: SplitPending[] = launched.map(({ index }) => {
      const spec = parts[index] as SplitPartSpec;
      return {
        index,
        part: spec.part,
        agent: spec.agent,
        ...(spec.model ? { model: spec.model } : {}),
        after: after.get(index) ?? null,
      };
    });

    const id = crypto.randomUUID();
    const race: Race = {
      id,
      kind: 'split',
      projectId: payload.projectId,
      text,
      phase: 'running',
      lanes: [],
      split: { pending, warnings: [] },
    };
    const run: Run = {
      project,
      checks: checkRefs,
      launched,
      sessionOf: new Map(),
      finished: new Set(),
      digests: new Map(),
      failed: new Set(),
      queue: Promise.resolve(),
      closing: false,
    };
    // Uma parte que não abre desfaz as outras do mesmo lote: uma repartição coxa não serve.
    const first = pending.filter((p) => p.after === null);
    const opened = await this.#core.open(
      project,
      id,
      first.map((p) => this.#laneOpen(race, run, p)),
    );
    this.#attach(race, run, first, opened.sessions);
    this.#registry.add(race);
    this.#runs.set(id, run);
    this.#changed(race);
    await opened.send();
    return { race: structuredClone(race), sessions: opened.sessions };
  }

  /** Qualquer corrida ou repartição (o registo é um só). */
  get(raceId: string): Race {
    return this.#registry.get(raceId);
  }

  /**
   * Repõe as repartições do disco: as pistas voltam em erro (as sessões não sobreviveram) e a
   * repartição fica `done`. As partes por arrancar continuam listadas e nunca arrancam sozinhas.
   */
  restoreRecovery(races: Race[]): void {
    for (const race of structuredClone(races)) {
      if (race.kind !== 'split') continue;
      if (race.phase === 'running') race.phase = 'done';
      race.split ??= { pending: [], warnings: [] };
      this.#core.restored(race.lanes);
      this.#registry.add(race);
    }
  }

  /** O que as sessões fazem chega aqui: o estado de cada pista e o que se segue a um fim de turno. */
  observe(event: EngineEvent): void {
    if (this.#stopping || event.type !== 'session.state') return;
    for (const race of this.#registry.all()) {
      if (race.kind !== 'split' || race.phase === 'closed') continue;
      const lane = race.lanes.find((l) => l.sessionId === event.sessionId);
      if (!lane) continue;
      const started = this.#core.hasStarted(lane.sessionId);
      if (!this.#core.observe(race.lanes, event)) continue;
      this.#changed(race);
      const run = this.#runs.get(race.id);
      // Parar sem ter começado não conta, a não ser em erro (aí já não vai começar).
      const ended = STOPPED.has(event.state) && (started || event.state === 'error');
      if (run && ended)
        this.#enqueue(run, () => this.#settled(race, run, lane.sessionId, event.state));
    }
  }

  /** Fecha a repartição (o main já confirmou): deita fora as pistas, guardando o branch de uma. */
  async close(raceId: string, keep?: string): Promise<{ closed: boolean; race: Race }> {
    const race = this.#splitOf(raceId);
    if (race.phase === 'closed') return { closed: true, race };
    if (race.phase === 'running')
      throw new Error('Espera que as partes acabem de trabalhar antes de fechar.');
    if (keep !== undefined && !race.lanes.some((l) => l.sessionId === keep))
      throw new Error('Essa pista não é desta repartição.');
    const run = this.#runs.get(raceId);
    if (run) {
      run.closing = true;
      await run.queue;
    }
    await this.#core.close(
      race.lanes.map((l) => l.sessionId),
      keep,
    );
    if (race.split) race.split.pending = [];
    race.phase = 'closed';
    this.#runs.delete(raceId);
    this.#changed(race);
    return { closed: true, race };
  }

  /** Na paragem do motor nada novo arranca nem se revê. */
  stopForRecovery(): void {
    this.#stopping = true;
  }

  #splitOf(raceId: string): Race {
    const race = this.#registry.get(raceId);
    if (race.kind !== 'split') throw new Error('Isto é uma corrida, não uma repartição.');
    return race;
  }

  /** A pista a abrir para uma parte: o texto (posição, pedido e contrato) e de onde parte. */
  #laneOpen(race: Race, run: Run, pending: SplitPending) {
    const position = run.launched.findIndex((l) => l.index === pending.index) + 1;
    const others = run.launched.filter((l) => l.index !== pending.index).map((l) => l.part);
    const base = pending.after === null ? undefined : run.sessionOf.get(pending.after);
    return {
      agent: pending.agent,
      model: pending.model,
      after: base,
      text: `${splitIntro(position, run.launched.length, race.text)}\n\n${contractMessage(pending.part, others, run.checks)}`,
    };
  }

  /** Passa partes de "por arrancar" a pistas, com o estado com que as sessões abriram. */
  #attach(
    race: Race,
    run: Run,
    batch: readonly SplitPending[],
    sessions: readonly SessionCreateResult[],
  ): void {
    batch.forEach((pending, i) => {
      const created = sessions[i];
      if (!created) return;
      run.sessionOf.set(pending.index, created.session.id);
      const lane: RaceLane = {
        sessionId: created.session.id,
        agent: created.session.agent,
        model: pending.model ?? created.session.settings.model ?? null,
        state: created.session.state,
        part: pending.part,
      };
      race.lanes.push(lane);
    });
    if (race.split) race.split.pending = race.split.pending.filter((p) => !batch.includes(p));
  }

  #enqueue(run: Run, job: () => Promise<void>): void {
    run.queue = run.queue.then(job).catch((error: unknown) => this.#report(error));
  }

  #report(error: unknown): void {
    this.#emit({
      kind: 'event',
      type: 'engine.error',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  /** A parte pode arrancar: não espera por ninguém ou a anterior acabou bem. */
  #ready(race: Race, run: Run, pending: SplitPending): boolean {
    if (run.failed.has(pending.index)) return false;
    if (pending.after === null) return true;
    const before = run.sessionOf.get(pending.after);
    const lane = race.lanes.find((l) => l.sessionId === before);
    return Boolean(before && lane && run.finished.has(before) && lane.state === 'idle');
  }

  /**
   * Uma pista acabou um turno: abre o que estava à espera dela, depois reparte o resumo, avisa do
   * que saiu do âmbito e das colisões, e por fim vê se a repartição acabou. Qualquer falha de
   * resumo ou de aviso fica no registo e a pista segue.
   */
  async #settled(race: Race, run: Run, sessionId: string, state: RaceLane['state']): Promise<void> {
    if (this.#stopping || run.closing) return;
    run.finished.add(sessionId);
    // Quem recebe o resumo: as pistas de agora, não as que este fim de turno vai abrir.
    const others = race.lanes.filter((l) => l.sessionId !== sessionId).map((l) => l.sessionId);
    if (race.phase === 'running') await this.#advance(race, run);
    const lane = race.lanes.find((l) => l.sessionId === sessionId);
    if (state !== 'error' && lane?.part && this.#worktrees)
      await this.#review(race, run, lane, others);
    this.#maybeDone(race, run);
  }

  /** Abre as partes que já podem arrancar (todas de uma vez, uma pista a seguir à outra). */
  async #advance(race: Race, run: Run): Promise<void> {
    if (this.#stopping || run.closing || !race.split) return;
    const ready = race.split.pending.filter((p) => this.#ready(race, run, p));
    if (ready.length === 0) return;
    let opened: Awaited<ReturnType<Lanes['open']>>;
    try {
      opened = await this.#core.open(
        run.project,
        race.id,
        ready.map((p) => this.#laneOpen(race, run, p)),
      );
    } catch (error) {
      // Fica por arrancar e não volta a tentar-se: nada começa por conta própria depois de falhar.
      for (const p of ready) run.failed.add(p.index);
      const titles = ready.map((p) => `«${p.part.title}»`).join(', ');
      this.#report(
        new Error(
          `Não consegui abrir ${titles}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
    this.#attach(race, run, ready, opened.sessions);
    this.#changed(race);
    await opened.send().catch((error: unknown) => this.#report(error));
  }

  async #review(race: Race, run: Run, lane: RaceLane, others: readonly string[]): Promise<void> {
    const worktrees = this.#worktrees;
    const part = lane.part;
    const wt = this.#sessions.worktreeOf(lane.sessionId);
    if (!worktrees || !part || !wt) return;
    const prefix = path.relative(wt.path, wt.cwd).split(path.sep).join('/');
    const inProject = (file: string) =>
      prefix && file.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
        ? file.slice(prefix.length + 1)
        : file;
    const split = race.split;
    if (!split) return;
    let changed = false;

    let files: ChangedFile[] = [];
    try {
      files = (await worktrees.diff(wt)).map((f) => ({
        path: inProject(f.diff.path),
        additions: f.diff.additions,
        deletions: f.diff.deletions,
      }));
    } catch (error) {
      console.error('[split] não consegui ver o que a parte mudou:', error);
    }

    for (const file of outOfScope(
      part,
      files.map((f) => f.path),
    )) {
      const warning: SplitWarning = { sessionId: lane.sessionId, kind: 'outside', path: file };
      if (!hasWarning(split.warnings, warning)) {
        split.warnings.push(warning);
        changed = true;
      }
    }

    for (const other of race.lanes) {
      if (other.sessionId === lane.sessionId) continue;
      const otherWt = this.#sessions.worktreeOf(other.sessionId);
      if (!otherWt) continue;
      try {
        const paths = (await worktrees.collisions(wt, otherWt)).map(inProject);
        if (setCollisions(split.warnings, lane.sessionId, other.sessionId, paths)) changed = true;
      } catch (error) {
        console.error('[split] não consegui prever as colisões:', error);
      }
    }
    if (changed) this.#changed(race);

    const recipients = others.filter((id) => {
      const state = race.lanes.find((l) => l.sessionId === id)?.state;
      return state !== undefined && state !== 'error' && !run.finished.has(id);
    });
    if (files.length === 0 || recipients.length === 0) return;
    const note = lastSentence(this.#sessions.laneDigest(lane.sessionId));
    const key = [
      ...files.map((f) => `${f.path}\t${f.additions}\t${f.deletions}`).sort(),
      note,
    ].join('\n');
    if (run.digests.get(lane.sessionId) === key) return;
    run.digests.set(lane.sessionId, key);
    const text = digestMessage(part.title, files, note);
    for (const id of recipients)
      await this.#sessions.send(id, text, 'queue').catch((error: unknown) => {
        console.error('[split] não consegui entregar o resumo:', error);
      });
  }

  /** Acabou quando todas as pistas pararam e nenhuma parte por arrancar pode arrancar. */
  #maybeDone(race: Race, run: Run): void {
    if (race.phase !== 'running') return;
    const busy = race.lanes.some((l) => !STOPPED.has(l.state) || !run.finished.has(l.sessionId));
    if (busy) return;
    if (race.split?.pending.some((p) => this.#ready(race, run, p))) return;
    race.phase = 'done';
    this.#changed(race);
  }

  #changed(race: Race): void {
    this.#registry.changed(race);
  }
}

function hasWarning(list: readonly SplitWarning[], warning: SplitWarning): boolean {
  return list.some(
    (w) => w.kind === warning.kind && w.sessionId === warning.sessionId && w.path === warning.path,
  );
}

/**
 * Troca as colisões conhecidas entre duas pistas pelas de agora (uma colisão que desapareceu,
 * desaparece). Devolve se mudou alguma coisa.
 */
function setCollisions(
  warnings: SplitWarning[],
  a: string,
  b: string,
  paths: readonly string[],
): boolean {
  const pair = (w: SplitWarning) =>
    w.kind === 'collision' &&
    ((w.sessionId === a && w.other === b) || (w.sessionId === b && w.other === a));
  const known = warnings.filter(pair).map((w) => w.path);
  const now = [...new Set(paths)];
  if (known.length === now.length && known.every((p) => now.includes(p))) return false;
  const kept = warnings.filter((w) => !pair(w));
  warnings.splice(
    0,
    warnings.length,
    ...kept,
    ...now.map((p): SplitWarning => ({ sessionId: a, kind: 'collision', path: p, other: b })),
  );
  return true;
}
