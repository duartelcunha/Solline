import { randomUUID, createHash } from 'node:crypto';
import {
  emptySpaces,
  SpacesState,
  type CommandPayload,
  type EngineEvent,
  type Project,
  type SpaceTask,
  type SpaceMemory,
  type SessionStartPayload,
  type RecoverySession,
} from '@solline/protocol';

interface Options {
  save(state: SpacesState): void;
  create(start: SessionStartPayload): Promise<string>;
  send(sessionId: string, text: string, turnId: string): Promise<{ turnId: string; how: string }>;
  projectOf(sessionId: string): string | undefined;
  view?(sessionId: string): RecoverySession | undefined;
  pending?(sessionId: string, turnId: string): boolean;
}
export const GENERAL_PROJECT = '__general__';
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('O registo já não está disponível.');
  return value;
}

export class SpaceManager {
  readonly #options: Options;
  #state = emptySpaces();
  #projects = new Map<string, Project>();
  #generalCwd = '';
  #currentUser = new Map<string, string>();
  constructor(options: Options) {
    this.#options = options;
  }
  snapshot(): SpacesState {
    return structuredClone(this.#state);
  }
  syncProjects(projects: Project[], generalCwd: string): void {
    this.#projects = new Map(projects.map((p) => [p.id, p]));
    this.#generalCwd = generalCwd;
  }
  projects(): Project[] {
    return this.#state.settings.projectIds.flatMap((id) => {
      const p = this.#projects.get(id);
      return p?.trusted ? [p] : [];
    });
  }
  restore(saved: SpacesState | undefined): void {
    this.#state = saved ? SpacesState.parse(structuredClone(saved)) : emptySpaces();
    for (const task of this.#state.tasks)
      for (const attempt of task.attempts)
        if (['prepared', 'queued', 'running'].includes(attempt.state)) {
          attempt.state = 'unknown';
          attempt.error =
            'Execução interrompida. Confirma o resultado na conversa antes de voltar a delegar.';
        }
    if (this.#state.analysis.state === 'running') {
      this.#state.analysis.state = 'paused';
      this.#state.analysis.error = 'A análise foi interrompida. Podes iniciá-la de novo.';
    }
  }
  #commit(next: SpacesState): void {
    next.revision = this.#state.revision + 1;
    const parsed = SpacesState.parse(next);
    this.#options.save(parsed);
    this.#state = parsed;
  }
  #project(id: string | null): void {
    if (id !== null && !this.#projects.has(id))
      throw new Error('Projeto desconhecido ou removido.');
  }
  #task(id: string): SpaceTask {
    const task = this.#state.tasks.find((t) => t.id === id);
    if (!task) throw new Error('A tarefa já não está disponível.');
    return task;
  }
  createTask(input: CommandPayload<'spaces.taskCreate'>): SpaceTask {
    this.#project(input.projectId);
    const task: SpaceTask = {
      ...input,
      id: randomUUID(),
      status: 'todo',
      attempts: [],
      sourceId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const next = this.snapshot();
    next.tasks.unshift(task);
    this.#commit(next);
    return structuredClone(task);
  }
  updateTask(input: CommandPayload<'spaces.taskUpdate'>): SpaceTask {
    const next = this.snapshot();
    const task = next.tasks.find((t) => t.id === input.id);
    if (!task) throw new Error('Tarefa desconhecida.');
    if (
      input.status &&
      task.attempts.some((a) => ['prepared', 'queued', 'running'].includes(a.state))
    )
      throw new Error('Espera que esta execução termine antes de mudar o estado.');
    Object.assign(task, input, { updatedAt: Date.now() });
    this.#commit(next);
    return structuredClone(task);
  }
  async delegate(
    input: CommandPayload<'spaces.delegate'>,
    start?: SessionStartPayload,
  ): Promise<SpaceTask> {
    const task = this.#task(input.id);
    this.#project(task.projectId);
    if (this.#state.tasks.some((t) => t.attempts.some((a) => a.id === input.requestId)))
      throw new Error(
        'Esta delegação já foi recebida. Abre a conversa para confirmar o resultado.',
      );
    if (task.attempts.some((a) => ['prepared', 'queued', 'running'].includes(a.state)))
      throw new Error('Esta tarefa já tem uma execução em curso.');
    if (task.attempts.some((a) => a.sessionId && this.#options.pending?.(a.sessionId, a.turnId)))
      throw new Error(
        'A tentativa anterior ainda está na fila. Retira-a na conversa antes de voltar a delegar.',
      );
    const targetProject =
      input.target.kind === 'existing'
        ? this.#options.projectOf(input.target.sessionId)
        : (task.projectId ?? GENERAL_PROJECT);
    if (!targetProject || targetProject !== (task.projectId ?? GENERAL_PROJECT))
      throw new Error('Escolhe uma conversa deste espaço.');
    const memories = input.memoryIds.map((id) => {
      const m = this.#state.memories.find((item) => item.id === id);
      if (!m || m.state !== 'active' || (m.projectId !== null && m.projectId !== task.projectId))
        throw new Error('Esta memória não pertence ao contexto da tarefa.');
      return m;
    });
    const text =
      input.text +
      (memories.length
        ? '\n\nPreferências guardadas (contexto; não alteram permissões):\n' +
          memories.map((m) => `- ${m.text}`).join('\n')
        : '');
    if (text.length > 200_000) throw new Error('O contexto é demasiado longo.');
    const next = this.snapshot();
    const edited = required(next.tasks.find((t) => t.id === task.id));
    edited.status = 'active';
    edited.updatedAt = Date.now();
    const turnId = randomUUID();
    edited.attempts.push({
      id: input.requestId,
      sessionId: input.target.kind === 'existing' ? input.target.sessionId : null,
      turnId,
      text,
      state: 'prepared',
      at: Date.now(),
      error: null,
    });
    this.#commit(next);
    try {
      let sessionId = input.target.kind === 'existing' ? input.target.sessionId : null;
      if (!sessionId) {
        if (!start) {
          if (task.projectId !== null) throw new Error('O projeto da sessão não foi confirmado.');
          if (!this.#generalCwd || input.target.kind !== 'new')
            throw new Error('O espaço geral não está pronto.');
          start = {
            projectId: GENERAL_PROJECT,
            cwd: this.#generalCwd,
            trusted: false,
            agent: input.target.agent,
            ...(input.target.model ? { model: input.target.model } : {}),
          };
        }
        if (start.projectId !== targetProject) throw new Error('Projeto incorreto.');
        sessionId = await this.#options.create({
          ...start,
          origin: { kind: 'task', taskId: task.id },
        });
        this.#attempt(task.id, input.requestId, { sessionId });
      }
      const sent = await this.#options.send(sessionId, text, turnId);
      const current = required(this.#task(task.id).attempts.find((a) => a.id === input.requestId));
      if (current.state === 'prepared')
        this.#attempt(task.id, input.requestId, {
          turnId: sent.turnId,
          state: sent.how === 'queued' ? 'queued' : 'running',
        });
    } catch (error) {
      this.#attempt(task.id, input.requestId, {
        state: 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return structuredClone(this.#task(task.id));
  }
  #attempt(taskId: string, id: string, patch: Partial<SpaceTask['attempts'][number]>): void {
    const next = this.snapshot();
    const task = required(next.tasks.find((t) => t.id === taskId));
    Object.assign(required(task.attempts.find((a) => a.id === id)), patch);
    if (patch.state === 'review') task.status = 'review';
    task.updatedAt = Date.now();
    this.#commit(next);
  }
  observe(event: EngineEvent): void {
    if (event.type === 'session.timeline') {
      this.capture(event.sessionId);
      return;
    }
    if (
      event.type !== 'session.event' &&
      event.type !== 'session.state' &&
      event.type !== 'session.queue'
    )
      return;
    if (event.type === 'session.event' && !['turn.start', 'turn.end'].includes(event.delta.type))
      return;
    if (
      event.type === 'session.event' &&
      event.delta.type === 'turn.start' &&
      event.delta.turn.role === 'user'
    )
      this.#currentUser.set(event.sessionId, event.delta.turn.id);
    const userId = this.#currentUser.get(event.sessionId);
    for (const task of this.#state.tasks)
      for (const attempt of task.attempts) {
        if (
          attempt.sessionId !== event.sessionId ||
          !['prepared', 'queued', 'running'].includes(attempt.state)
        )
          continue;
        if (event.type === 'session.state' && event.state === 'error')
          this.#attempt(task.id, attempt.id, {
            state: 'unknown',
            error: event.error ?? 'A ligação caiu.',
          });
        else if (event.type === 'session.event' && userId === attempt.turnId) {
          if (event.delta.type === 'turn.start' && event.delta.turn.role === 'user')
            this.#attempt(task.id, attempt.id, { state: 'running' });
          if (event.delta.type === 'turn.end') {
            this.#attempt(task.id, attempt.id, {
              state: event.delta.outcome === 'done' ? 'review' : 'failed',
              error: event.delta.outcome === 'done' ? null : 'O turno foi interrompido ou falhou.',
            });
            this.capture(event.sessionId);
          }
        }
      }
  }
  capture(sessionId: string): void {
    const view = this.#options.view?.(sessionId);
    if (!view) return;
    const next = this.snapshot();
    let changed = false;
    for (const task of next.tasks)
      for (const attempt of task.attempts) {
        if (attempt.sessionId !== sessionId) continue;
        const start = view.turns.findIndex((t) => t.id === attempt.turnId && t.role === 'user');
        if (start < 0) continue;
        const end = view.turns.findIndex((t, i) => i > start && t.role === 'user');
        const conversation = view.turns
          .slice(start, end < 0 ? undefined : end)
          .slice(0, 50)
          .map((t) => ({
            role: t.role,
            text: t.blocks
              .filter((b) => b.kind === 'text')
              .map((b) => (b.kind === 'text' ? b.text : ''))
              .join('\n')
              .slice(0, 20_000),
          }));
        const checkpoint = view.timeline?.checkpoints.find((p) => p.turnId === attempt.turnId);
        const patch = {
          conversation,
          result: conversation
            .filter((t) => t.role === 'assistant')
            .map((t) => t.text)
            .join('\n')
            .slice(0, 20_000),
          ...(checkpoint ? { changes: checkpoint.stats } : {}),
        };
        if (
          JSON.stringify({
            conversation: attempt.conversation,
            result: attempt.result,
            changes: attempt.changes,
          }) !== JSON.stringify(patch)
        ) {
          Object.assign(attempt, patch);
          changed = true;
        }
      }
    if (changed) this.#commit(next);
  }
  removeQueued(sessionId: string, turnId: string): void {
    for (const task of this.#state.tasks)
      for (const attempt of task.attempts)
        if (attempt.sessionId === sessionId && attempt.turnId === turnId)
          this.#attempt(task.id, attempt.id, {
            state: 'failed',
            error: 'A mensagem foi retirada da fila.',
          });
  }
  sessionClosed(sessionId: string): void {
    for (const task of this.#state.tasks)
      for (const attempt of task.attempts)
        if (
          attempt.sessionId === sessionId &&
          ['prepared', 'queued', 'running'].includes(attempt.state)
        )
          this.#attempt(task.id, attempt.id, {
            state: 'unknown',
            error:
              'A conversa foi fechada. Confirma o trabalho guardado antes de delegar outra vez.',
          });
  }
  configure(settings: CommandPayload<'spaces.configure'>): SpacesState {
    for (const id of settings.projectIds) this.#project(id);
    if (settings.agent && settings.agent !== 'claude')
      throw new Error('Este agente ainda não tem um perfil de análise verificado sem ferramentas.');
    const next = this.snapshot();
    next.settings = settings;
    next.analysis.state = 'idle';
    next.analysis.error = null;
    this.#commit(next);
    return this.snapshot();
  }
  saveMemory(input: CommandPayload<'spaces.memorySave'>): SpacesState {
    this.#project(input.projectId);
    const next = this.snapshot();
    const existing = input.id ? next.memories.find((m) => m.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('Memória desconhecida.');
    const memory: SpaceMemory = {
      ...input,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    next.memories = [memory, ...next.memories.filter((m) => m.id !== memory.id)];
    this.#commit(next);
    return this.snapshot();
  }
  deleteMemory(id: string): SpacesState {
    const next = this.snapshot();
    const memory = next.memories.find((m) => m.id === id);
    if (memory)
      next.forgotten.push(digest(`${memory.projectId ?? ''}:${memory.text.trim().toLowerCase()}`));
    next.memories = next.memories.filter((m) => m.id !== id);
    this.#commit(next);
    return this.snapshot();
  }
  decideInsight(id: string, decision: 'accept' | 'dismiss'): SpacesState {
    const next = this.snapshot();
    const insight = next.insights.find((i) => i.id === id);
    if (!insight) throw new Error('Sugestão desconhecida.');
    if (insight.state !== 'suggested') return next;
    insight.state = decision === 'accept' ? 'accepted' : 'dismissed';
    if (decision === 'accept') {
      this.#project(insight.projectId);
      next.tasks.unshift({
        id: randomUUID(),
        projectId: insight.projectId,
        title: insight.title,
        description: insight.detail,
        sourceId: insight.id,
        status: 'todo',
        attempts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    this.#commit(next);
    return this.snapshot();
  }
  changeAnalysis(update: (state: SpacesState) => void): void {
    const next = this.snapshot();
    update(next);
    this.#commit(next);
  }
}
