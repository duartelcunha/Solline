import { create } from 'zustand';
import { useStore } from 'zustand';
import type {
  AgentDescriptor,
  AgentId,
  ConsultDecision,
  McpServerDescriptor,
  CommandName,
  CommandPayload,
  CheckSpec,
  CommandResult,
  Orphan,
  Race,
  RaceLaneSpec,
  RaceProposal,
  SplitPart,
  SplitPartSpec,
  SplitReview,
  DiffScope,
  EngineEvent,
  FileDiff,
  PermissionAnswer,
  Project,
  ReviewAction,
  ReviewComment,
  EngineSnapshot,
  IssueList,
  RecoveryOperation,
} from '@solline/protocol';
import type { ReviewDraft, UiRecoveryState } from '@solline/protocol/bridge';
import {
  createSessionStore,
  reduceSession,
  withConsults,
  type SessionData,
  type SessionStore,
} from './session.ts';
import { morphUpdate, morphs } from '../lib/morph.ts';
import { receiveSpaces, useSpaces } from './spaces.ts';
import { receiveRules, useRules } from './rules.ts';
import { mcpCatalogActions, onMcpNotice, receiveMcpCatalog } from './mcp-catalog.ts';
import { flushNavigation } from '../features/navigation/persistence.ts';

/**
 * Estado da app: projetos, a lista de sessões e qual está aberta. Cada sessão tem o
 * seu próprio store (stores/session.ts) para o streaming de uma não redesenhar as outras.
 */
interface AppState {
  projects: Project[];
  projectsLoaded: boolean;
  /** Os agentes que o motor conhece, pela ordem do registo. */
  agents: AgentDescriptor[];
  /** Servidores MCP do catálogo e os escolhidos para as próximas sessões. */
  mcpServers: McpServerDescriptor[];
  mcpSelection: string[];
  /** Ids das sessões, da mais recente para a mais antiga. */
  sessionIds: string[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  /** A criar uma sessão neste projeto. */
  creatingIn: string | null;
  notice: string | null;
  engineOffline: boolean;
  recoveryStatus: 'loading' | 'ready' | 'failed';
  recoveryOperations: RecoveryOperation[];
  closePending: boolean;
  /** O painel de rever está aberto (vale para a sessão ativa). */
  reviewOpen: boolean;
  /** O painel de agentes está aberto. */
  agentsPanel: boolean;
  /** A voltar a verificar os agentes (Verificar de novo). */
  checkingAgents: boolean;
  /** Agentes com um pedido de login ainda sem resposta (o botão fica desligado). */
  loginRequests: string[];
  /** Uma sessão que não fechou porque tem trabalho por trazer: o diálogo pergunta o que fazer. */
  closing: {
    sessionId: string;
    files: number;
    additions: number;
    deletions: number;
    /** Mensagens na fila que se perdem ao fechar. */
    queued?: number;
    draft?: boolean;
    dropDraft?: boolean;
    dropQueue?: boolean;
    worktree?: 'bring' | 'keep' | 'discard';
  } | null;
  /** A sessão cujo diálogo "Passar a…" está aberto. */
  handoffFor: string | null;
  /** A sessão cujo "Trazer" espera pela confirmação (com a revisão antes de trazer). */
  bringFor: string | null;
  /** A sessão cujo "Gravar commit" espera pela mensagem e pelo segundo clique. */
  commitFor: string | null;
  /** O projeto cuja lista de issues está aberta. */
  issuesFor: string | null;
  /** O Mapa das sessões ligadas está aberto. */
  mapOpen: boolean;
  /** A vista principal: a mesa com todas as sessões, ou a conversa da sessão ativa. */
  view: 'desk' | 'session' | 'race' | 'spaces';
  spaceProjectId: string | null;
  /** Worktrees que ficaram no disco sem sessão (por trazer). */
  orphans: Orphan[];
  /** As corridas abertas, por id. */
  races: Record<string, Race>;
  /** A corrida aberta na vista principal (null: mesa ou sessão). */
  activeRaceId: string | null;
}

export const useApp = create<AppState>(() => ({
  projects: [],
  projectsLoaded: false,
  agents: [],
  mcpServers: [],
  mcpSelection: [],
  sessionIds: [],
  activeProjectId: null,
  activeSessionId: null,
  creatingIn: null,
  notice: null,
  engineOffline: true,
  recoveryStatus: 'loading',
  recoveryOperations: [],
  closePending: false,
  reviewOpen: false,
  agentsPanel: false,
  checkingAgents: false,
  loginRequests: [],
  closing: null,
  handoffFor: null,
  bringFor: null,
  commitFor: null,
  issuesFor: null,
  mapOpen: false,
  view: 'desk',
  spaceProjectId: null,
  orphans: [],
  races: {},
  activeRaceId: null,
}));

const sessionStores = new Map<string, SessionStore>();
const draftSubscriptions = new Map<string, () => void>();
const draftWrites = new Map<string, Promise<unknown>>();

function persistDraft(id: string, store: SessionStore): Promise<unknown> {
  const { composerText, pendingSend, reviewDraft } = store.getState();
  const write = window.solline.recovery.saveDraft({
    sessionId: id,
    text: composerText,
    pendingSend,
    review: reviewDraft,
  });
  draftWrites.set(id, write);
  void write.catch(() =>
    store.setState({
      actionError: 'O rascunho ainda não está guardado. Mantém a Solline aberta e tenta novamente.',
    }),
  );
  return write;
}

/** Used before an effect and by the main-owned close handshake. */
export async function flushDrafts(): Promise<void> {
  for (const [id, store] of sessionStores) persistDraft(id, store);
  await Promise.all(draftWrites.values());
}

/** A loja de uma sessão do snapshot, com tudo o que o motor já sabe dela. */
function storeFromItem(item: EngineSnapshot['sessions'][number]): SessionStore {
  const store = createSessionStore(item.session, item.session.projectId, item.capabilities);
  store.setState({
    turns: item.turns,
    usage: item.usage,
    queue: item.queue,
    timeline: item.timeline,
    quality: item.quality,
    checks: item.checks,
    conflicts: item.conflicts,
    error: item.error,
    interrupted: item.interrupted,
  });
  return store;
}

export function restoreSnapshot(snapshot: EngineSnapshot, ui: UiRecoveryState): void {
  if (snapshot.spaces) useSpaces.setState({ data: snapshot.spaces });
  if (snapshot.rules) useRules.setState({ data: snapshot.rules });
  if (snapshot.durability.status === 'failed')
    throw new Error(snapshot.durability.error ?? 'O estado não está guardado');
  for (const unsubscribe of draftSubscriptions.values()) unsubscribe();
  draftSubscriptions.clear();
  draftWrites.clear();
  sessionStores.clear();
  earlyEvents.clear();
  for (const item of snapshot.sessions) {
    const store = storeFromItem(item);
    const draft = ui.drafts[item.session.id];
    store.setState({
      ...withConsults(
        store.getState(),
        (snapshot.consults ?? []).filter((c) => c.sessionId === item.session.id),
      ),
      composerText: draft?.pendingSend
        ? [draft.pendingSend, draft.text].filter(Boolean).join('\n')
        : (draft?.text ?? ''),
      pendingSend: null,
      ...(draft?.review ? { reviewDraft: draft.review } : {}),
      actionError: draft?.pendingSend
        ? 'Um envio anterior ficou sem confirmação na interface. O texto foi preservado; verifica a conversa antes de reenviar.'
        : null,
    });
    adoptStore(item.session.id, store);
  }
  const ids = snapshot.sessions.map((item) => item.session.id);
  const current = useApp.getState();
  const selected =
    current.activeSessionId && ids.includes(current.activeSessionId)
      ? current.activeSessionId
      : (ids[0] ?? null);
  useApp.setState({
    sessionIds: ids,
    races: Object.fromEntries(snapshot.races.map((race) => [race.id, race])),
    engineOffline: false,
    recoveryOperations: snapshot.operations.filter((operation) => operation.state === 'unknown'),
    activeSessionId: selected,
    activeProjectId:
      current.view === 'spaces'
        ? current.spaceProjectId
        : selected
          ? (sessionStores.get(selected)?.getState().projectId ?? null)
          : null,
    view:
      current.view === 'spaces' || current.view === 'desk'
        ? current.view
        : current.view === 'race' &&
            snapshot.races.some((r) => r.id === current.activeRaceId && r.phase !== 'closed')
          ? 'race'
          : selected
            ? 'session'
            : 'desk',
  });
}

/** Subscribe before snapshot; snapshots and queued events share an epoch/sequence boundary. */
export function connectRecovery(): () => void {
  let disposed = false;
  let syncing = false;
  let epoch: string | undefined;
  let sequence = -1;
  let buffered: EngineEvent[] = [];
  const accept = (event: EngineEvent): boolean => {
    if (event.epoch && event.sequence !== undefined) {
      if (event.epoch !== epoch) return false;
      if (event.sequence <= sequence) return true;
      if (event.sequence !== sequence + 1) return false;
      sequence = event.sequence;
    }
    dispatch(event);
    return true;
  };
  const sync = async () => {
    if (syncing || disposed) return;
    syncing = true;
    useApp.setState({ recoveryStatus: 'loading' });
    try {
      if (sessionStores.size) await flushDrafts();
      for (let attempt = 0; attempt < 3; attempt++) {
        const [snapshot, ui] = await Promise.all([
          request('engine.snapshot', {}),
          window.solline.recovery.ui(),
        ]);
        if (disposed) return;
        const events = buffered;
        buffered = [];
        const newest = events.findLast((event) => event.epoch);
        if (newest?.epoch && newest.epoch !== snapshot.epoch) continue;
        epoch = snapshot.epoch;
        sequence = snapshot.sequence;
        restoreSnapshot(snapshot, ui);
        let complete = true;
        for (const event of events)
          if (!accept(event)) {
            complete = false;
            break;
          }
        if (complete) {
          useApp.setState({ recoveryStatus: 'ready' });
          return;
        }
      }
      throw new Error(
        'A sequência de eventos mudou durante a recuperação. Tenta restaurar a interface novamente.',
      );
    } catch (error) {
      if (!disposed)
        useApp.setState({
          recoveryStatus: 'failed',
          engineOffline: true,
          notice: `Não foi possível restaurar o estado em segurança. ${message(error)}`,
        });
    } finally {
      syncing = false;
    }
  };
  const off = window.solline.onEvent((event) => {
    if (disposed) return;
    if (syncing || !epoch) buffered.push(event);
    else if (!accept(event)) {
      buffered.push(event);
      void sync();
    }
  });
  // Main keeps the acknowledgement barrier until close/reload or explicit cancellation.
  // Apply inert synchronously: React's next render must not leave one editable frame.
  const freeze = () => {
    document.getElementById('root')?.setAttribute('inert', '');
    useApp.setState({ closePending: true });
  };
  const thaw = () => {
    document.getElementById('root')?.removeAttribute('inert');
    useApp.setState({ closePending: false });
  };
  const blockInput = (event: Event) => {
    if (!useApp.getState().closePending) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const inputEvents = ['keydown', 'beforeinput', 'pointerdown', 'click'] as const;
  for (const name of inputEvents) document.addEventListener(name, blockInput, true);
  const offClose = window.solline.window.onPrepareClose(async () => {
    freeze();
    await flushDrafts();
    await flushNavigation();
  });
  const offCancelled = window.solline.window.onCloseCancelled(thaw);
  void sync();
  return () => {
    disposed = true;
    buffered = [];
    off();
    offClose();
    offCancelled();
    for (const name of inputEvents) document.removeEventListener(name, blockInput, true);
    thaw();
  };
}

export function sessionStore(id: string): SessionStore | undefined {
  return sessionStores.get(id);
}

const NONE = createSessionStore(
  {
    id: '',
    projectId: '',
    agent: 'claude',
    cwd: '',
    title: '',
    state: 'idle',
    settings: { model: null, effort: null, mode: null },
    agentSessionId: null,
  },
  '',
  null,
);

/** Lê uma fatia de uma sessão; volta a desenhar só quando essa fatia muda. */
export function useSession<T>(id: string | null, select: (data: SessionData) => T): T {
  return useStore((id && sessionStores.get(id)) || NONE, select);
}

function request<C extends CommandName>(
  command: C,
  payload: CommandPayload<C>,
): Promise<CommandResult<C>> {
  return window.solline.request(command, payload);
}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method[^:]*: /, '')
    : String(error);
}

