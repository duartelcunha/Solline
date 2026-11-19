import type { CheckSpec, IssueList, PullRequest } from '@solline/protocol';
import { sessionActions } from './actions-sessions.ts';
import {
  adoptStore,
  loadSessionExtras,
  message,
  request,
  sessionStores,
  setActionError,
  storeFromItem,
  useApp,
} from './state.ts';

export const workspaceActions = {
  async loadProjects(): Promise<void> {
    const { projects } = await request('projects.list', {});
    useApp.setState((s) => ({
      projects,
      projectsLoaded: true,
      activeProjectId: s.activeProjectId ?? projects[0]?.id ?? null,
    }));
    void workspaceActions.refreshOrphans();
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

  openDesk(): void {
    useApp.setState({ view: 'desk', reviewOpen: false });
    void workspaceActions.refreshOrphans();
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
    await workspaceActions.refreshOrphans();
  },

  async discardOrphan(id: string): Promise<void> {
    try {
      await request('worktrees.discard', { id });
    } catch (error) {
      useApp.setState({ notice: message(error) });
    }
    await workspaceActions.refreshOrphans();
  },

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

  askBring(sessionId: string): void {
    useApp.setState({ bringFor: sessionId });
    const quality = sessionStores.get(sessionId)?.getState().quality;
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

  askPull(sessionId: string): void {
    useApp.setState({ pullFor: sessionId });
  },

  closePull(): void {
    useApp.setState({ pullFor: null });
  },

  clearCelebration(): void {
    useApp.setState({ celebrate: null });
  },

  async openPull(
    sessionId: string,
    title: string,
    body: string,
  ): Promise<{ pull: PullRequest } | { error: string }> {
    try {
      const pull = await request('pr.open', { sessionId, title, body });
      sessionStores.get(sessionId)?.setState({ pull, ci: null });
      return { pull };
    } catch (error) {
      return { error: message(error) };
    }
  },

  async readCi(sessionId: string): Promise<{ error?: string }> {
    const pull = sessionStores.get(sessionId)?.getState().pull;
    if (!pull) return { error: 'Ainda não há PR.' };
    try {
      const ci = await request('ci.read', { prId: pull.id });
      sessionStores.get(sessionId)?.setState({ ci });
      return {};
    } catch (error) {
      return { error: message(error) };
    }
  },

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

  async resolveConflicts(sessionId: string): Promise<void> {
    const store = sessionStores.get(sessionId);
    const conflicts = store?.getState().conflicts;
    if (!conflicts) return;
    const sent = await sessionActions.send(
      sessionId,
      `Ao trazer o teu branch para ${conflicts.into} houve conflitos em: ${conflicts.files.join(', ')}. ` +
        `Faz merge de ${conflicts.into} no teu branch, resolve os conflitos e conclui o merge.`,
    );
    if (sent) store?.setState({ conflicts: null });
  },

  async approveSetup(sessionId: string, command: string): Promise<void> {
    const projectId = sessionStores.get(sessionId)?.getState().projectId;
    if (!projectId) return;
    if (await workspaceActions.setProjectSetup(projectId, { command, copyEnv: true })) {
      await workspaceActions.retrySetup(sessionId);
    }
  },

  async retrySetup(sessionId: string): Promise<void> {
    await request('setup.retry', { sessionId }).catch((error: unknown) =>
      setActionError(sessionId, error),
    );
  },

  async fixSetup(sessionId: string): Promise<void> {
    const tail = sessionStores.get(sessionId)?.getState().info.setup?.tail ?? '';
    await sessionActions.send(
      sessionId,
      `A preparação desta worktree falhou. Resolve a causa e volta a correr o que faltar.\n\n\`\`\`\n${tail}\n\`\`\``,
    );
  },

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
};
