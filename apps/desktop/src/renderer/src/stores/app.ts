import { create } from 'zustand';
import { useStore } from 'zustand';
import type {
  AgentDescriptor,
  AgentId,
  McpServerDescriptor,
  CommandName,
  CommandPayload,
  CommandResult,
  EngineEvent,
  PermissionAnswer,
  Project,
} from '@solline/protocol';
import {
  createSessionStore,
  reduceSession,
  type SessionData,
  type SessionStore,
} from './session.ts';

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
  /** O painel de agentes está aberto. */
  agentsPanel: boolean;
  /** A voltar a verificar os agentes (Verificar de novo). */
  checkingAgents: boolean;
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
  agentsPanel: false,
  checkingAgents: false,
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
      const { info } = store.getState();
      if (info.state !== 'error') {
        store.setState(
          reduceSession(store.getState(), {
            kind: 'event',
            type: 'session.state',
            sessionId: info.id,
            state: 'error',
            error: event.message,
          }),
        );
      }
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
  if (store) store.setState(reduceSession(store.getState(), event));
}

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
    useApp.setState({ notice: null });
    try {
      await request('agents.login', { agent });
    } catch (error) {
      useApp.setState({ notice: `Não foi possível entrar. ${message(error)}` });
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
    });
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
      sessionStores.set(session.id, createSessionStore(session, projectId, capabilities));
      useApp.setState((s) => ({
        sessionIds: [session.id, ...s.sessionIds],
        activeSessionId: session.id,
      }));
    } catch (error) {
      useApp.setState({ notice: `Não foi possível abrir a sessão. ${message(error)}` });
    } finally {
      useApp.setState({ creatingIn: null });
    }
  },

  async send(sessionId: string, text: string): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('session.send', { sessionId, text });
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
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

  dismissNotice(): void {
    useApp.setState({ notice: null });
  },
};