function setActionError(sessionId: string, error: unknown): void {
  sessionStores.get(sessionId)?.setState({ actionError: message(error) });
}

/** Eventos de sessões que a interface ainda não conhece (chegaram antes da resposta). */
const earlyEvents = new Map<string, EngineEvent[]>();

/**
 * Regista a loja de uma sessão nova e aplica-lhe o que já tinha chegado. Se a loja vem de um
 * snapshot (`afterSequence`), os eventos que o snapshot já contém não se aplicam outra vez.
 */
function adoptStore(id: string, store: SessionStore, afterSequence?: number): void {
  draftSubscriptions.get(id)?.();
  sessionStores.set(id, store);
  draftSubscriptions.set(
    id,
    store.subscribe((next, previous) => {
      if (
        next.composerText !== previous.composerText ||
        next.pendingSend !== previous.pendingSend ||
        next.reviewDraft !== previous.reviewDraft
      )
        void persistDraft(id, store);
    }),
  );
  const early = earlyEvents.get(id);
  earlyEvents.delete(id);
  for (const event of early ?? []) {
    if (
      afterSequence !== undefined &&
      event.sequence !== undefined &&
      event.sequence <= afterSequence
    )
      continue;
    store.setState(reduceSession(store.getState(), event));
  }
}

/** Repartições a arrancar: os eventos das primeiras pistas chegam antes da resposta do arranque. */
let startingSplits = 0;
/** Pistas cuja loja está a ser pedida ao motor (uma só vez de cada). */
const adopting = new Set<string>();

/**
 * Uma parte que arranca depois da parte zero chega à interface só por um race.state: ainda não
 * há loja para ela. Pede-se o snapshot ao motor e adotam-se as pistas que faltam.
 */
