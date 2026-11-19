import type {
  CommandResult,
  RaceLaneSpec,
  RaceProposal,
  SplitPart,
  SplitPartSpec,
  SplitReview,
} from '@solline/protocol';
import { createSessionStore } from '../session.ts';
import {
  adoptMissingLanes,
  adoptStore,
  beginStartingSplit,
  disposeSessionStore,
  endStartingSplit,
  loadSessionExtras,
  message,
  request,
  resolvers,
  useApp,
} from './state.ts';

export const raceActions = {
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

  async closeRace(raceId: string, keep?: string): Promise<boolean> {
    try {
      const result = await request('race.close', { raceId, ...(keep ? { keep } : {}) });
      if (!result.closed) return false;
      const lanes = new Set([
        ...(useApp.getState().races[raceId]?.lanes.map((lane) => lane.sessionId) ?? []),
        ...(resolvers.get(raceId) ?? []),
      ]);
      resolvers.delete(raceId);
      for (const id of lanes) disposeSessionStore(id);
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

  async planSplit(projectId: string, text: string): Promise<CommandResult<'split.plan'> | null> {
    try {
      return await request('split.plan', { projectId, text });
    } catch (error) {
      useApp.setState({ notice: `Não consegui ler o projeto para partir. ${message(error)}` });
      return null;
    }
  },

  async reviewSplit(parts: SplitPart[], checkIds: string[]): Promise<SplitReview | null> {
    try {
      return await request('split.review', { parts, checkIds });
    } catch {
      return null;
    }
  },

  async startSplit(projectId: string, text: string, parts: SplitPartSpec[]): Promise<boolean> {
    beginStartingSplit();
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
      endStartingSplit();
      void adoptMissingLanes(useApp.getState().races[race.id] ?? race);
      return true;
    } catch (error) {
      endStartingSplit();
      useApp.setState({ notice: `A repartição não arrancou. ${message(error)}` });
      return false;
    }
  },

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
};
