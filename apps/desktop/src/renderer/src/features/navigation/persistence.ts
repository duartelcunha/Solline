import type { NavigationPreferences, NavigationTarget, StartupView } from '@solline/protocol';

let pending: Promise<unknown> = Promise.resolve();
let latest: NavigationTarget | null = null;
let startup: StartupView | undefined;
export function persistStartup(startupView: StartupView): Promise<NavigationPreferences> {
  startup = startupView;
  const write = window.solline.navigation.update({ startupView });
  pending = write;
  return write;
}
/** Dispatch immediately; the main process serializes and acknowledges durable writes. */
export function persistNavigation(target: NavigationTarget): Promise<unknown> {
  latest = target;
  pending = window.solline.navigation.update({ lastTarget: target });
  return pending;
}
export async function flushNavigation(): Promise<void> {
  // The close handshake freezes input first. Reassert the latest choices so a transient
  // earlier write failure cannot be hidden by a later successful, unrelated patch.
  if (latest || startup)
    pending = window.solline.navigation.update({
      ...(latest ? { lastTarget: latest } : {}),
      ...(startup ? { startupView: startup } : {}),
    });
  await pending;
}