async function adoptMissingLanes(race: Race): Promise<void> {
  const missing = race.lanes
    .map((lane) => lane.sessionId)
    .filter((id) => !sessionStores.has(id) && !adopting.has(id));
  if (missing.length === 0) return;
  for (const id of missing) adopting.add(id);
  try {
    const snapshot = await request('engine.snapshot', {});
    const adopted: string[] = [];
    for (const item of snapshot.sessions) {
      const id = item.session.id;
      if (!missing.includes(id) || sessionStores.has(id)) continue;
      adoptStore(id, storeFromItem(item), snapshot.sequence);
      adopted.push(id);
    }
    if (adopted.length > 0)
      useApp.setState((s) => ({
        sessionIds: [...adopted.filter((id) => !s.sessionIds.includes(id)), ...s.sessionIds],
      }));
  } catch {
    // Sem a loja a pista fica vazia; o próximo race.state volta a tentar.
  } finally {
    for (const id of missing) adopting.delete(id);
  }
}

/**
 * As sessões que o motor abre sozinho (a consulta de «Perguntar a…», a delegação) não passam por
 * nenhum comando da interface: só chegam eventos delas. Adotam-se do snapshot, e só estas (as
 * pistas e as sessões que a interface está a criar têm o seu próprio caminho).
 */
let childAdoption: ReturnType<typeof setTimeout> | undefined;
function scheduleChildAdoption(): void {
  if (childAdoption !== undefined || startingSplits > 0) return;
  childAdoption = setTimeout(() => {
    childAdoption = undefined;
    void adoptConsultSessions();
  }, 150);
}

export async function adoptConsultSessions(): Promise<void> {
  try {
    const snapshot = await request('engine.snapshot', {});
    const adopted: string[] = [];
    for (const item of snapshot.sessions) {
      const id = item.session.id;
      const kind = item.session.origin?.kind;
      if ((kind !== 'ask' && kind !== 'delegate') || sessionStores.has(id) || adopting.has(id))
        continue;
      adoptStore(id, storeFromItem(item), snapshot.sequence);
      adopted.push(id);
    }
    if (adopted.length > 0)
      useApp.setState((s) => ({
        sessionIds: [...s.sessionIds, ...adopted.filter((id) => !s.sessionIds.includes(id))],
      }));
  } catch {
    // O próximo evento dessa sessão volta a tentar.
  }
}

/** Todos os eventos do motor entram por aqui. */
export function dispatch(event: EngineEvent): void {
  if (event.type === 'spaces.changed') {
    receiveSpaces(event.spaces);
    return;
  }
  if (event.type === 'rules.changed') {
    receiveRules(event.rules);
    return;
  }
  if (event.type === 'mcp.changed') {
    receiveMcpCatalog(event.mcp);
    return;
  }
  if (event.type === 'race.state') {
    useApp.setState((s) => ({ races: { ...s.races, [event.race.id]: event.race } }));
    if (event.race.kind === 'split' && event.race.phase !== 'closed' && startingSplits === 0)
      void adoptMissingLanes(event.race);
    return;
  }
  // Um erro de uma sessão (uma mensagem da fila que não seguiu) fica nessa sessão; sem sessão,
  // é o motor que caiu e todas ficam em erro.
  if (event.type === 'engine.error' && event.sessionId) {
    const store = sessionStores.get(event.sessionId);
    if (store) store.setState({ actionError: event.message });
    else useApp.setState({ notice: event.message });
    return;
  }
  if (event.type === 'engine.error') {
    useApp.setState({ notice: event.message, engineOffline: true });
    for (const store of sessionStores.values()) {
      // Pela fila, como os outros eventos: nada que esteja à espera o desfaz depois.
      enqueue(() => {
        const { info } = store.getState();
        if (info.state === 'error') return;
        store.setState(
          reduceSession(store.getState(), {
            kind: 'event',
            type: 'session.state',
            sessionId: info.id,
            state: 'error',
            error: event.message,
          }),
        );
      }, false);
    }
    return;
  }
  if (event.type === 'engine.ready') {
    useApp.setState({ engineOffline: false });
    return;
  }
  if (event.type === 'agents.changed') {
    if (event.error) useApp.setState({ notice: event.error });
    void actions.loadAgents();
    return;
  }
  const store = sessionStores.get(event.sessionId);
  if (!store) {
    // A sessão ainda não chegou à interface (as pistas de uma corrida começam antes de a
    // resposta do race.start chegar): guarda-se o evento e repete-se quando ela aparecer.
    const early = earlyEvents.get(event.sessionId) ?? [];
    if (early.length < 500) early.push(event);
    earlyEvents.set(event.sessionId, early);
    scheduleChildAdoption();
    return;
  }
  const apply = () => store.setState(reduceSession(store.getState(), event));
  // Na sessão à vista, as mudanças de forma (um pedido respondido, a vez a passar) transformam-se.
  const { activeSessionId, view } = useApp.getState();
  enqueue(apply, view === 'session' && event.sessionId === activeSessionId && morphs(event));
}

/** Todos os eventos de sessão passam pela mesma fila, para uma transformação não trocar a ordem. */
const enqueue = morphUpdate;

/** As sessões de resolução de conflitos de cada repartição (fecham com ela). */
const resolvers = new Map<string, Set<string>>();

/** A segunda opinião e as verificações de uma sessão acabada de abrir. */
function loadSessionExtras(sessionId: string, store: SessionStore): void {
  // Um evento que chegue primeiro é mais recente: o pedido inicial não o pisa.
  void request('quality.get', { sessionId })
    .then((quality) => {
      if (store.getState().quality === null) store.setState({ quality });
    })
    .catch(() => undefined);
  void request('checks.get', { sessionId })
    .then((checks) => {
      if (store.getState().checks === null) store.setState({ checks });
    })
    .catch(() => undefined);
}

/** O agente das sessões abertas sem escolher: o primeiro pronto, senão o Claude. */
function defaultAgent(): AgentId {
  return useApp.getState().agents.find((a) => a.status === 'ready')?.id ?? 'claude';
}

/** Um comando de memória que devolve os Espaços: o estado novo entra na interface. */
async function memoryRequest<C extends 'memory.approve' | 'memory.reject' | 'memory.confirm'>(
  command: C,
  input: CommandPayload<C>,
  doing: string,
): Promise<boolean> {
  try {
    receiveSpaces(await request(command, input));
    return true;
  } catch (error) {
    useApp.setState({ notice: `Não consegui ${doing}. ${message(error)}` });
    return false;
  }
}

// Os erros do catálogo MCP aparecem no mesmo aviso que os do resto da app.
onMcpNotice((text) => useApp.setState({ notice: text }));

