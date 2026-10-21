import { create } from 'zustand';
import { useStore } from 'zustand';
import type {
  AgentDescriptor,
  AgentId,
  McpServerDescriptor,
  CommandName,
  CommandPayload,
  CheckSpec,
  CommandResult,
  Orphan,
  DiffScope,
  EngineEvent,
  FileDiff,
  PermissionAnswer,
  Project,
  ReviewAction,
  ReviewComment,
} from '@solline/protocol';
import {
  createSessionStore,
  reduceSession,
  type SessionData,
  type SessionStore,
} from './session.ts';
import { createMorphQueue, morphs } from '../lib/morph.ts';

/**
 * Estado da app: projetos, a lista de sessões e qual está aberta. Cada sessão tem o
 * seu próprio store (stores/session.ts) para o streaming de uma não redesenhar as outras.
 */
interface AppState {
  projects: Project[];
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
  } | null;
  /** A vista principal: a mesa com todas as sessões, ou a conversa da sessão ativa. */
  view: 'desk' | 'session';
  /** Worktrees que ficaram no disco sem sessão (por trazer). */
  orphans: Orphan[];
}

export const useApp = create<AppState>(() => ({
  projects: [],
  agents: [],
  mcpServers: [],
  mcpSelection: [],
  sessionIds: [],
  activeProjectId: null,
  activeSessionId: null,
  creatingIn: null,
  notice: null,
  reviewOpen: false,
  agentsPanel: false,
  checkingAgents: false,
  loginRequests: [],
  closing: null,
  view: 'desk',
  orphans: [],
}));

const sessionStores = new Map<string, SessionStore>();

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

/** Todos os eventos do motor entram por aqui. */
export function dispatch(event: EngineEvent): void {
  if (event.type === 'engine.error') {
    useApp.setState({ notice: event.message });
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
  if (event.type === 'engine.ready') return;
  if (event.type === 'agents.changed') {
    if (event.error) useApp.setState({ notice: event.error });
    void actions.loadAgents();
    return;
  }
  const store = sessionStores.get(event.sessionId);
  if (!store) return;
  const apply = () => store.setState(reduceSession(store.getState(), event));
  // Na sessão à vista, as mudanças de forma (um pedido respondido, a vez a passar) transformam-se.
  enqueue(apply, event.sessionId === useApp.getState().activeSessionId && morphs(event));
}

/** Todos os eventos de sessão passam pela mesma fila, para uma transformação não trocar a ordem. */
const enqueue = createMorphQueue();

/** O agente das sessões abertas sem escolher: o primeiro pronto, senão o Claude. */
function defaultAgent(): AgentId {
  return useApp.getState().agents.find((a) => a.status === 'ready')?.id ?? 'claude';
}

export const actions = {
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
      sessionStores.set(session.id, store);
      useApp.setState((s) => ({
        sessionIds: [session.id, ...s.sessionIds],
        activeSessionId: session.id,
        view: 'session',
      }));
      // Um evento que chegue primeiro é mais recente: o pedido inicial não o pisa.
      void request('quality.get', { sessionId: session.id })
        .then((quality) => {
          if (store.getState().quality === null) store.setState({ quality });
        })
        .catch(() => undefined);
      void request('checks.get', { sessionId: session.id })
        .then((checks) => {
          if (store.getState().checks === null) store.setState({ checks });
        })
        .catch(() => undefined);
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
  ): Promise<void> {
    try {
      const result = await request('session.close', {
        sessionId,
        ...(worktree ? { worktree } : {}),
        ...(dropQueue ? { dropQueue } : {}),
      });
      if (!result.closed) {
        if (result.queued) {
          useApp.setState({
            closing: { sessionId, files: 0, additions: 0, deletions: 0, queued: result.queued },
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
          useApp.setState({ closing: { sessionId, ...result.stats } });
        }
        return;
      }
      sessionStores.delete(sessionId);
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

  async unqueue(sessionId: string, id: string): Promise<void> {
    await request('session.unqueue', { sessionId, id }).catch((error: unknown) =>
      setActionError(sessionId, error),
    );
  },

  async reorderQueue(sessionId: string, ids: string[]): Promise<void> {
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
    await actions.unqueue(sessionId, id);
    store.setState({ draft: item.text });
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

  async answer(sessionId: string, requestId: string, answer: PermissionAnswer): Promise<void> {
    await request('permission.answer', { sessionId, requestId, answer }).catch((error: unknown) =>
      setActionError(sessionId, error),
    );
  },

  /** Retoma uma sessão cujo claude.exe caiu (resume do agente, mesmo histórico). */
  async resume(sessionId: string): Promise<void> {
    const store = sessionStores.get(sessionId);
    store?.setState({ actionError: null });
    try {
      const { capabilities } = await request('session.resume', { sessionId });
      store?.setState({ capabilities });
    } catch (error) {
      setActionError(sessionId, error);
    }
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
