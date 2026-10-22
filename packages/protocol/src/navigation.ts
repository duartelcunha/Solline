import { z } from 'zod';

export const StartupView = z.enum(['resume', 'general-tasks', 'desk']);
export type StartupView = z.infer<typeof StartupView>;
const Id = z.string().min(1).max(128);
export const NavigationTarget = z.discriminatedUnion('view', [
  z.object({ view: z.literal('desk') }).strict(),
  z.object({ view: z.literal('spaces'), projectId: Id.nullable(), taskId: Id.optional() }).strict(),
  z.object({ view: z.literal('session'), sessionId: Id }).strict(),
  z.object({ view: z.literal('race'), raceId: Id }).strict(),
]);
export type NavigationTarget = z.infer<typeof NavigationTarget>;
export const NavigationPreferences = z
  .object({
    version: z.literal(1),
    startupView: StartupView,
    lastTarget: NavigationTarget.nullable(),
  })
  .strict();
export type NavigationPreferences = z.infer<typeof NavigationPreferences>;
export const NavigationUpdate = z
  .object({
    startupView: StartupView.optional(),
    lastTarget: NavigationTarget.optional(),
  })
  .strict();
export type NavigationUpdate = z.infer<typeof NavigationUpdate>;
export const defaultNavigation = (): NavigationPreferences => ({
  version: 1,
  startupView: 'resume',
  lastTarget: null,
});

/** Resolve only against rehydrated identities; this never starts or resumes work. */
export function resolveStartupTarget(
  preferences: NavigationPreferences,
  available: {
    projects: readonly string[];
    sessions: readonly string[];
    races: readonly string[];
    tasks: readonly { id: string; projectId: string | null }[];
  },
): NavigationTarget {
  const fallback: NavigationTarget = { view: 'spaces', projectId: null };
  if (preferences.startupView === 'desk') return { view: 'desk' };
  if (preferences.startupView === 'general-tasks') return fallback;
  const target = preferences.lastTarget;
  if (!target) return fallback;
  if (target.view === 'session')
    return available.sessions.includes(target.sessionId) ? target : fallback;
  if (target.view === 'race') return available.races.includes(target.raceId) ? target : fallback;
  if (target.view === 'spaces') {
    if (target.projectId !== null && !available.projects.includes(target.projectId))
      return fallback;
    if (
      target.taskId &&
      !available.tasks.some(
        (task) =>
          task.id === target.taskId &&
          (target.projectId === null || task.projectId === target.projectId),
      )
    ) {
      return { view: 'spaces', projectId: target.projectId };
    }
  }
  return target;
}
