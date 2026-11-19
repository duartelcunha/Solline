import { relative, resolve } from 'node:path';
import type {
  EngineCommandResult,
  HandoffDraftedBy,
  SessionInfo,
  Turn,
} from '@solline/protocol';
import { draftFilesOf, handoffMessage, objectiveOf, type DraftFile } from '../handoff/drafter.ts';
import { summaryOf, textOf } from '../review.ts';
import { slug, type Worktree } from '../worktrees/worktrees.ts';
import type { Submitted } from '../session-turns.ts';
import { buildHandoffTaskState, trimTaskStateToTurn } from './task-state.ts';
import { isConsult, type SessionEntry, type SessionHost, type SessionMemory, type SessionResult } from './types.ts';

/**
 * Coordena passagem de testemunho ("handoff"), "Retomar aqui" e bifurcação de sessões ("fork").
 */
export class SessionHandoffCoordinator {
  readonly #host: SessionHost;
  readonly #emitWorkspace: (sessionId: string) => Promise<void>;

  constructor(host: SessionHost, emitWorkspace: (sessionId: string) => Promise<void>) {
    this.#host = host;
    this.#emitWorkspace = emitWorkspace;
  }

  /**
   * O que o rascunho da passagem precisa da sessão de origem: onde está, quem é, o que se disse e
   * os ficheiros tocados (contados pela Solline: da worktree contra a base, ou do checkpoint da
   * sessão). `filesNote` diz porque a lista pode estar incompleta.
   */
  async handoffSource(sessionId: string): Promise<{
    cwd: string;
    label: string;
    title: string;
    turns: readonly Turn[];
    lastRequest: string;
    files: DraftFile[];
    filesNote?: string;
  }> {
    const entry = this.#host.get(sessionId);
    const memory = this.#host.memoryOf(sessionId);
    const last = memory.turns.findLast((t) => t.role === 'user');
    const base = {
      cwd: entry.info.cwd,
      label: entry.definition.label,
      title: entry.info.title,
      turns: memory.turns,
      lastRequest: last ? textOf(last) : '',
    };
    try {
      if (memory.worktree && this.#host.worktrees) {
        const diff = await this.#host.worktrees.diff(memory.worktree);
        const files = draftFilesOf(diff.map((f) => f.diff));
        memory.taskState = { ...memory.taskState, files, updatedAt: Date.now() };
        return { ...base, files };
      }
      const checkpoints = memory.checkpoints;
      await checkpoints?.ready;
      if (checkpoints?.available) {
        const files = draftFilesOf(await checkpoints.diff({ kind: 'session' }));
        memory.taskState = { ...memory.taskState, files, updatedAt: Date.now() };
        return { ...base, files };
      }
      return {
        ...base,
        files: [],
        filesNote: 'Os checkpoints estão desligados: não há como listar os ficheiros tocados.',
      };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        files: [],
        filesNote: `Não consegui listar os ficheiros tocados (${why}).`,
      };
    }
  }

  /**
   * Passa o testemunho: abre a sessão do agente escolhido na mesma pasta (e a mesma worktree, que
   * muda de dono) e manda-lhe o aviso e o rascunho. A origem fica sem enviar até "Retomar aqui".
   * Recusa se a origem trabalha ou já passou o testemunho; se a primeira mensagem não segue, desfaz.
   */
  async handoff(
    sourceId: string,
    request: {
      agent: string;
      model?: string | undefined;
      effort?: string | undefined;
      text: string;
      goal?: string | undefined;
      draftedBy?: HandoffDraftedBy | undefined;
    },
  ): Promise<SessionResult & { turnId: string }> {
    const source = this.#host.get(sourceId);
    const sourceMemory = this.#host.memoryOf(sourceId);
    this.#host.requireActive(source);
    if (isConsult(source.info))
      throw new Error(
        'Uma consulta não passa o testemunho. Abre uma sessão normal para continuar.',
      );
    if (sourceMemory.closing) throw new Error('A sessão está a fechar');
    this.#host.requireIdle(source, sourceMemory, 'passar o testemunho');
    this.#host.handingOff.add(sourceId);
    try {
      // O branch a ganhar nome acaba antes de a worktree mudar de dono (senão voltava à origem).
      await sourceMemory.naming;
      const lastTurn = sourceMemory.turns.at(-1);
      const created = await this.#host.create(
        {
          projectId: source.info.projectId,
          cwd: source.info.cwd,
          trusted: source.trusted,
          agent: request.agent,
          ...(request.model ? { model: request.model } : {}),
          ...(request.effort ? { effort: request.effort } : {}),
          origin: {
            kind: 'handoff',
            sessionId: sourceId,
            ...(lastTurn ? { turnId: lastTurn.id } : {}),
          },
        },
        { workspace: source.info.workspace ?? { kind: 'project' } },
      );
      const targetId = created.session.id;
      const target = this.#host.get(targetId);
      const targetMemory = this.#host.memoryOf(targetId);
      // O nome do objetivo, antes de qualquer evento: a primeira mensagem é só o aviso.
      const headline = request.goal?.trim() || objectiveOf(request.text);
      target.info.title = (headline ?? `Continuação de ${source.info.title}`).slice(0, 80);
      const handoffTurnId = crypto.randomUUID();
      targetMemory.taskState = buildHandoffTaskState({
        targetSessionId: targetId,
        sourceState: sourceMemory.taskState,
        sourceSessionId: sourceId,
        sourceAgent: source.info.agent,
        summaryText: request.text,
        draftedBy: request.draftedBy,
        goal: request.goal,
        handoffTurnId,
        activeRuleIds: targetMemory.taskState.activeRuleIds,
      });
      targetMemory.awaitingHandoffTurn = true;
      for (const memoryId of sourceMemory.usedMemoryIds) targetMemory.usedMemoryIds.add(memoryId);

      this.giveWorktree(sourceId, targetId);
      this.setHandedTo(sourceId, targetId);
      this.setHandedTo(targetId, null);
      await this.#emitWorkspace(targetId);
      let sent: Submitted;
      try {
        sent = await this.#host.send(
          targetId,
          handoffMessage(
            { label: source.definition.label, title: source.info.title },
            request.text,
          ),
          'queue',
          handoffTurnId,
        );
      } catch (error) {
        // A primeira mensagem não seguiu: a pasta e o direito de enviar voltam à origem.
        this.giveWorktree(targetId, sourceId);
        this.setHandedTo(sourceId, null);
        await this.#emitWorkspace(sourceId);
        await this.#host.close(targetId, undefined, true).catch(() => undefined);
        throw error;
      }
      return {
        session: { ...target.info },
        capabilities: created.capabilities,
        turnId: sent.turnId,
      };
    } finally {
      this.#host.handingOff.delete(sourceId);
    }
  }

  /**
   * "Retomar aqui", pedido na sessão que passou o testemunho: a pasta (e a worktree) voltam a ela
   * e quem a tinha fica em pausa, também sem enviar. Segue a cadeia de passagens até quem tem a
   * pasta agora; recusa se essa sessão está a trabalhar.
   */
  async resumeHere(
    sessionId: string,
  ): Promise<{ session: SessionInfo; paused: SessionInfo | undefined }> {
    const entry = this.#host.get(sessionId);
    if (!entry.info.handedTo) throw new Error('Esta sessão já tem a pasta.');
    if (this.#host.handingOff.has(sessionId))
      throw new Error('A passagem de testemunho está a meio: espera que acabe.');
    const holder = this.#holderOf(entry);
    this.#host.handingOff.add(sessionId);
    if (holder) this.#host.handingOff.add(holder.info.id);
    try {
      if (holder) {
        const holderMemory = this.#host.memoryOf(holder.info.id);
        this.#host.requireIdle(holder, holderMemory, 'retomar aqui');
        await holderMemory.naming;
        if (holderMemory.closing) throw new Error('A sessão está a fechar');
        this.giveWorktree(holder.info.id, sessionId);
        this.setHandedTo(holder.info.id, sessionId);
      }
      this.setHandedTo(sessionId, null);
      await this.#emitWorkspace(sessionId);
      return { session: { ...entry.info }, paused: holder ? { ...holder.info } : undefined };
    } finally {
      this.#host.handingOff.delete(sessionId);
      if (holder) this.#host.handingOff.delete(holder.info.id);
    }
  }

  /** Quem tem a pasta agora: o fim da cadeia de passagens (undefined: já não existe ninguém). */
  #holderOf(from: SessionEntry): SessionEntry | undefined {
    const seen = new Set([from.info.id]);
    let current: SessionEntry | undefined = from;
    while (current?.info.handedTo) {
      const next: SessionEntry | undefined = this.#host.sessions.get(current.info.handedTo);
      if (!next) {
        // A sessão para quem passou já não existe: esta fica com a pasta.
        this.setHandedTo(current.info.id, null);
        return current === from ? undefined : current;
      }
      if (seen.has(next.info.id)) throw new Error('A cadeia de passagens ficou inconsistente.');
      seen.add(next.info.id);
      current = next;
    }
    return current === from ? undefined : current;
  }

  /** A worktree muda de dono: só uma sessão a tem de cada vez (fechar e trazer vão por ela). */
  giveWorktree(fromId: string, toId: string): void {
    const from = this.#host.memoryOf(fromId);
    const to = this.#host.memoryOf(toId);
    if (!from.worktree) return;
    if (to.worktree) throw new Error('As duas sessões têm worktree: o estado ficou inconsistente.');
    to.worktree = from.worktree;
    from.worktree = undefined;
    // O branch já tem nome; o aviso da primeira mensagem não lho deve dar.
    to.named = true;
  }

  /** Escreve o `handedTo` da sessão e avisa (a interface e o diário de recuperação). */
  setHandedTo(sessionId: string, handedTo: string | null): void {
    const entry = this.#host.get(sessionId);
    if (handedTo) entry.info.handedTo = handedTo;
    else delete entry.info.handedTo;
    this.#host.emit({ kind: 'event', type: 'session.handoff', sessionId, handedTo });
  }

  /**
   * Bifurca a sessão no fim de um turno: uma sessão nova, do mesmo agente e modelo, na sua própria
   * worktree com os ficheiros como ficaram depois desse turno (o checkpoint). A conversa continua
   * pelo próprio agente quando ele sabe (fork no ponto guardado) e, nos outros, com um resumo do
   * que ficou até lá. A origem não muda (nem a conversa, nem a pasta, nem os checkpoints).
   * Recusa em projetos sem git, com a origem a trabalhar ou com um turno sem checkpoint acabado.
   */
  async fork(sourceId: string, turnId: string): Promise<EngineCommandResult<'session.fork'>> {
    const source = this.#host.get(sourceId);
    const memory = this.#host.memoryOf(sourceId);
    if (memory.closing) throw new Error('A sessão está a fechar');
    if (this.#host.handingOff.has(sourceId))
      throw new Error('A passagem de testemunho está a meio: espera que acabe.');
    this.#host.requireIdle(source, memory, 'bifurcar');
    // Os turnos e os pontos de onde se parte não mudam enquanto se copia.
    return memory.cycle.exclusive('bifurcar', () => this.#fork(source, memory, turnId));
  }

  async #fork(
    source: SessionEntry,
    memory: SessionMemory,
    turnId: string,
  ): Promise<EngineCommandResult<'session.fork'>> {
    const sourceId = source.info.id;
    const index = memory.turns.findIndex((t) => t.id === turnId && t.role === 'user');
    if (index === -1) throw new Error('Este turno já não está na conversa');
    const checkpoints = this.#host.checkpoints(sourceId);
    await checkpoints.ready;
    if (!checkpoints.has(turnId)) throw new Error('Este turno não tem checkpoint');
    if (!this.#host.worktrees) throw new Error('As worktrees estão desligadas');
    const worktrees = this.#host.worktrees;
    // O turno e a resposta dele: tudo até ao pedido seguinte.
    const next = memory.turns.findIndex((t, i) => i > index && t.role === 'user');
    const upTo = memory.turns.slice(0, next === -1 ? memory.turns.length : next);
    // A conversa pelo agente, no ponto em que ele estava ao fim deste turno (o que guardou antes
    // do pedido seguinte; no último, o de agora). Sem ponto, a sessão nova começa com um resumo.
    const point = this.#forkPoint(source, memory, next === -1 ? undefined : memory.turns[next]?.id);

    // Os ficheiros: uma worktree nova da mesma base, com o que o checkpoint tinha.
    const sibling = this.#worktreeOwnerOf(source);
    const fresh = sibling
      ? await worktrees.createFrom(sibling)
      : await worktrees.create(source.info.cwd, source.info.projectId);
    if (!fresh) throw new Error('Bifurcar só funciona em projetos git.');
    let worktree = fresh;
    try {
      await checkpoints.materialize(turnId, worktree.cwd);
      const words = slug(source.info.title).split('-').slice(0, 3);
      worktree = await worktrees.rename(worktree, `${words.join(' ')} bifurcacao`);
    } catch (error) {
      await worktrees.remove(worktree, 'always').catch(() => undefined);
      throw error;
    }

    let created: SessionResult;
    try {
      created = await this.#host.create(
        {
          projectId: source.info.projectId,
          cwd: resolve(worktree.top, relative(worktree.path, worktree.cwd)),
          trusted: source.trusted,
          agent: source.info.agent,
          ...(source.info.settings.model ? { model: source.info.settings.model } : {}),
          ...(source.info.settings.effort ? { effort: source.info.settings.effort } : {}),
          origin: { kind: 'fork', sessionId: sourceId, turnId },
        },
        undefined,
        { worktree, point },
      );
    } catch (error) {
      await worktrees.remove(worktree, 'always').catch(() => undefined);
      throw error;
    }

    const id = created.session.id;
    const entry = this.#host.get(id);
    const target = this.#host.memoryOf(id);
    try {
      // O branch já tem nome, o título já é o da origem: a primeira mensagem não lhos muda.
      target.named = true;
      entry.info.title = `${source.info.title.slice(0, 64)} (bifurcação)`;
      const history = upTo.map(settledCopy);
      const deltas = this.#host.deltaFor(entry.info, target);
      for (const turn of history) deltas({ type: 'turn.start', turn });
      target.taskState = trimTaskStateToTurn(
        {
          ...structuredClone(memory.taskState),
          sessionId: id,
          activeRuleIds: target.taskState.activeRuleIds,
        },
        history,
        target.checkpoints?.timeline().checkpoints.map((c) => c.turnId) ?? [],
      );
      if (point === undefined)
        target.context = summaryOf(
          history,
          'Esta conversa é uma bifurcação de uma sessão anterior, a partir de um dos turnos dela. O que ficou até aí, por ordem:',
        );
      await this.#emitWorkspace(id);
      return {
        session: { ...entry.info },
        capabilities: created.capabilities,
        turns: structuredClone(history),
        conversation: point === undefined ? 'summary' : 'agent',
      };
    } catch (error) {
      await this.#host.close(id, 'discard', true).catch(() => undefined);
      throw error;
    }
  }

  /** O ponto de rebobinar do agente ao fim de um turno (undefined: sem como o agente continuar). */
  #forkPoint(
    source: SessionEntry,
    memory: SessionMemory,
    nextTurnId: string | undefined,
  ): string | undefined {
    let rewinds = false;
    try {
      rewinds = source.adapter.capabilities().features.rewind;
    } catch {
      /* Um agente que nunca arrancou não diz o que sabe. */
    }
    if (!rewinds || !source.adapter.rewindPoint) return undefined;
    return (nextTurnId ? memory.points.get(nextTurnId) : source.adapter.rewindPoint()) ?? undefined;
  }

  /** A worktree que a pasta da sessão tem agora: a dela, ou a de quem recebeu o testemunho. */
  #worktreeOwnerOf(entry: SessionEntry): Worktree | undefined {
    const seen = new Set<string>();
    let current: SessionEntry | undefined = entry;
    while (current && !seen.has(current.info.id)) {
      seen.add(current.info.id);
      const worktree = this.#host.memory.get(current.info.id)?.worktree;
      if (worktree) return worktree;
      current = current.info.handedTo ? this.#host.sessions.get(current.info.handedTo) : undefined;
    }
    return undefined;
  }
}

/**
 * Uma cópia de um turno para o histórico de uma bifurcação: o que estava a meio quando a origem
 * parou (um pedido por responder, uma ferramenta a correr) fica fechado, como na recuperação.
 */
function settledCopy(turn: Turn): Turn {
  const copy = structuredClone(turn);
  for (const block of copy.blocks) {
    if (
      (block.kind === 'permission' || block.kind === 'plan' || block.kind === 'question') &&
      block.status === 'pending'
    )
      block.status = 'cancelled';
    if (block.kind === 'tool' && block.state === 'running') block.state = 'error';
  }
  return copy;
}
