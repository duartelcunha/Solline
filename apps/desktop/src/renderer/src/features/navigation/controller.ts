import { create } from 'zustand';
import {
  defaultNavigation,
  NavigationPreferences,
  NavigationTarget,
  resolveStartupTarget,
  type StartupView,
} from '@solline/protocol';
import { actions, sessionStore, useApp } from '../../stores/app.ts';
import { useSpaces } from '../../stores/spaces.ts';
import { persistNavigation, persistStartup } from './persistence.ts';

export const useNavigation = create<{
  preferences: NavigationPreferences;
  ready: boolean;
  error: string | null;
}>(() => ({ preferences: defaultNavigation(), ready: false, error: null }));
let pendingTarget: NavigationTarget | null = null;
let applying = false;
let recordCurrent = () => {};

function available() {
  const state = useApp.getState();
  return {
    projects: state.projects.map((p) => p.id),
    sessions: state.sessionIds,
    races: Object.values(state.races)
      .filter((r) => r.phase !== 'closed')
      .map((r) => r.id),
    tasks: useSpaces.getState().data.tasks,
  };
}
function applyTarget(raw: NavigationTarget) {
  applying = true;
  try {
    const target = resolveStartupTarget(
      { version: 1, startupView: 'resume', lastTarget: raw },
      available(),
    );
    if (target.view === 'session') actions.selectSession(target.sessionId);
    else if (target.view === 'race') actions.openRace(target.raceId);
    else if (target.view === 'spaces') {
      // Set the selection first; openSpace publishes the coherent destination afterwards.
      useSpaces.setState({ selectedTaskId: target.taskId ?? null });
      actions.openSpace(target.projectId);
    } else actions.openDesk();
  } finally {
    applying = false;
    recordCurrent();
  }
}
export function navigateTo(raw: NavigationTarget) {
  const target = NavigationTarget.parse(raw);
  if (!useNavigation.getState().ready) pendingTarget = target;
  else applyTarget(target);
}
export function currentTarget(): NavigationTarget {
  const s = useApp.getState();
  if (s.view === 'session' && s.activeSessionId)
    return { view: 'session', sessionId: s.activeSessionId };
  if (s.view === 'race' && s.activeRaceId) return { view: 'race', raceId: s.activeRaceId };
  if (s.view === 'spaces') {
    const taskId = useSpaces.getState().selectedTaskId;
    const task = useSpaces
      .getState()
      .data.tasks.find((t) => t.id === taskId && t.projectId === s.spaceProjectId);
    return { view: 'spaces', projectId: s.spaceProjectId, ...(task ? { taskId: task.id } : {}) };
  }
  return { view: 'desk' };
}

/** Preferences hydrate once; later recovery snapshots must not reapply the startup choice. */
export function connectNavigation(): () => void {
  let disposed = false;
  let loaded = false;
  let initialized = false;
  let saved = '';
  let generation = 0;
  useNavigation.setState({ ready: false, error: null });
  async function persist(target: NavigationTarget) {
    saved = JSON.stringify(target);
    const version = ++generation;
    try {
      await persistNavigation(target);
      if (!disposed && version === generation) useNavigation.setState({ error: null });
    } catch {
      if (!disposed && version === generation)
        useNavigation.setState({
          error:
            'Não foi possível guardar onde estavas. Mantém a aplicação aberta e tenta novamente.',
        });
    }
  }
  const observe = () => {
    if (
      disposed ||
      applying ||
      !loaded ||
      useApp.getState().recoveryStatus !== 'ready' ||
      !useApp.getState().projectsLoaded
    )
      return;
    if (!initialized) {
      initialized = true;
      const preferences = useNavigation.getState().preferences;
      // Existing installations have no navigation file; preserve their previous session fallback.
      const legacySession = useApp.getState().activeSessionId;
      const lastTarget =
        preferences.lastTarget ??
        (legacySession && sessionStore(legacySession)
          ? { view: 'session' as const, sessionId: legacySession }
          : null);
      const target =
        pendingTarget ?? resolveStartupTarget({ ...preferences, lastTarget }, available());
      pendingTarget = null;
      saved = JSON.stringify(target);
      applyTarget(target);
      useNavigation.setState({ ready: true });
      // Write the resolved destination once, including the migration from older installations.
      void persist(currentTarget());
      return;
    }
    const target = currentTarget();
    if (JSON.stringify(target) !== saved) {
      void persist(target);
    }
  };
  const offApp = useApp.subscribe(observe);
  recordCurrent = observe;
  const offSpaces = useSpaces.subscribe(observe);
  void window.solline.navigation
    .read()
    .then((raw) => {
      if (disposed) return;
      useNavigation.setState({ preferences: NavigationPreferences.parse(raw) });
      loaded = true;
      observe();
    })
    .catch(() => {
      if (disposed) return;
      // Corrupt/unreadable preferences never get silently overwritten.
      useNavigation.setState({
        ready: true,
        error: 'Não foi possível ler as preferências de arranque. O ficheiro foi preservado.',
      });
    });
  return () => {
    disposed = true;
    offApp();
    offSpaces();
    if (recordCurrent === observe) recordCurrent = () => {};
  };
}

export async function setStartupView(startupView: StartupView): Promise<void> {
  try {
    const preferences = NavigationPreferences.parse(await persistStartup(startupView));
    useNavigation.setState({ preferences, error: null });
  } catch {
    useNavigation.setState({ error: 'Não foi possível guardar a escolha. Tenta novamente.' });
  }
}
