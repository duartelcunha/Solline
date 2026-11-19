import { create, useStore } from 'zustand';
import type {
  AgentDescriptor,
  AgentId,
  CommandName,
  CommandPayload,
  CommandResult,
  EngineEvent,
  EngineSnapshot,
  McpServerDescriptor,
  Orphan,
  Project,
  Race,
  RecoveryOperation,
} from '@solline/protocol';
import { flushNavigation } from '../../features/navigation/persistence.ts';
import { morphUpdate } from '../../lib/morph.ts';
import { onMcpNotice } from '../mcp-catalog.ts';
import {
  createSessionStore,
  reduceSession,
  type SessionData,
  type SessionStore,
} from '../session.ts';
import { receiveSpaces } from '../spaces.ts';

/**
 * Estado da app: projetos, a lista de sessões e qual está aberta. Cada sessão tem o
 * seu próprio store (stores/session.ts) para o streaming de uma não redesenhar as outras.
 */
export interface AppState {
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
  /** A sessão cujo PR está aberto (formulário ou checks). */
  pullFor: string | null;
  /** O projeto cuja lista de issues está aberta. */
  issuesFor: string | null;
  /** A sessão cujo PR acabou de entrar. A celebração é uma. */
  celebrate: string | null;
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
  pullFor: null,
  issuesFor: null,
  celebrate: null,
  mapOpen: false,
  view: 'desk',
  spaceProjectId: null,
  orphans: [],
  races: {},
  activeRaceId: null,
}));

// Os erros do catálogo MCP aparecem no mesmo aviso que os do resto da app.
onMcpNotice((text) => useApp.setState({ notice: text }));

export const sessionStores = new Map<string, SessionStore>();
export const draftSubscriptions = new Map<string, () => void>();
export const draftWrites = new Map<string, Promise<unknown>>();
/** Eventos de sessões que a interface ainda não conhece (chegaram antes da resposta). */
export const earlyEvents = new Map<string, EngineEvent[]>();
/** Pistas cuja loja está a ser pedida ao motor (uma só vez de cada). */
export const adopting = new Set<string>();
/** As sessões de resolução de conflitos de cada repartição (fecham com ela). */
export const resolvers = new Map<string, Set<string>>();
/** Todos os eventos de sessão passam pela mesma fila, para uma transformação não trocar a ordem. */
export const enqueue = morphUpdate;

let startingSplits = 0;
let childAdoption: ReturnType<typeof setTimeout> | undefined;

export function beginStartingSplit(): void {
  startingSplits++;
}

export function endStartingSplit(): void {
  startingSplits--;
}

export function isStartingSplit(): boolean {
  return startingSplits > 0;
}

export function request<C extends CommandName>(
  command: C,
  payload: CommandPayload<C>,
): Promise<CommandResult<C>> {
  return window.solline.request(command, payload);
}

export function message(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method[^:]*: /, '')
    : String(error);
}

export function setActionError(sessionId: string, error: unknown): void {
  sessionStores.get(sessionId)?.setState({ actionError: message(error) });
}

export function persistDraft(id: string, store: SessionStore): Promise<unknown> {
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

export async function flushUiClose(): Promise<void> {
  await flushDrafts();
  await flushNavigation();
}

/** A loja de uma sessão do snapshot, com tudo o que o motor já sabe dela. */
export function storeFromItem(item: EngineSnapshot['sessions'][number]): SessionStore {
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

/**
 * Regista a loja de uma sessão nova e aplica-lhe o que já tinha chegado. Se a loja vem de um
 * snapshot (`afterSequence`), os eventos que o snapshot já contém não se aplicam outra vez.
 */
export function adoptStore(id: string, store: SessionStore, afterSequence?: number): void {
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

export function disposeSessionStore(id: string): void {
  sessionStores.delete(id);
  draftSubscriptions.get(id)?.();
  draftSubscriptions.delete(id);
  draftWrites.delete(id);
}

/**
 * Uma parte que arranca depois da parte zero chega à interface só por um race.state: ainda não
 * há loja para ela. Pede-se o snapshot ao motor e adotam-se as pistas que faltam.
 */
export async function adoptMissingLanes(race: Race): Promise<void> {
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
export function scheduleChildAdoption(): void {
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

/** A segunda opinião e as verificações de uma sessão acabada de abrir. */
export function loadSessionExtras(sessionId: string, store: SessionStore): void {
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

export function openNewSessionStore(
  session: SessionData['info'],
  projectId: string,
  capabilities: SessionData['capabilities'],
  afterSequence?: number,
): SessionStore {
  const store = createSessionStore(session, projectId, capabilities);
  adoptStore(session.id, store, afterSequence);
  useApp.setState((s) => ({
    sessionIds: [session.id, ...s.sessionIds.filter((id) => id !== session.id)],
    activeSessionId: session.id,
    view: 'session',
  }));
  loadSessionExtras(session.id, store);
  return store;
}

/** O agente das sessões abertas sem escolher: o primeiro pronto, senão o Claude. */
export function defaultAgent(): AgentId {
  return useApp.getState().agents.find((a) => a.status === 'ready')?.id ?? 'claude';
}

/** Um comando de memória que devolve os Espaços: o estado novo entra na interface. */
export async function memoryRequest<C extends 'memory.approve' | 'memory.reject' | 'memory.confirm'>(
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