export const actions = {
  ...mcpCatalogActions,
  openSpace(projectId: string | null): void {
    useSpaces.setState({ panel: 'tasks' });
    useApp.setState({ view: 'spaces', spaceProjectId: projectId, activeProjectId: projectId });
  },
  /** As regras de um projeto, com os avisos; null se falhou (o erro fica no aviso). */
  async listRules(projectId: string): Promise<CommandResult<'rules.list'> | null> {
    try {
      return await request('rules.list', { projectId });
    } catch (error) {
      useApp.setState({ notice: `Não consegui ler as regras. ${message(error)}` });
      return null;
    }
  },

  /** Cria (sem id) ou altera uma regra; devolve a lista do projeto, ou null se falhou. */
  async saveRule(input: CommandPayload<'rules.save'>): Promise<CommandResult<'rules.save'> | null> {
    try {
      return await request('rules.save', input);
    } catch (error) {
      useApp.setState({ notice: `Não consegui guardar a regra. ${message(error)}` });
      return null;
    }
  },

  async deleteRule(
    projectId: string | null,
    id: string,
  ): Promise<CommandResult<'rules.delete'> | null> {
    try {
      return await request('rules.delete', { projectId, id });
    } catch (error) {
      useApp.setState({ notice: `Não consegui apagar a regra. ${message(error)}` });
      return null;
    }
  },

  async undoRules(projectId: string | null): Promise<CommandResult<'rules.undo'> | null> {
    try {
      return await request('rules.undo', { projectId });
    } catch (error) {
      useApp.setState({ notice: `Não consegui desfazer. ${message(error)}` });
      return null;
    }
  },

  async previewRules(projectId: string | null): Promise<CommandResult<'rules.preview'> | null> {
    try {
      return await request('rules.preview', { projectId });
    } catch (error) {
      useApp.setState({ notice: `Não consegui mostrar o texto. ${message(error)}` });
      return null;
    }
  },

  /**
   * Aprova propostas de memória (ou re-aprova); `scope: 'global'` e as edições são do utilizador.
   * Devolve se resultou (o estado novo chega por spaces.changed).
   */
  async approveMemories(
    ids: string[],
    options: Pick<CommandPayload<'memory.approve'>, 'scope' | 'edits'> = {},
  ): Promise<boolean> {
    return memoryRequest('memory.approve', { ids, ...options }, 'aprovar as memórias');
  },

  /** Rejeita propostas: apagam-se e não voltam a ser propostas. */
  async rejectMemories(ids: string[]): Promise<boolean> {
    return memoryRequest('memory.reject', { ids }, 'rejeitar as memórias');
  },

  /** Re-aprova memórias "a confirmar" (renova a prova e o relógio). */
  async confirmMemories(ids: string[]): Promise<boolean> {
    return memoryRequest('memory.confirm', { ids }, 'confirmar as memórias');
  },

  /** "Exportar para regras": a memória passa a regra do projeto. null se falhou. */
  async memoryToRule(
    id: string,
    projectId?: string,
  ): Promise<CommandResult<'memory.toRule'> | null> {
    try {
      const view = await request('memory.toRule', { id, ...(projectId ? { projectId } : {}) });
      receiveSpaces(await request('spaces.snapshot', {}));
      return view;
    } catch (error) {
      useApp.setState({
        notice: `Não consegui passar a memória para as regras. ${message(error)}`,
      });
      return null;
    }
  },

  async refreshTaskSessions(): Promise<void> {
    const snapshot = await request('engine.snapshot', {});
    for (const item of snapshot.sessions) {
      if (!sessionStores.has(item.session.id)) {
        adoptStore(
          item.session.id,
          createSessionStore(item.session, item.session.projectId, item.capabilities),
        );
      }
    }
    useApp.setState((s) => ({
      sessionIds: [
        ...new Set([...s.sessionIds, ...snapshot.sessions.map((item) => item.session.id)]),
      ],
    }));
  },
  async loadAgents(refresh = false): Promise<void> {
    try {
      const [{ agents }, { servers }] = await Promise.all([
        request('agents.list', refresh ? { refresh } : {}),
        request('mcp.list', {}),
      ]);
      useApp.setState((s) => ({
        agents,
        mcpServers: servers,
        // Um servidor que deixou de estar pronto sai da escolha.
        mcpSelection: s.mcpSelection.filter((id) =>
          servers.some((m) => m.id === id && m.status === 'ready'),
        ),
      }));
    } catch (error) {
      useApp.setState({ notice: `Não foi possível ver os agentes. ${message(error)}` });
    }
  },

  /** Verificar de novo: o motor volta a perguntar a cada agente (sessão iniciada, versão). */
  async refreshAgents(): Promise<void> {
    useApp.setState({ checkingAgents: true });
    try {
      await actions.loadAgents(true);
    } finally {
      useApp.setState({ checkingAgents: false });
    }
  },

  /** Entrar no agente: o main abre o browser; o fim chega por agents.changed. */
  async login(agent: AgentId): Promise<void> {
    if (useApp.getState().loginRequests.includes(agent)) return;
    useApp.setState((s) => ({ notice: null, loginRequests: [...s.loginRequests, agent] }));
    try {
      await request('agents.login', { agent });
    } catch (error) {
      useApp.setState({ notice: `Não foi possível entrar. ${message(error)}` });
    } finally {
      useApp.setState((s) => ({ loginRequests: s.loginRequests.filter((a) => a !== agent) }));
    }
    await actions.loadAgents();
  },

  async cancelLogin(agent: AgentId): Promise<void> {
    await request('agents.loginCancel', { agent }).catch((error: unknown) =>
      useApp.setState({ notice: message(error) }),
    );
    await actions.loadAgents();
  },

  /** Guarda as variáveis de um agente; false se recusaste a confirmação ou falhou. */
  async setKeys(agent: AgentId, keys: string[]): Promise<boolean> {
    try {
      // A lista nova chega pelo agents.changed que o motor manda ao guardar.
      const { saved } = await request('agents.setKeys', { agent, keys });
      return saved;
    } catch (error) {
      useApp.setState({ notice: `Não foi possível guardar as variáveis. ${message(error)}` });
      return false;
    }
  },

  async keyCandidates(): Promise<string[]> {
    try {
      return (await request('agents.keyCandidates', {})).names;
    } catch {
      return [];
    }
  },

  openAgentsPanel(): void {
    useApp.setState({ agentsPanel: true });
    void actions.loadAgents();
  },

  closeAgentsPanel(): void {
    useApp.setState({ agentsPanel: false });
  },

  async loadProjects(): Promise<void> {
    const { projects } = await request('projects.list', {});
    useApp.setState((s) => ({
      projects,
      projectsLoaded: true,
      activeProjectId: s.activeProjectId ?? projects[0]?.id ?? null,
    }));
    void actions.refreshOrphans();
  },

  async addProject(): Promise<void> {
    try {
      const { project } = await request('projects.add', {});
      if (!project) return;
      useApp.setState((s) => ({
        projects: s.projects.some((p) => p.id === project.id)
          ? s.projects
          : [...s.projects, project],
        activeProjectId: project.id,
        notice: null,
      }));
    } catch (error) {
      useApp.setState({ notice: message(error) });
    }
  },

  async setProjectTrusted(projectId: string, trusted: boolean): Promise<void> {
    try {
      const { project } = await request('projects.setTrusted', { projectId, trusted });
      useApp.setState((s) => ({
        projects: s.projects.map((p) => (p.id === project.id ? project : p)),
      }));
    } catch (error) {
      useApp.setState({ notice: message(error) });
    }
  },

  toggleMcp(id: string): void {
    useApp.setState((s) => ({
      mcpSelection: s.mcpSelection.includes(id)
        ? s.mcpSelection.filter((m) => m !== id)
        : [...s.mcpSelection, id],
    }));
  },

  selectProject(projectId: string): void {
    useApp.setState({ activeProjectId: projectId });
  },

  selectSession(sessionId: string): void {
    const store = sessionStores.get(sessionId);
    useApp.setState({
      activeSessionId: sessionId,
      activeProjectId: store?.getState().projectId ?? useApp.getState().activeProjectId,
      view: 'session',
    });
  },

  /** Abre uma corrida: o mesmo pedido em várias pistas, cada uma na sua worktree. */
  async startRace(projectId: string, text: string, lanes: RaceLaneSpec[]): Promise<boolean> {
    try {
      const { race, sessions } = await request('race.start', { projectId, text, lanes });
      for (const created of sessions) {
        adoptStore(
          created.session.id,
          createSessionStore(created.session, projectId, created.capabilities),
        );
      }
      useApp.setState((s) => ({
        sessionIds: [...sessions.map((c) => c.session.id), ...s.sessionIds],
        // O ack durável pode chegar depois dos eventos das pistas. A resposta inicial
        // só preenche a corrida se ainda não tivermos recebido o seu estado atual.
        races: { ...s.races, [race.id]: s.races[race.id] ?? race },
        activeRaceId: race.id,
        view: 'race',
      }));
      return true;
    } catch (error) {
      useApp.setState({ notice: `A corrida não arrancou. ${message(error)}` });
      return false;
    }
  },

  openRace(raceId: string): void {
    useApp.setState({ activeRaceId: raceId, view: 'race', reviewOpen: false });
  },

  /** O que se pode montar com as pistas de uma corrida ordenada (null se falhar). */
  async raceProposal(raceId: string): Promise<RaceProposal | null> {
    try {
      return await request('race.proposal', { raceId });
    } catch (error) {
      useApp.setState({ notice: `Não consegui preparar a montagem. ${message(error)}` });
      return null;
    }
  },

  async assembleRace(raceId: string, picks: string[]): Promise<boolean> {
    try {
      const race = await request('race.assemble', { raceId, picks });
      useApp.setState((s) => ({ races: { ...s.races, [raceId]: race } }));
      return true;
    } catch (error) {
      useApp.setState({ notice: `A montagem não foi feita. ${message(error)}` });
      return false;
    }
  },

  async bringRace(raceId: string): Promise<boolean> {
    try {
      const result = await request('race.bring', { raceId });
      useApp.setState((s) => ({ races: { ...s.races, [raceId]: result.race } }));
      if (!result.merged) {
        useApp.setState({
          notice: `Há conflitos em ${result.conflicts.join(', ')}. O projeto ficou como estava.`,
        });
        return false;
      }
      return true;
    } catch (error) {
      useApp.setState({ notice: `Não consegui trazer a montagem. ${message(error)}` });
      return false;
    }
  },

  /** Fecha a corrida (o main confirma) e tira as pistas da interface. */
  async closeRace(raceId: string, keep?: string): Promise<boolean> {
    try {
      const result = await request('race.close', { raceId, ...(keep ? { keep } : {}) });
      if (!result.closed) return false;
      const lanes = new Set([
        ...(useApp.getState().races[raceId]?.lanes.map((lane) => lane.sessionId) ?? []),
        ...(resolvers.get(raceId) ?? []),
      ]);
      resolvers.delete(raceId);
      for (const id of lanes) {
        sessionStores.delete(id);
        draftSubscriptions.get(id)?.();
        draftSubscriptions.delete(id);
        draftWrites.delete(id);
      }
      useApp.setState((s) => {
        const sessionIds = s.sessionIds.filter((id) => !lanes.has(id));
        const here = s.activeRaceId === raceId;
        return {
          sessionIds,
          races: result.race ? { ...s.races, [raceId]: result.race } : s.races,
          activeRaceId: here ? null : s.activeRaceId,
          activeSessionId:
            s.activeSessionId && lanes.has(s.activeSessionId)
              ? (sessionIds[0] ?? null)
              : s.activeSessionId,
          view: here ? 'desk' : s.view,
        };
      });
      return true;
    } catch (error) {
      useApp.setState({ notice: `Não consegui fechar a corrida. ${message(error)}` });
      return false;
    }
  },

  /**
   * Pede ao planeador que corte o pedido em partes (ou diga que não vale a pena). Só lê o
   * projeto; null se falhou (o erro fica no aviso).
   */
  async planSplit(projectId: string, text: string): Promise<CommandResult<'split.plan'> | null> {
    try {
      return await request('split.plan', { projectId, text });
    } catch (error) {
      useApp.setState({ notice: `Não consegui ler o projeto para partir. ${message(error)}` });
      return null;
    }
  },

  /** Confere um plano sem gastar nada; null se falhou (a revisão só deixa de aparecer). */
  async reviewSplit(parts: SplitPart[], checkIds: string[]): Promise<SplitReview | null> {
    try {
      return await request('split.review', { parts, checkIds });
    } catch {
      return null;
    }
  },

  /** Lança a repartição: a interface adota as sessões que já arrancaram e abre a vista. */
  async startSplit(projectId: string, text: string, parts: SplitPartSpec[]): Promise<boolean> {
    startingSplits++;
    try {
      const { race, sessions } = await request('split.start', { projectId, text, parts });
      for (const created of sessions) {
        adoptStore(
          created.session.id,
          createSessionStore(created.session, projectId, created.capabilities),
        );
      }
      useApp.setState((s) => ({
        sessionIds: [...sessions.map((c) => c.session.id), ...s.sessionIds],
        races: { ...s.races, [race.id]: s.races[race.id] ?? race },
        activeRaceId: race.id,
        view: 'race',
      }));
      startingSplits--;
      // As partes que arrancaram entretanto (depois da zero) só chegaram por race.state.
      void adoptMissingLanes(useApp.getState().races[race.id] ?? race);
      return true;
    } catch (error) {
      startingSplits--;
      useApp.setState({ notice: `A repartição não arrancou. ${message(error)}` });
      return false;
    }
  },

  /** Pára de arrancar as partes que faltam; as pistas que já correm seguem até acabar. */
  async stopSplit(raceId: string): Promise<boolean> {
    try {
      const race = await request('split.stop', { raceId });
      useApp.setState((s) => ({ races: { ...s.races, [raceId]: race } }));
      return true;
    } catch (error) {
      useApp.setState({ notice: `Não consegui parar a repartição. ${message(error)}` });
      return false;
    }
  },

  /** Junta as partes, uma a uma, com a verificação de cada uma. O estado chega por evento. */
  async integrateSplit(raceId: string): Promise<boolean> {
    try {
      const race = await request('split.integrate', { raceId });
      useApp.setState((s) => ({ races: { ...s.races, [raceId]: race } }));
      return true;
    } catch (error) {
      useApp.setState({ notice: `Não consegui integrar. ${message(error)}` });
      return false;
    }
  },

  /**
   * Abre a sessão que resolve o conflito. Não muda de vista: quem a quiser ver clica em abrir.
   * Devolve o id da sessão (null se falhou).
   */
  async resolveSplit(raceId: string): Promise<string | null> {
    try {
      const { race, session } = await request('split.resolve', { raceId });
      const id = session.session.id;
      const store = createSessionStore(session.session, race.projectId, session.capabilities);
      adoptStore(id, store);
      resolvers.set(raceId, new Set([...(resolvers.get(raceId) ?? []), id]));
      useApp.setState((s) => ({
        sessionIds: s.sessionIds.includes(id) ? s.sessionIds : [id, ...s.sessionIds],
        races: { ...s.races, [raceId]: race },
      }));
      loadSessionExtras(id, store);
      return id;
    } catch (error) {
      useApp.setState({ notice: `Não consegui abrir a resolução. ${message(error)}` });
      return null;
    }
  },

  /** Retoma a integração depois de a sessão de resolução gravar o merge. */
  async continueSplit(raceId: string): Promise<boolean> {
    try {
      const race = await request('split.continue', { raceId });
      useApp.setState((s) => ({ races: { ...s.races, [raceId]: race } }));
      return true;
    } catch (error) {
      useApp.setState({ notice: `Não consegui continuar. ${message(error)}` });
      return false;
    }
  },

  /** Abre a mesa e volta a procurar as worktrees por trazer. */
  openDesk(): void {
    useApp.setState({ view: 'desk', reviewOpen: false });
    void actions.refreshOrphans();
  },

  async refreshOrphans(): Promise<void> {
    try {
      const { orphans } = await request('worktrees.list', {});
      useApp.setState({ orphans });
    } catch {
      // Sem worktrees (motor isolado ou sem pasta de dados): a mesa mostra só as sessões.
    }
  },

  async bringOrphan(id: string): Promise<void> {
    try {
      const result = await request('worktrees.bring', { id });
      useApp.setState({
        notice: result.merged
          ? null
          : `Conflitos em ${result.conflicts.join(', ')}: abre uma sessão para os resolver.`,
      });
    } catch (error) {
      useApp.setState({ notice: message(error) });
    }
    await actions.refreshOrphans();
  },

  async discardOrphan(id: string): Promise<void> {
    try {
      await request('worktrees.discard', { id });
    } catch (error) {
      useApp.setState({ notice: message(error) });
    }
    await actions.refreshOrphans();
  },

  async createSession(projectId: string, agent: AgentId = defaultAgent()): Promise<void> {
    const project = useApp.getState().projects.find((p) => p.id === projectId);
    if (!project) return;
    useApp.setState({ creatingIn: projectId, activeProjectId: projectId, notice: null });
    try {
      // Só os agentes que aceitam servidores MCP por sessão os recebem.
      const takesMcp = useApp.getState().agents.find((a) => a.id === agent)?.mcp === true;
      const mcpServerIds = takesMcp ? useApp.getState().mcpSelection : [];
      const { session, capabilities } = await request('session.create', {
        projectId: project.id,
        agent,
        ...(mcpServerIds.length ? { mcpServerIds } : {}),
      });
      const store = createSessionStore(session, projectId, capabilities);
      adoptStore(session.id, store);
      useApp.setState((s) => ({
        sessionIds: [session.id, ...s.sessionIds],
        activeSessionId: session.id,
        view: 'session',
      }));
      loadSessionExtras(session.id, store);
    } catch (error) {
      useApp.setState({ notice: `Não foi possível abrir a sessão. ${message(error)}` });
    } finally {
      useApp.setState({ creatingIn: null });
    }
  },

  async send(sessionId: string, text: string, how?: 'queue' | 'now'): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('session.send', { sessionId, text, ...(how ? { how } : {}) });
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  /** Traz o trabalho da worktree da sessão para o projeto; com conflitos, guarda a lista. */
  async bring(sessionId: string): Promise<void> {
    const store = sessionStores.get(sessionId);
    store?.setState({ actionError: null });
    try {
      const result = await request('session.bring', { sessionId });
      store?.setState({
        conflicts: result.merged ? null : { files: result.conflicts, into: result.into },
      });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

  /**
   * "Trazer": abre a confirmação e, se há revisor, pede já uma revisão de toda a sessão (antes de
   * trazer). O resultado é só informação: trazer nunca espera por ele.
   */
  askBring(sessionId: string): void {
    useApp.setState({ bringFor: sessionId });
    const quality = sessionStores.get(sessionId)?.getState().quality;
    // Uma revisão de turno a correr não é a de antes de trazer: a da sessão toda substitui-a
    // (o motor cancela a anterior). Só uma de "trazer" já a correr dispensa outra.
    const bringing = quality?.review.state === 'running' && quality.review.trigger === 'bring';
    if (quality?.available && quality.enabled && !bringing) {
      void request('quality.review', { sessionId, trigger: 'bring', scope: 'session' }).catch(
        () => undefined,
      );
    }
  },

  closeBring(): void {
    useApp.setState({ bringFor: null });
  },

  askCommit(sessionId: string): void {
    useApp.setState({ commitFor: sessionId });
  },

  closeCommit(): void {
    useApp.setState({ commitFor: null });
  },

  /** Grava a worktree. sha null: não havia nada. O erro volta para o diálogo, que fica aberto. */
  async saveCommit(
    sessionId: string,
    text: string,
  ): Promise<{ sha: string | null } | { error: string }> {
    try {
      const saved = await request('commit.save', { sessionId, message: text });
      if (saved.sha) useApp.setState({ commitFor: null });
      return saved;
    } catch (error) {
      return { error: message(error) };
    }
  },

  openIssues(projectId: string): void {
    useApp.setState({ issuesFor: projectId });
  },

  listIssues(projectId: string): Promise<IssueList> {
    return request('issues.list', { projectId });
  },

  closeIssues(): void {
    useApp.setState({ issuesFor: null });
  },

  /** Abre a issue numa worktree. A sessão normal, pelo menu do agente, não passa por aqui. */
  async openIssue(projectId: string, issueId: string): Promise<void> {
    useApp.setState({ creatingIn: projectId, notice: null });
    try {
      const { sessionId } = await request('issues.open', { projectId, issueId });
      const snapshot = await request('engine.snapshot', {});
      const item = snapshot.sessions.find((entry) => entry.session.id === sessionId);
      if (!item) throw new Error('A sessão não apareceu.');
      const store = storeFromItem(item);
      adoptStore(sessionId, store, snapshot.sequence);
      useApp.setState((s) => ({
        sessionIds: [sessionId, ...s.sessionIds.filter((id) => id !== sessionId)],
        activeSessionId: sessionId,
        activeProjectId: projectId,
        view: 'session',
        issuesFor: null,
      }));
      loadSessionExtras(sessionId, store);
    } catch (error) {
      useApp.setState({ notice: message(error) });
    } finally {
      useApp.setState({ creatingIn: null });
    }
  },

  /** Pede ao agente para resolver os conflitos do último "Trazer" no seu branch. */
  async resolveConflicts(sessionId: string): Promise<void> {
    const store = sessionStores.get(sessionId);
    const conflicts = store?.getState().conflicts;
    if (!conflicts) return;
    const sent = await actions.send(
      sessionId,
      `Ao trazer o teu branch para ${conflicts.into} houve conflitos em: ${conflicts.files.join(', ')}. ` +
        `Faz merge de ${conflicts.into} no teu branch, resolve os conflitos e conclui o merge.`,
    );
    if (sent) store?.setState({ conflicts: null });
  },

  /**
   * Fecha uma sessão. Com trabalho por trazer e sem escolha, abre o diálogo em vez de fechar.
   */
  async closeSession(
    sessionId: string,
    worktree?: 'bring' | 'keep' | 'discard',
    dropQueue = false,
    dropDraft = false,
  ): Promise<void> {
    const session = sessionStores.get(sessionId)?.getState();
    if (session?.pendingSend !== null && session?.pendingSend !== undefined) {
      useApp.setState({
        notice: 'A mensagem ainda está a ser enviada. Espera pela resposta antes de fechar.',
      });
      return;
    }
    if (!dropDraft && session?.composerText.trim()) {
      useApp.setState({
        closing: {
          sessionId,
          files: 0,
          additions: 0,
          deletions: 0,
          draft: true,
          queued: session.queue?.items.length ?? 0,
        },
      });
      return;
    }
    try {
      const result = await request('session.close', {
        sessionId,
        ...(worktree ? { worktree } : {}),
        ...(dropQueue ? { dropQueue } : {}),
      });
      if (!result.closed) {
        if (result.queued) {
          useApp.setState({
            closing: {
              sessionId,
              files: 0,
              additions: 0,
              deletions: 0,
              queued: result.queued,
              worktree,
              dropDraft,
            },
          });
          return;
        }
        if (result.conflicts) {
          const into = result.into ?? 'o branch do projeto';
          sessionStores.get(sessionId)?.setState({ conflicts: { files: result.conflicts, into } });
          useApp.setState({
            closing: null,
            notice: 'Há conflitos: pede ao agente para os resolver.',
          });
        } else if (result.stats) {
          useApp.setState({ closing: { sessionId, ...result.stats, dropDraft, dropQueue } });
        }
        return;
      }
      sessionStores.delete(sessionId);
      draftSubscriptions.get(sessionId)?.();
      draftSubscriptions.delete(sessionId);
      draftWrites.delete(sessionId);
      useApp.setState((s) => {
        const sessionIds = s.sessionIds.filter((id) => id !== sessionId);
        return {
          sessionIds,
          closing: null,
          activeSessionId:
            s.activeSessionId === sessionId ? (sessionIds[0] ?? null) : s.activeSessionId,
          view: s.activeSessionId === sessionId ? 'desk' : s.view,
        };
      });
    } catch (error) {
      useApp.setState({ closing: null, notice: message(error) });
    }
  },

  /** Aprova a sugestão de preparação (confirmação nativa no main) e prepara a worktree. */
  async approveSetup(sessionId: string, command: string): Promise<void> {
    const projectId = sessionStores.get(sessionId)?.getState().projectId;
    if (!projectId) return;
    if (await actions.setProjectSetup(projectId, { command, copyEnv: true })) {
      await actions.retrySetup(sessionId);
    }
  },

  async retrySetup(sessionId: string): Promise<void> {
    await request('setup.retry', { sessionId }).catch((error: unknown) =>
      setActionError(sessionId, error),
    );
  },

  /** Manda ao agente a falha da preparação, para a resolver na worktree. */
  async fixSetup(sessionId: string): Promise<void> {
    const tail = sessionStores.get(sessionId)?.getState().info.setup?.tail ?? '';
    await actions.send(
      sessionId,
      `A preparação desta worktree falhou. Resolve a causa e volta a correr o que faltar.\n\n\`\`\`\n${tail}\n\`\`\``,
    );
  },

  /** Guarda como se preparam as worktrees do projeto (null: a sugestão). false se recusaste. */
  async setProjectSetup(
    projectId: string,
    setup: { command: string; copyEnv: boolean } | null,
  ): Promise<boolean> {
    try {
      const { project } = await request('projects.setSetup', { projectId, setup });
      useApp.setState((s) => ({
        projects: s.projects.map((p) => (p.id === project.id ? project : p)),
      }));
      return JSON.stringify(project.setup ?? null) === JSON.stringify(setup);
    } catch (error) {
      useApp.setState({ notice: message(error) });
      return false;
    }
  },

  async unqueue(sessionId: string, id: string): Promise<boolean> {
    try {
      return (await request('session.unqueue', { sessionId, id })).removed;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  async reorderQueue(sessionId: string, ids: string[]): Promise<void> {
    const store = sessionStores.get(sessionId);
    const queue = store?.getState().queue;
    if (store && queue) {
      const byId = new Map(queue.items.map((i) => [i.id, i]));
      const items = ids.flatMap((id) =>
        byId.has(id) ? [byId.get(id) as (typeof queue.items)[number]] : [],
      );
      store.setState({ queue: { ...queue, items } });
    }
    await request('session.reorder', { sessionId, ids }).catch((error: unknown) =>
      setActionError(sessionId, error),
    );
  },

  async resumeQueue(sessionId: string): Promise<void> {
    await request('session.resumeQueue', { sessionId }).catch((error: unknown) =>
      setActionError(sessionId, error),
    );
  },

  /** Tira uma mensagem da fila e devolve-a à caixa de texto, para editar. */
  async editQueued(sessionId: string, id: string): Promise<void> {
    const store = sessionStores.get(sessionId);
    const item = store?.getState().queue?.items.find((i) => i.id === id);
    if (!store || !item) return;
    // Só volta à caixa se ainda estava na fila (se já seguiu, não se duplica).
    if (await actions.unqueue(sessionId, id)) store.setState({ draft: item.text });
  },

  async interrupt(sessionId: string): Promise<void> {
    await request('session.interrupt', { sessionId }).catch((error: unknown) =>
      setActionError(sessionId, error),
    );
  },

  async setModel(sessionId: string, model: string): Promise<void> {
    await request('session.setModel', { sessionId, model }).catch((error: unknown) =>
      setActionError(sessionId, error),
    );
  },

  async setEffort(sessionId: string, effort: string): Promise<void> {
    await request('session.setEffort', { sessionId, effort }).catch((error: unknown) =>
      setActionError(sessionId, error),
    );
  },

  async setMode(sessionId: string, mode: string): Promise<void> {
    await request('session.setMode', { sessionId, mode }).catch((error: unknown) =>
      setActionError(sessionId, error),
    );
  },

  async answer(sessionId: string, requestId: string, answer: PermissionAnswer): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('permission.answer', { sessionId, requestId, answer });
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  /**
   * Responde a um cartão de "Perguntar a…" ou "Delegar". O pedido sai da sessão quando chega o
   * consult.settled; aqui só se diz ao motor o que decidiste.
   */
  async answerConsult(
    sessionId: string,
    requestId: string,
    decision: ConsultDecision,
  ): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('consult.answer', { sessionId, requestId, decision });
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  editComposer(sessionId: string, value: string | ((current: string) => string)): void {
    const store = sessionStores.get(sessionId);
    if (store)
      store.setState({
        composerText: typeof value === 'function' ? value(store.getState().composerText) : value,
      });
  },

  editReview(sessionId: string, patch: Partial<ReviewDraft>): void {
    const store = sessionStores.get(sessionId);
    if (store) store.setState({ reviewDraft: { ...store.getState().reviewDraft, ...patch } });
  },

  beginComposerSend(sessionId: string, text: string): boolean {
    const store = sessionStores.get(sessionId);
    if (!store || store.getState().pendingSend !== null) return false;
    store.setState({ pendingSend: text, composerText: '' });
    return true;
  },

  finishComposerSend(sessionId: string, ok: boolean): void {
    const store = sessionStores.get(sessionId);
    const current = store?.getState();
    if (!store || !current || current.pendingSend === null) return;
    store.setState({
      pendingSend: null,
      ...(!ok
        ? {
            composerText: current.composerText
              ? `${current.pendingSend}\n${current.composerText}`
              : current.pendingSend,
          }
        : {}),
    });
  },

  receiveDraft(sessionId: string): void {
    const store = sessionStores.get(sessionId);
    const current = store?.getState();
    if (!store || !current || current.draft === null) return;
    store.setState({
      draft: null,
      composerText: current.composerText.trim()
        ? `${current.composerText}\n${current.draft}`
        : current.draft,
    });
  },

  /** Retoma uma sessão cujo claude.exe caiu (resume do agente, mesmo histórico). */
  async resume(sessionId: string): Promise<void> {
    if (useApp.getState().engineOffline) return;
    const store = sessionStores.get(sessionId);
    store?.setState({ actionError: null });
    try {
      const { capabilities } = await request('session.resume', { sessionId });
      store?.setState({ capabilities });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

  /**
   * Escreve o rascunho de uma passagem de testemunho (só leitura, não muda nada). null se falhou
   * ou foi cancelado; o erro fica na sessão de origem.
   */
  async draftHandoff(
    sessionId: string,
    agent: AgentId,
    goal: string,
    model?: string,
  ): Promise<CommandResult<'handoff.draft'> | null> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      return await request('handoff.draft', {
        sessionId,
        agent,
        goal,
        ...(model ? { model } : {}),
      });
    } catch (error) {
      setActionError(sessionId, error);
      return null;
    }
  },

  /** Desiste do rascunho a escrever (fechar o diálogo). */
  async cancelHandoffDraft(sessionId: string): Promise<void> {
    await request('handoff.cancelDraft', { sessionId }).catch(() => undefined);
  },

  /**
   * Passa o testemunho: o motor abre a sessão do agente escolhido na mesma pasta, com o rascunho
   * editado, e a interface abre-a. A de origem fica só de leitura (o evento trata disso).
   */
  async startHandoff(
    sessionId: string,
    agent: AgentId,
    text: string,
    options: { model?: string; effort?: string } = {},
  ): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      const { session, capabilities } = await request('handoff.start', {
        sessionId,
        agent,
        text,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
      });
      const store = createSessionStore(session, session.projectId, capabilities);
      adoptStore(session.id, store);
      useApp.setState((s) => ({
        sessionIds: [session.id, ...s.sessionIds.filter((id) => id !== session.id)],
        activeSessionId: session.id,
        view: 'session',
      }));
      loadSessionExtras(session.id, store);
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  /**
   * "Bifurcar daqui": o motor abre uma sessão nova, na sua worktree, com os ficheiros como
   * ficaram depois desse turno e a conversa até lá; a interface abre-a. A de origem não muda.
   */
  async forkSession(sessionId: string, turnId: string): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      const { session, capabilities, turns } = await request('session.fork', {
        sessionId,
        turnId,
      });
      const store = createSessionStore(session, session.projectId, capabilities);
      // O histórico vem na resposta (os eventos dele são os mesmos turnos: não se repetem).
      store.setState({ turns });
      adoptStore(session.id, store);
      useApp.setState((s) => ({
        sessionIds: [session.id, ...s.sessionIds.filter((id) => id !== session.id)],
        activeSessionId: session.id,
        view: 'session',
      }));
      loadSessionExtras(session.id, store);
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  /** "Retomar aqui": a pasta volta a esta sessão e a outra fica em pausa. */
  async resumeHandoff(sessionId: string): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      const { session, paused } = await request('handoff.resume', { sessionId });
      for (const info of [session, paused]) {
        if (!info) continue;
        sessionStores.get(info.id)?.setState((data) => {
          const { handedTo: _previous, ...rest } = data.info;
          return { info: info.handedTo ? { ...rest, handedTo: info.handedTo } : rest };
        });
      }
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  openHandoff(sessionId: string): void {
    useApp.setState({ handoffFor: sessionId });
  },

  closeHandoff(): void {
    useApp.setState({ handoffFor: null });
  },

  openMap(): void {
    useApp.setState({ mapOpen: true });
  },

  closeMap(): void {
    useApp.setState({ mapOpen: false });
  },

  toggleReview(open?: boolean): void {
    useApp.setState((s) => ({ reviewOpen: open ?? !s.reviewOpen }));
  },

  /** O diff de um âmbito; null se falhou (o erro fica na sessão). */
  async diff(sessionId: string, scope: DiffScope): Promise<FileDiff[] | null> {
    try {
      return (await request('review.diff', { sessionId, scope })).files;
    } catch (error) {
      setActionError(sessionId, error);
      return null;
    }
  },

  /** Aceitar ou rejeitar um hunk, um ficheiro ou tudo. A linha do tempo chega por evento. */
  async review(
    sessionId: string,
    action: ReviewAction,
    target: { path?: string; hunkId?: string } = {},
  ): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('review.apply', { sessionId, action, ...target });
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  async undo(sessionId: string): Promise<void> {
    await request('review.undo', { sessionId }).catch((error: unknown) =>
      setActionError(sessionId, error),
    );
  },

  async comment(sessionId: string, comments: ReviewComment[], note?: string): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('review.comment', { sessionId, comments, ...(note ? { note } : {}) });
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  /** Liga ou desliga a segunda opinião nesta sessão. */
  async setQualityEnabled(sessionId: string, enabled: boolean): Promise<void> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      const quality = await request('quality.setEnabled', { sessionId, enabled });
      sessionStores.get(sessionId)?.setState({ quality });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

  /** Volta a rever o último turno (depois de uma falha, por exemplo). */
  async reviewAgain(sessionId: string): Promise<void> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('quality.review', { sessionId });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

  /** Uma segunda opinião agora, a pedido: do último turno ou de toda a sessão. */
  async secondOpinion(sessionId: string, scope: 'turn' | 'session'): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('quality.review', { sessionId, trigger: 'manual', scope });
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  /** Pede ao agente para corrigir os achados escolhidos. */
  async fixFindings(sessionId: string, ids: string[]): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('quality.fix', { sessionId, ids });
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  /** Descarta achados: o motor marca-os e a interface deixa de os mostrar. */
  async dismissFindings(sessionId: string, ids: string[]): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      const quality = await request('quality.dismiss', { sessionId, ids });
      sessionStores.get(sessionId)?.setState({ quality });
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  /** Volta a correr as verificações do projeto agora. */
  async runChecks(sessionId: string): Promise<void> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('checks.run', { sessionId });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

  /** Manda a falha de uma verificação ao agente. */
  async fixCheck(sessionId: string, id: string): Promise<void> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('checks.fix', { sessionId, id });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

  /** Guarda as verificações de um projeto (null: as do package.json). false se recusaste. */
  async setProjectChecks(projectId: string, checks: CheckSpec[] | null): Promise<boolean> {
    try {
      const { project } = await request('projects.setChecks', { projectId, checks });
      useApp.setState((s) => ({
        projects: s.projects.map((p) => (p.id === project.id ? project : p)),
      }));
      return JSON.stringify(project.checks ?? null) === JSON.stringify(checks);
    } catch (error) {
      useApp.setState({ notice: message(error) });
      return false;
    }
  },

  /** Volta a antes de um turno; a mensagem desse turno regressa à caixa de texto. */
  async rewind(
    sessionId: string,
    turnId: string,
    what: { files: boolean; conversation: boolean },
  ): Promise<boolean> {
    const store = sessionStores.get(sessionId);
    store?.setState({ actionError: null });
    try {
      const result = await request('session.rewind', { sessionId, turnId, ...what });
      store?.setState({
        timeline: result.timeline,
        ...(result.text ? { draft: result.text } : {}),
      });
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  /** A caixa de texto já usou o rascunho. */
  takeDraft(sessionId: string): void {
    sessionStores.get(sessionId)?.setState({ draft: null });
  },

  dismissNotice(): void {
    useApp.setState({ notice: null });
  },
};
