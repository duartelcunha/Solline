import {
  emptySpaces,
  type SpaceTask,
  type SpaceMemory,
  commandSchemas,
  defaultNavigation,
  NavigationPreferences,
  NavigationUpdate,
  applyDelta,
  EngineEvent,
  EngineSnapshot,
  FileDiff,
  type RecoverySession,
  type CommandName,
  type CommandPayload,
  type CommandResult,
  type Quality,
  type SessionInfo,
} from '@solline/protocol';
import type { SollineApi, UiRecoveryState, WindowState, Theme } from '@solline/protocol/bridge';
import {
  DraftUpdateSchema,
  UiRecoverySchema,
  WindowActionSchema,
} from '../src/main/window-schemas';
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
  targetedReview,
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
  const canonical = new Map<string, RecoverySession>();
  let spaces = emptySpaces();
  const races = new Map<string, EngineSnapshot['races'][number]>();
  const windowListeners = new Set<(state: WindowState) => void>();
  const closeListeners = new Set<() => Promise<void>>();
  const closeCancelledListeners = new Set<() => void>();
  let closeRequested = false;
  let closing: Promise<void> | undefined;
  let windowState: WindowState = { maximized: false, customControls: true, revision: 0 };
  let minimized = false;
  let closed = false;
  let theme: Theme = 'light';
  let ui: UiRecoveryState = { version: 1, revision: 0, drafts: {} };
  const epoch = `qa-${scene}`;
  let sequence = 0;
  // Synthetic QA fixtures only. This simulates the main process surviving a renderer reload.
  // Production never imports this entry or stores application drafts in browser storage.
  const storageKey = `solline-qa-recovery-v1:${scene}`;
  let agents = structuredClone(initialAgents);
  if (scene === 'untrusted')
    agents = agents.map((agent) => (agent.id === 'codex' ? { ...agent, status: 'ready' } : agent));
  const reviews = new Map<string, { timeline: typeof initialTimeline; files: (typeof diff)[] }>();
  const pending = new Set<string>();
  const queues = new Map<string, { paused: boolean; items: { id: string; text: string }[] }>();
  let count = 0;
  let queuedSequence = 2;
  let failNext: string | null = new URLSearchParams(window.location?.search ?? '').has(
    'failRecovery',
  )
    ? 'engine.snapshot'
    : null;
  let recoveryOpened = false;
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
          stats: { fixed: 0, dismissed: 0, total: 0 },
        };
  const qualities = new Map<string, typeof quality>();
  function snapshot(): EngineSnapshot {
    return EngineSnapshot.parse({
      version: 1,
      epoch,
      sequence,
      sessions: [...canonical.values()].reverse(),
      races: [...races.values()],
      operations: [],
      spaces,
      durability: { status: 'saved' },
    });
  }
  function persist() {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        snapshot: snapshot(),
        ui,
        reviews: [...reviews.entries()],
        count,
        queuedSequence,
      }),
    );
  }
  const saved = sessionStorage.getItem(storageKey);
  if (saved !== null) {
    const record = JSON.parse(saved) as Record<string, unknown>;
    const recovered = EngineSnapshot.parse(record.snapshot);
    spaces = recovered.spaces ?? emptySpaces();
    if (recovered.epoch !== epoch) throw new Error('QA: epoch de recuperação inesperado');
    ui = UiRecoverySchema.parse(record.ui);
    sequence = recovered.sequence;
    if (!Number.isSafeInteger(record.count) || !Number.isSafeInteger(record.queuedSequence))
      throw new Error('QA: sequência de fixtures inválida');
    count = record.count as number;
    queuedSequence = record.queuedSequence as number;
    // Snapshot ordering is most recent first; Map insertion order stays oldest first.
    for (const item of recovered.sessions.toReversed()) {
      canonical.set(item.session.id, item);
      sessions.set(item.session.id, item.session);
      queues.set(item.session.id, item.queue);
      if (item.quality) qualities.set(item.session.id, item.quality);
      if (
        item.turns.some((turn) =>
          turn.blocks.some((block) => 'status' in block && block.status === 'pending'),
        )
      )
        pending.add(item.session.id);
    }
    for (const race of recovered.races) races.set(race.id, race);
    if (!Array.isArray(record.reviews)) throw new Error('QA: revisões guardadas inválidas');
    for (const entry of record.reviews) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !sessions.has(entry[0]))
        throw new Error('QA: revisão de sessão inesperada');
      const item = required(canonical.get(entry[0]), 'sessão recuperada');
      const review = entry[1] as { files?: unknown };
      if (!item.timeline) throw new Error('QA: timeline recuperada ausente');
      reviews.set(entry[0], {
        timeline: item.timeline,
        files: FileDiff.array().parse(review.files),
      });
    }
  }
  function recordEvent(event: EngineEvent) {
    if (event.type === 'race.state') {
      races.set(event.race.id, event.race);
      return;
    }
    if (!('sessionId' in event) || !event.sessionId) return;
    const item = required(canonical.get(event.sessionId), `sessão do evento ${event.sessionId}`);
    switch (event.type) {
      case 'session.event': {
        const delta = event.delta;
        if (delta.type === 'usage') item.usage = { ...item.usage, ...delta.usage };
        else if (delta.type === 'settings')
          item.session.settings = { ...item.session.settings, ...delta.settings };
        else if (delta.type === 'meta') item.session.agentSessionId = delta.agentSessionId;
        else if (delta.type === 'capabilities') item.capabilities = delta.capabilities;
        else {
          if (
            delta.type === 'turn.start' &&
            delta.turn.role === 'user' &&
            item.turns.length === 0
          ) {
            const block = delta.turn.blocks.find((block) => block.kind === 'text');
            if (block?.kind === 'text') {
              const text = block.text.replace(/\s+/g, ' ').trim();
              item.session.title =
                text.length > 60 ? `${text.slice(0, 59)}…` : text || 'Nova sessão';
            }
          }
          item.turns = applyDelta(item.turns, delta);
        }
        break;
      }
      case 'permission.request':
        item.turns = applyDelta(item.turns, {
          type: 'block.upsert',
          turnId: event.turnId,
          block: event.request,
        });
        pending.add(event.sessionId);
        break;
      case 'session.state':
        item.session.state = event.state;
        item.error = event.state === 'error' ? (event.error ?? 'A sessão parou.') : null;
        break;
      case 'session.timeline':
        item.timeline = event.timeline;
        break;
      case 'session.quality':
        item.quality = event.quality;
        qualities.set(event.sessionId, event.quality);
        break;
      case 'session.checks':
        item.checks = event.checks;
        break;
      case 'session.setup':
        item.session.setup = event.setup;
        break;
      case 'session.workspace':
        item.session.workspace = event.workspace;
        break;
      case 'session.handoff':
        if (event.handedTo) item.session.handedTo = event.handedTo;
        else delete item.session.handedTo;
        break;
      case 'session.queue':
        item.queue = event.queue;
        queues.set(event.sessionId, event.queue);
        break;
      case 'engine.error':
        item.error = event.message;
        break;
    }
    if (
      item.turns.some((turn) =>
        turn.blocks.some((block) => 'status' in block && block.status === 'pending'),
      )
    )
      pending.add(event.sessionId);
    else pending.delete(event.sessionId);
  }
  function emit(raw: unknown) {
    const parsed = EngineEvent.parse(raw);
    const event = EngineEvent.parse({ ...parsed, epoch, sequence: ++sequence });
    recordEvent(event);
    persist();
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
    emit({
      kind: 'event',
      type: 'session.timeline',
      sessionId,
      timeline: required(reviews.get(sessionId), 'revisão inicial').timeline,
    });
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
      case 'spaces.snapshot':
        return structuredClone(spaces);
      case 'spaces.taskCreate': {
        const task: SpaceTask = {
          id: crypto.randomUUID(),
          projectId: payload.projectId as string | null,
          title: String(payload.title),
          description: String(payload.description ?? ''),
          status: 'todo',
          attempts: [],
          sourceId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        spaces.tasks.unshift(task);
        spaces.revision++;
        emit({ kind: 'event', type: 'spaces.changed', spaces });
        return task;
      }
      case 'spaces.taskUpdate': {
        const task = required(
          spaces.tasks.find((t) => t.id === payload.id),
          'tarefa',
        );
        Object.assign(task, payload);
        spaces.revision++;
        emit({ kind: 'event', type: 'spaces.changed', spaces });
        return task;
      }
      case 'spaces.delegate': {
        const task = required(
          spaces.tasks.find((t) => t.id === payload.id),
          'tarefa',
        );
        const target = payload.target as
          { kind: 'new'; agent: string } | { kind: 'existing'; sessionId: string };
        const sessionId =
          target.kind === 'existing'
            ? target.sessionId
            : (
                (await handle('session.create', {
                  agent: target.agent,
                  projectId: task.projectId,
                })) as { session: SessionInfo }
              ).session.id;
        if (task.projectId === null) {
          required(sessions.get(sessionId), 'sessão geral').projectId = '__general__';
        }
        const result = (await handle('session.send', { sessionId, text: payload.text })) as {
          turnId: string;
          how: string;
        };
        task.status = 'active';
        task.attempts.push({
          id: String(payload.requestId),
          sessionId,
          turnId: result.turnId,
          text: String(payload.text),
          state: result.how === 'queued' ? 'queued' : 'running',
          at: Date.now(),
          error: null,
        });
        spaces.revision++;
        emit({ kind: 'event', type: 'spaces.changed', spaces });
        return task;
      }
      case 'spaces.configure':
        spaces.settings = commandSchemas['spaces.configure'].payload.parse(payload);
        spaces.revision++;
        emit({ kind: 'event', type: 'spaces.changed', spaces });
        return spaces;
      case 'spaces.memorySave': {
        const input = commandSchemas['spaces.memorySave'].payload.parse(payload);
        const memory: SpaceMemory = {
          ...input,
          id: input.id ?? crypto.randomUUID(),
          createdAt: Date.now(),
        };
        spaces.memories = [memory, ...spaces.memories.filter((m) => m.id !== memory.id)];
        spaces.revision++;
        emit({ kind: 'event', type: 'spaces.changed', spaces });
        return spaces;
      }
      case 'spaces.memoryDelete':
        spaces.memories = spaces.memories.filter((m) => m.id !== payload.id);
        spaces.revision++;
        emit({ kind: 'event', type: 'spaces.changed', spaces });
        return spaces;
      case 'spaces.tick':
        return spaces;
      case 'spaces.analyze':
        spaces.analysis = { ...spaces.analysis, state: 'idle', lastAt: Date.now() };
        spaces.revision++;
        emit({ kind: 'event', type: 'spaces.changed', spaces });
        return spaces;
      case 'engine.snapshot':
        return snapshot();
      case 'engine.flush':
        persist();
        return {};
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
        canonical.set(session.id, {
          session,
          capabilities: structuredClone(capabilities),
          turns: [],
          usage: { costUsd: null, models: [], context: null, tokens: null },
          queue: { items: [], paused: false },
          timeline: null,
          quality: structuredClone(quality),
          checks: null,
          conflicts: null,
          interrupted: false,
          error: null,
        });
        qualities.set(session.id, structuredClone(quality));
        reviews.set(session.id, {
          timeline: {
            ...structuredClone(initialTimeline),
            ...(scene === 'review-targeted'
              ? { pending: { files: 2, additions: 3, deletions: 3 } }
              : {}),
          },
          files:
            scene === 'review-targeted' ? structuredClone(targetedReview) : [structuredClone(diff)],
        });
        seed(session.id); // Deliberately before the response: tests the real early-event buffer.
        return { session: { ...session }, capabilities };
      }
      case 'handoff.draft': {
        required(sessions.get(id), `sessão ${id}`);
        const none = '(nada)';
        const sections = [
          ['Objetivo', String(payload.goal)],
          ['Decisões e o que se pôs de parte', none],
          ['Ficheiros tocados', none],
          ['Perguntas em aberto', none],
          ['Próximos passos', none],
          ['Verificação', none],
        ];
        return {
          text: sections
            .map(([header, body]) => `## ${header}${String.fromCharCode(10)}${body}`)
            .join(String.fromCharCode(10, 10)),
          drafted: 'mechanical' as const,
          warning: 'QA: rascunho mecânico.',
          cost: null,
        };
      }
      case 'handoff.cancelDraft':
        return { cancelled: false };
      case 'handoff.start': {
        const source = required(sessions.get(id), `sessão ${id}`);
        if (source.handedTo) throw new Error('QA: a sessão já passou o testemunho');
        const agent = required(
          agents.find((value) => value.id === payload.agent),
          'agente',
        );
        if (agent.status !== 'ready') throw new Error('QA: agente indisponível neste projeto');
        const session: SessionInfo = {
          id: `session-${++count}`,
          projectId: source.projectId,
          cwd: source.cwd,
          agent: String(payload.agent),
          title: 'Continuação',
          state: 'idle',
          agentSessionId: 'qa-agent',
          settings: { model: 'sonnet', effort: 'high', mode: 'default' },
          ...(source.workspace ? { workspace: structuredClone(source.workspace) } : {}),
          origin: { kind: 'handoff', sessionId: id },
        };
        sessions.set(session.id, session);
        canonical.set(session.id, {
          session,
          capabilities: structuredClone(capabilities),
          turns: [],
          usage: { costUsd: null, models: [], context: null, tokens: null },
          queue: { items: [], paused: false },
          timeline: null,
          quality: structuredClone(quality),
          checks: null,
          conflicts: null,
          interrupted: false,
          error: null,
        });
        qualities.set(session.id, structuredClone(quality));
        reviews.set(session.id, {
          timeline: structuredClone(initialTimeline),
          files: [structuredClone(diff)],
        });
        emit({ kind: 'event', type: 'session.handoff', sessionId: id, handedTo: session.id });
        return { session: { ...session }, capabilities, turnId: 'handoff-1' };
      }
      case 'handoff.resume': {
        const session = required(sessions.get(id), `sessão ${id}`);
        const paused = session.handedTo ? sessions.get(session.handedTo) : undefined;
        if (!session.handedTo) throw new Error('QA: esta sessão já tem a pasta');
        if (paused)
          emit({ kind: 'event', type: 'session.handoff', sessionId: paused.id, handedTo: id });
        emit({ kind: 'event', type: 'session.handoff', sessionId: id, handedTo: null });
        return { session: { ...session }, ...(paused ? { paused: { ...paused } } : {}) };
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
      case 'quality.dismiss': {
        const value = required(qualities.get(id), 'qualidade ausente');
        const ids = payload.ids as string[];
        value.review.findings = value.review.findings.map((finding) =>
          ids.includes(finding.id) ? { ...finding, status: 'dismissed' as const } : finding,
        );
        value.stats = { ...value.stats, dismissed: value.stats.dismissed + ids.length };
        emit({ kind: 'event', type: 'session.quality', sessionId: id, quality: value });
        return value;
      }
      case 'checks.get':
        return checks;
      case 'checks.run':
        emit({ kind: 'event', type: 'session.checks', sessionId: id, checks });
        return checks;
      case 'review.timeline':
        return review().timeline;
      case 'review.diff': {
        if (scene === 'review-targeted') {
          const scope = payload.scope as { kind: string; turnId?: string };
          if (
            !['review', 'session', 'turn'].includes(scope.kind) ||
            (scope.kind === 'turn' && scope.turnId !== 'user-1')
          )
            throw new Error('QA: âmbito de revisão inesperado');
          return {
            files: scope.kind === 'review' ? review().files : structuredClone(targetedReview),
          };
        }
        return { files: review().files };
      }
      case 'review.apply': {
        if (scene === 'review-targeted') {
          const current = review();
          const file = current.files.find((file) => file.path === payload.path);
          if (!file || (payload.hunkId && !file.hunks.some((h) => h.id === payload.hunkId)))
            throw new Error('QA: alvo de revisão inesperado');
          current.files = current.files.flatMap((entry) => {
            if (entry.path !== payload.path) return [entry];
            if (!payload.hunkId) return [];
            const hunks = entry.hunks.filter((h) => h.id !== payload.hunkId);
            return hunks.length
              ? [{ ...entry, hunks, additions: hunks.length, deletions: hunks.length }]
              : [];
          });
          current.timeline = {
            ...current.timeline,
            pending: {
              files: current.files.length,
              additions: current.files.reduce((n, file) => n + file.additions, 0),
              deletions: current.files.reduce((n, file) => n + file.deletions, 0),
            },
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
        canonical.delete(id);
        ui = {
          ...ui,
          drafts: Object.fromEntries(Object.entries(ui.drafts).filter(([key]) => key !== id)),
        };
        persist();
        return { closed: true };
      }
      default:
        throw new Error(`QA: comando sem cenário: ${command}`);
    }
  }
  const api: SollineApi = {
    navigation: {
      read: async () => {
        const saved = localStorage.getItem('solline-qa-navigation');
        // The welcome fixture explicitly exercises the empty Desk, independently of startup defaults.
        return saved
          ? NavigationPreferences.parse(JSON.parse(saved))
          : {
              ...defaultNavigation(),
              ...(scene === 'welcome' ? { startupView: 'desk' as const } : {}),
            };
      },
      update: async (patch) => {
        const state = NavigationPreferences.parse({
          ...(await api.navigation.read()),
          ...NavigationUpdate.parse(patch),
        });
        localStorage.setItem('solline-qa-navigation', JSON.stringify(state));
        return state;
      },
    },
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
    window: {
      async setTheme(next) {
        if (next !== 'light' && next !== 'dark') throw new Error('QA: tema inesperado');
        theme = next;
      },
      async state() {
        return structuredClone(windowState);
      },
      async action(raw) {
        const action = WindowActionSchema.parse(raw);
        journal.push({ kind: 'window', name: action, data: null });
        await held.get(`window.${action}`)?.promise;
        if (failNext === `window.${action}`) {
          failNext = null;
          throw new Error('Falha simulada: tenta de novo.');
        }
        if (action === 'minimize') minimized = true;
        else if (action === 'toggle-maximize') {
          windowState = {
            ...windowState,
            maximized: !windowState.maximized,
            revision: windowState.revision + 1,
          };
          for (const listener of windowListeners) listener(structuredClone(windowState));
        } else closeRequested = true;
      },
      onState(listener) {
        windowListeners.add(listener);
        return () => {
          windowListeners.delete(listener);
        };
      },
      onPrepareClose(listener) {
        closeListeners.add(listener);
        return () => {
          closeListeners.delete(listener);
        };
      },
      onCloseCancelled(listener) {
        closeCancelledListeners.add(listener);
        return () => {
          closeCancelledListeners.delete(listener);
        };
      },
    },
    recovery: {
      async open() {
        journal.push({ kind: 'recovery', name: 'recovery-open', data: null });
        recoveryOpened = true;
      },
      async ui() {
        return structuredClone(ui);
      },
      async saveDraft(raw) {
        const update = DraftUpdateSchema.parse(raw);
        journal.push({ kind: 'recovery', name: 'saveDraft', data: structuredClone(update) });
        await held.get('recovery.saveDraft')?.promise;
        if (failNext === 'recovery.saveDraft') {
          failNext = null;
          throw new Error('Falha simulada: tenta de novo.');
        }
        if (!sessions.has(update.sessionId)) throw new Error('QA: rascunho de sessão inesperada');
        const { sessionId, ...draft } = update;
        ui = {
          ...ui,
          revision: ui.revision + 1,
          drafts: { ...ui.drafts, [sessionId]: structuredClone(draft) },
        };
        persist();
        return ui.revision;
      },
    },
  };
  window.solline = api;
  function confirmClose(): Promise<void> {
    if (closing) return closing;
    if (!closeRequested) return Promise.reject(new Error('QA: fecho sem confirmação pendente'));
    closing = (async () => {
      try {
        for (const listener of closeListeners) await listener();
        await api.request('engine.flush', {});
        closed = true;
      } catch (error) {
        for (const listener of closeCancelledListeners) listener();
        throw error;
      } finally {
        closing = undefined;
      }
    })();
    return closing;
  }
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
    windowSubscriptions: () => windowListeners.size,
    closeSubscriptions: () => closeListeners.size,
    confirmClose,
    cancelClose() {
      if (closing) throw new Error('QA: não é possível cancelar durante a gravação');
      closeRequested = false;
      for (const listener of closeCancelledListeners) listener();
    },
    recoveryOpened: () => recoveryOpened,
    windowState: () => ({ ...windowState, minimized, closed, closeRequested, theme }),
    focus(id: string) {
      for (const listener of focusListeners) listener(id);
    },
  };
  Object.assign(window, { qa: controller });
  return controller;
}
