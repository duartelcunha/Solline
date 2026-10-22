import {
  commandSchemas,
  EngineEvent,
  type CommandName,
  type CommandPayload,
  type CommandResult,
  type Quality,
  type SessionInfo,
} from '@solline/protocol';
import type { SollineApi } from '@solline/protocol/bridge';
import {
  agents as initialAgents,
  blocks,
  capabilities as initialCapabilities,
  diff,
  longModelLabel,
  longModeLabel,
  longToolOutput,
  multipleQuestions,
  permission,
  project as initialProject,
  qualityFindings,
  timeline as initialTimeline,
  type Scene,
} from './fixtures';

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`QA: ${label} ausente`);
  return value;
}

export function installBridge(scene: Scene) {
  const project = { ...initialProject, trusted: scene !== 'untrusted' };
  const capabilities = structuredClone(initialCapabilities);
  if (scene === 'limited-agent') {
    capabilities.effort = false;
    capabilities.effortOrder = [];
    for (const model of capabilities.models) model.efforts = [];
    capabilities.features.steer = false;
  }
  if (scene === 'long-controls') {
    for (const model of capabilities.models) model.label = longModelLabel;
    for (const mode of capabilities.modes) mode.label = longModeLabel;
  }
  const listeners = new Set<(event: EngineEvent) => void>();
  const focusListeners = new Set<(id: string) => void>();
  const journal: { kind: string; name: string; data: unknown }[] = [];
  const failures: string[] = [];
  const sessions = new Map<string, SessionInfo>();
  let agents = structuredClone(initialAgents);
  if (scene === 'untrusted')
    agents = agents.map((agent) => (agent.id === 'codex' ? { ...agent, status: 'ready' } : agent));
  const reviews = new Map<string, { timeline: typeof initialTimeline; files: (typeof diff)[] }>();
  const pending = new Set<string>();
  const queues = new Map<string, { paused: boolean; items: { id: string; text: string }[] }>();
  let count = 0;
  let queuedSequence = 2;
  let failNext: string | null = null;
  const held = new Map<string, { promise: Promise<void>; release: () => void }>();
  const checks = {
    trusted: true,
    detected: true,
    specs: [{ id: 'types', label: 'Tipos', command: 'pnpm typecheck', enabled: true }],
    turnId: 'user-1',
    results: [{ id: 'types', state: 'passed', tail: null, durationMs: 320 }],
  };
  const quality: Quality =
    scene === 'quality-findings'
      ? structuredClone(qualityFindings)
      : {
          available: true,
          enabled: true,
          review: {
            state: scene === 'quality-error' ? 'error' : 'done',
            turnId: 'user-1',
            findings: [],
            error: scene === 'quality-error' ? 'O revisor perdeu a ligação.' : null,
          },
        };
  const qualities = new Map<string, typeof quality>();
  function emit(raw: unknown) {
    const event = EngineEvent.parse(raw);
    journal.push({ kind: 'event', name: event.type, data: event });
    for (const listener of listeners) listener(event);
  }
  function state(sessionId: string, value: SessionInfo['state']) {
    const session = sessions.get(sessionId);
    if (session) session.state = value;
    emit({
      kind: 'event',
      type: 'session.state',
      sessionId,
      state: value,
      ...(value === 'error'
        ? { error: 'A ligação ao agente terminou. Podes retomar a sessão.' }
        : {}),
    });
  }
  function seed(sessionId: string) {
    const content = structuredClone(blocks);
    if (scene === 'permission') content.push(structuredClone(permission));
    if (scene === 'question')
      content.push({
        kind: 'question',
        id: 'ask-1',
        status: 'pending',
        questions: [
          {
            header: 'Navegação',
            question: 'Como queres organizar as sessões?',
            multiSelect: false,
            options: [
              { label: 'Por projeto', description: 'Manter o contexto de cada trabalho.' },
              { label: 'Por atividade', description: 'Ver primeiro o trabalho recente.' },
            ],
          },
        ],
      });
    if (scene === 'multi-question') content.push(structuredClone(multipleQuestions));
    if (scene === 'tool-error')
      content.splice(content.length - 1, 1, {
        kind: 'tool',
        id: 'failed-check',
        name: 'Bash',
        summary: 'Verificar o teclado',
        input: { command: 'pnpm test:keyboard' },
        state: 'error',
        output: 'Falhou: foco perdido em navigation.ts:18\nCódigo de saída: 1',
        parentToolId: null,
        category: 'execute',
      });
    if (scene === 'long-tool')
      content.splice(content.length - 1, 1, {
        kind: 'tool',
        id: 'long-check',
        name: 'Bash',
        summary: 'Verificar todos os estados de navegação',
        input: { command: 'pnpm test:navigation' },
        state: 'ok',
        output: longToolOutput,
        parentToolId: null,
        category: 'execute',
      });
    if (scene === 'plan')
      content.push({
        kind: 'plan',
        id: 'ask-1',
        status: 'pending',
        plan: '## Navegação\n\n1. Preservar a seleção.\n2. Verificar o teclado.\n3. Rever as alterações.',
      });
    if (scene === 'long')
      content.push({
        kind: 'text',
        id: 'long',
        text: Array.from(
          { length: 160 },
          (_, i) =>
            `### Passo ${i + 1}\n\nA navegação mantém o projeto e a posição de leitura.\n\n`,
        ).join(''),
        parentToolId: null,
      });
    emit({
      kind: 'event',
      type: 'session.event',
      sessionId,
      delta: {
        type: 'turn.start',
        turn: {
          id: 'user-1',
          role: 'user',
          blocks: [
            {
              kind: 'text',
              id: 'prompt',
              text: 'Melhora a navegação entre sessões e verifica os estados do teclado.',
              parentToolId: null,
            },
          ],
        },
      },
    });
    emit({
      kind: 'event',
      type: 'session.event',
      sessionId,
      delta: { type: 'turn.start', turn: { id: 'answer-1', role: 'assistant', blocks: content } },
    });
    emit({ kind: 'event', type: 'session.timeline', sessionId, timeline: initialTimeline });
    if (['permission', 'question', 'multi-question', 'plan'].includes(scene))
      pending.add(sessionId);
    state(
      sessionId,
      scene === 'error'
        ? 'error'
        : ['permission', 'question', 'multi-question', 'plan'].includes(scene)
          ? 'needs-you'
          : scene === 'queue' || scene === 'limited-agent'
            ? 'running'
            : 'idle',
    );
    if (scene === 'queue' || scene === 'worktree-queue') {
      const queue = {
        paused: scene === 'worktree-queue',
        items: [
          { id: 'queued-1', text: 'Depois verifica o tema escuro.' },
          { id: 'queued-2', text: 'E confirma o teclado.' },
        ],
      };
      queues.set(sessionId, queue);
      emit({ kind: 'event', type: 'session.queue', sessionId, queue });
    }
  }
  async function handle(command: CommandName, payload: Record<string, unknown>): Promise<unknown> {
    const id = String(payload.sessionId ?? 'session-1');
    if ('sessionId' in payload && !sessions.has(id))
      throw new Error(`QA: sessão inesperada: ${id}`);
    const review = () => required(reviews.get(id), `revisão da sessão ${id}`);
    switch (command) {
      case 'engine.ping':
        return { pong: true, engineVersion: 'qa', pid: 1, receivedAt: 1792663200000 };
      case 'projects.list':
        return { projects: scene === 'welcome' ? [] : [project] };
      case 'projects.add':
        return { project };
      case 'projects.setTrusted':
        if (payload.projectId !== project.id) throw new Error('QA: projeto inesperado');
        project.trusted = Boolean(payload.trusted);
        return { project };
      case 'worktrees.list':
        return { orphans: [] };
      case 'agents.list':
        return { agents };
      case 'mcp.list':
        return {
          servers: [
            { id: 'docs', label: 'Documentação', status: 'ready', executesCode: false },
            ...(scene === 'unavailable-mcp'
              ? [{ id: 'offline', label: 'Índice local', status: 'not-found', executesCode: false }]
              : []),
          ],
        };
      case 'agents.keyCandidates':
        return { names: ['EXAMPLE_PUBLIC_CONFIG'] };
      case 'agents.setKeys':
        agents = agents.map((a) =>
          a.id === payload.agent ? { ...a, keys: payload.keys as string[] } : a,
        );
        emit({ kind: 'event', type: 'agents.changed' });
        return { saved: true };
      case 'agents.login':
        agents = agents.map((a) =>
          a.id === payload.agent && a.login ? { ...a, login: { ...a.login, pending: true } } : a,
        );
        return {};
      case 'agents.loginCancel':
        agents = agents.map((a) =>
          a.id === payload.agent && a.login ? { ...a, login: { ...a.login, pending: false } } : a,
        );
        return {};
      case 'session.create': {
        const agent = required(
          agents.find((value) => value.id === payload.agent),
          'agente',
        );
        if (agent.status !== 'ready' || (!project.trusted && agent.untrustedProjects === 'refused'))
          throw new Error('QA: agente indisponível neste projeto');
        if (
          Array.isArray(payload.mcpServerIds) &&
          payload.mcpServerIds.some((value) => value !== 'docs')
        )
          throw new Error('QA: MCP indisponível');
        const session: SessionInfo = {
          id: `session-${++count}`,
          projectId: project.id,
          cwd: project.path,
          agent: String(payload.agent),
          title: 'Navegação com contexto',
          state: 'starting',
          agentSessionId: 'qa-agent',
          settings: { model: 'sonnet', effort: 'high', mode: 'default' },
          workspace: { kind: 'project' },
        };
        if (scene === 'worktree-queue')
          session.workspace = {
            kind: 'worktree',
            branch: 'solline/qa-close',
            stats: { files: 1, additions: 1, deletions: 1 },
          };
        sessions.set(session.id, session);
        qualities.set(session.id, structuredClone(quality));
        reviews.set(session.id, {
          timeline: structuredClone(initialTimeline),
          files: [structuredClone(diff)],
        });
        seed(session.id); // Deliberately before the response: tests the real early-event buffer.
        return { session: { ...session }, capabilities };
      }
      case 'quality.get':
        return required(qualities.get(id), 'qualidade ausente');
      case 'quality.setEnabled': {
        const value = required(qualities.get(id), 'qualidade ausente');
        value.enabled = Boolean(payload.enabled);
        emit({ kind: 'event', type: 'session.quality', sessionId: id, quality: value });
        return value;
      }
      case 'quality.review': {
        const value = required(qualities.get(id), 'qualidade ausente');
        if (!value.enabled) throw new Error('QA: revisor desligado');
        value.review = { ...value.review, state: 'done', error: null };
        emit({ kind: 'event', type: 'session.quality', sessionId: id, quality: value });
        return value;
      }
      case 'quality.fix': {
        const value = required(qualities.get(id), 'qualidade ausente');
        const ids = payload.ids as string[];
        if (
          new Set(ids).size !== ids.length ||
          ids.some((key) => !value.review.findings.some((finding) => finding.id === key))
        )
          throw new Error('QA: achado inesperado');
        state(id, 'running');
        return { turnId: 'fix-1' };
      }
      case 'checks.get':
        return checks;
      case 'checks.run':
        emit({ kind: 'event', type: 'session.checks', sessionId: id, checks });
        return checks;
      case 'review.timeline':
        return review().timeline;
      case 'review.diff':
        return { files: review().files };
      case 'review.apply': {
        if (payload.path && payload.path !== diff.path) throw new Error('QA: ficheiro inesperado');
        if (payload.hunkId && payload.hunkId !== 'hunk-1') throw new Error('QA: hunk inesperado');
        const current = review();
        current.files = [];
        current.timeline = {
          ...current.timeline,
          pending: { files: 0, additions: 0, deletions: 0 },
          undo: payload.action === 'accept' ? 'Aceitar alteração' : 'Rejeitar alteração',
        };
        emit({
          kind: 'event',
          type: 'session.timeline',
          sessionId: id,
          timeline: current.timeline,
        });
        return current.timeline;
      }
      case 'review.undo': {
        const current = review();
        current.files = [structuredClone(diff)];
        current.timeline = structuredClone(initialTimeline);
        emit({
          kind: 'event',
          type: 'session.timeline',
          sessionId: id,
          timeline: current.timeline,
        });
        return current.timeline;
      }
      case 'session.setModel':
      case 'session.setEffort':
      case 'session.setMode': {
        const field =
          command === 'session.setModel'
            ? 'model'
            : command === 'session.setEffort'
              ? 'effort'
              : 'mode';
        emit({
          kind: 'event',
          type: 'session.event',
          sessionId: id,
          delta: { type: 'settings', settings: { [field]: payload[field] } },
        });
        return {};
      }
      case 'permission.answer': {
        if (payload.requestId !== 'ask-1' || !pending.has(id))
          throw new Error('QA: pedido inesperado ou já resolvido');
        pending.delete(id);
        const answer = payload.answer as { decision: string; answers?: Record<string, string> };
        const block =
          scene === 'question' || scene === 'multi-question'
            ? {
                kind: 'question',
                id: 'ask-1',
                status: answer.decision.startsWith('deny') ? 'denied' : 'allowed',
                questions: [],
                ...(answer.answers ? { answers: answer.answers } : {}),
              }
            : scene === 'plan'
              ? {
                  kind: 'plan',
                  id: 'ask-1',
                  status: answer.decision.startsWith('deny') ? 'denied' : 'allowed',
                  plan: 'Plano confirmado.',
                }
              : {
                  ...permission,
                  status: answer.decision.startsWith('deny') ? 'denied' : 'allowed',
                };
        emit({
          kind: 'event',
          type: 'session.event',
          sessionId: id,
          delta: { type: 'block.upsert', turnId: 'answer-1', block },
        });
        state(id, 'idle');
        return {};
      }
      case 'session.send': {
        if (payload.how === 'now' && !capabilities.features.steer)
          throw new Error('QA: orientação não suportada');
        if (payload.how === 'queue') {
          const queue = queues.get(id) ?? { paused: false, items: [] };
          const item = { id: `queued-${++queuedSequence}`, text: String(payload.text) };
          queue.items.push(item);
          queues.set(id, queue);
          emit({ kind: 'event', type: 'session.queue', sessionId: id, queue });
          return { turnId: item.id, how: 'queued' };
        }
        state(id, 'running');
        return { turnId: 'user-2', how: payload.how === 'now' ? 'steered' : 'sent' };
      }
      case 'session.unqueue': {
        const queue = queues.get(id);
        const item = queue?.items.find((item) => item.id === payload.id);
        if (!queue || !item) throw new Error('QA: mensagem fora da fila');
        queue.items = queue.items.filter((item) => item.id !== payload.id);
        emit({ kind: 'event', type: 'session.queue', sessionId: id, queue });
        return { removed: true };
      }
      case 'session.reorder': {
        const queue = queues.get(id);
        const ids = payload.ids as string[];
        if (
          !queue ||
          ids.length !== queue.items.length ||
          new Set(ids).size !== queue.items.length ||
          ids.some((key) => !queue.items.some((item) => item.id === key))
        )
          throw new Error('QA: ordem inesperada');
        queue.items = ids.map((key) =>
          required(
            queue.items.find((item) => item.id === key),
            `mensagem ${key}`,
          ),
        );
        emit({ kind: 'event', type: 'session.queue', sessionId: id, queue });
        return {};
      }
      case 'session.resumeQueue': {
        const queue = queues.get(id);
        if (!queue) throw new Error('QA: fila ausente');
        queue.paused = false;
        emit({ kind: 'event', type: 'session.queue', sessionId: id, queue });
        state(id, 'running');
        return {};
      }
      case 'session.interrupt': {
        const queue = queues.get(id);
        if (queue) {
          queue.paused = true;
          emit({ kind: 'event', type: 'session.queue', sessionId: id, queue });
        }
        state(id, 'idle');
        return {};
      }
      case 'session.resume':
        state(id, 'idle');
        return { session: sessions.get(id), capabilities };
      case 'session.close': {
        const queue = queues.get(id);
        if (queue?.items.length && !payload.dropQueue)
          return { closed: false, queued: queue.items.length };
        const session = required(sessions.get(id), `sessão ${id}`);
        // Matches the engine's two-stage refusal: neither refusal discards queued work.
        if (
          session.workspace?.kind === 'worktree' &&
          session.workspace.stats.files > 0 &&
          !payload.worktree
        )
          return { closed: false, stats: session.workspace.stats };
        queues.delete(id);
        pending.delete(id);
        reviews.delete(id);
        qualities.delete(id);
        sessions.delete(id);
        return { closed: true };
      }
      default:
        throw new Error(`QA: comando sem cenário: ${command}`);
    }
  }
  const api: SollineApi = {
    async request<C extends CommandName>(
      command: C,
      payload: CommandPayload<C>,
    ): Promise<CommandResult<C>> {
      try {
        const parsed = commandSchemas[command].payload.parse(payload);
        journal.push({ kind: 'command', name: command, data: parsed });
        await held.get(command)?.promise;
        if (failNext === command) {
          failNext = null;
          throw new Error('Falha simulada: tenta de novo.');
        }
        const result = await handle(command, parsed);
        return commandSchemas[command].result.parse(result) as CommandResult<C>;
      } catch (error) {
        if (String(error).includes('QA:') || (error instanceof Error && error.name === 'ZodError'))
          failures.push(String(error));
        throw error;
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onFocusSession(listener) {
      focusListeners.add(listener);
      return () => {
        focusListeners.delete(listener);
      };
    },
    window: { async setTheme() {} },
  };
  window.solline = api;
  const controller = {
    emit,
    state,
    hold(command: string) {
      let release: () => void = () => {
        throw new Error('QA: espera não inicializada');
      };
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      held.set(command, { promise, release });
    },
    release(command: string) {
      held.get(command)?.release();
      held.delete(command);
    },
    fail(command: string) {
      failNext = command;
    },
    journal,
    failures,
    subscriptions: () => listeners.size,
    focusSubscriptions: () => focusListeners.size,
    focus(id: string) {
      for (const listener of focusListeners) listener(id);
    },
  };
  Object.assign(window, { qa: controller });
  return controller;
}
