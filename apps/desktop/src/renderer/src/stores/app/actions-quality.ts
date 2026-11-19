import type { BudgetLimits, DiffScope, FileDiff, ReviewAction, ReviewComment } from '@solline/protocol';
import { request, sessionStores, setActionError, useApp } from './state.ts';

export const qualityActions = {
  toggleReview(open?: boolean): void {
    useApp.setState((s) => ({ reviewOpen: open ?? !s.reviewOpen }));
  },

  async diff(sessionId: string, scope: DiffScope): Promise<FileDiff[] | null> {
    try {
      return (await request('review.diff', { sessionId, scope })).files;
    } catch (error) {
      setActionError(sessionId, error);
      return null;
    }
  },

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

  async setQualityEnabled(sessionId: string, enabled: boolean): Promise<void> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      const quality = await request('quality.setEnabled', { sessionId, enabled });
      sessionStores.get(sessionId)?.setState({ quality });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

  async reviewAgain(sessionId: string): Promise<void> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('quality.review', { sessionId });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

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

  async runChecks(sessionId: string): Promise<void> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('checks.run', { sessionId });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

  async setRepair(sessionId: string, enabled: boolean): Promise<void> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('repair.set', { sessionId, enabled });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

  async cancelRepair(sessionId: string): Promise<void> {
    try {
      await request('repair.cancel', { sessionId });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

  async setBudget(sessionId: string, limits: BudgetLimits): Promise<void> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('ledger.budget', { sessionId, ...limits });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },

  async fixCheck(sessionId: string, id: string): Promise<void> {
    sessionStores.get(sessionId)?.setState({ actionError: null });
    try {
      await request('checks.fix', { sessionId, id });
    } catch (error) {
      setActionError(sessionId, error);
    }
  },
};
