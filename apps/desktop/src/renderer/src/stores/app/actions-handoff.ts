import type { AgentId, CommandResult, HandoffDraftedBy } from '@solline/protocol';
import { createSessionStore } from '../session.ts';
import {
  adoptStore,
  loadSessionExtras,
  openNewSessionStore,
  request,
  sessionStores,
  setActionError,
  useApp,
} from './state.ts';

export const handoffActions = {
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

  async cancelHandoffDraft(sessionId: string): Promise<void> {
    await request('handoff.cancelDraft', { sessionId }).catch(() => undefined);
  },

  async startHandoff(
    sessionId: string,
    agent: AgentId,
    text: string,
    options: {
      model?: string;
      effort?: string;
      goal?: string;
      draftedBy?: HandoffDraftedBy;
    } = {},
  ): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      const { session, capabilities } = await request('handoff.start', {
        sessionId,
        agent,
        text,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.goal ? { goal: options.goal } : {}),
        ...(options.draftedBy ? { draftedBy: options.draftedBy } : {}),
      });
      openNewSessionStore(session, session.projectId, capabilities);
      return true;
    } catch (error) {
      setActionError(sessionId, error);
      return false;
    }
  },

  async forkSession(sessionId: string, turnId: string): Promise<boolean> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      const { session, capabilities, turns } = await request('session.fork', {
        sessionId,
        turnId,
      });
      const store = createSessionStore(session, session.projectId, capabilities);
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
};
