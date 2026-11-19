import type { AgentId, ConsultDecision, PermissionAnswer } from '@solline/protocol';
import type { ReviewDraft } from '@solline/protocol/bridge';
import { createSessionStore } from '../session.ts';
import {
  adoptStore,
  defaultAgent,
  disposeSessionStore,
  message,
  openNewSessionStore,
  request,
  sessionStores,
  setActionError,
  useApp,
} from './state.ts';

export const sessionActions = {
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
        mcpSelection: s.mcpSelection.filter((id) =>
          servers.some((m) => m.id === id && m.status === 'ready'),
        ),
      }));
    } catch (error) {
      useApp.setState({ notice: `Não foi possível ver os agentes. ${message(error)}` });
    }
  },

  async refreshAgents(): Promise<void> {
    useApp.setState({ checkingAgents: true });
    try {
      await sessionActions.loadAgents(true);
    } finally {
      useApp.setState({ checkingAgents: false });
    }
  },

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
    await sessionActions.loadAgents();
  },

  async cancelLogin(agent: AgentId): Promise<void> {
    await request('agents.loginCancel', { agent }).catch((error: unknown) =>
      useApp.setState({ notice: message(error) }),
    );
    await sessionActions.loadAgents();
  },

  async setKeys(agent: AgentId, keys: string[]): Promise<boolean> {
    try {
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
    void sessionActions.loadAgents();
  },

  closeAgentsPanel(): void {
    useApp.setState({ agentsPanel: false });
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

  async createSession(projectId: string, agent: AgentId = defaultAgent()): Promise<void> {
    const project = useApp.getState().projects.find((p) => p.id === projectId);
    if (!project) return;
    useApp.setState({ creatingIn: projectId, activeProjectId: projectId, notice: null });
    try {
      const takesMcp = useApp.getState().agents.find((a) => a.id === agent)?.mcp === true;
      const mcpServerIds = takesMcp ? useApp.getState().mcpSelection : [];
      const { session, capabilities } = await request('session.create', {
        projectId: project.id,
        agent,
        ...(mcpServerIds.length ? { mcpServerIds } : {}),
      });
      openNewSessionStore(session, projectId, capabilities);
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
      disposeSessionStore(sessionId);
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

  async editQueued(sessionId: string, id: string): Promise<void> {
    const store = sessionStores.get(sessionId);
    const item = store?.getState().queue?.items.find((i) => i.id === id);
    if (!store || !item) return;
    if (await sessionActions.unqueue(sessionId, id)) store.setState({ draft: item.text });
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

  takeDraft(sessionId: string): void {
    sessionStores.get(sessionId)?.setState({ draft: null });
  },

  dismissNotice(): void {
    useApp.setState({ notice: null });
  },
};
