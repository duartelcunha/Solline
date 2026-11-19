import { mcpCatalogActions } from './mcp-catalog.ts';
import { brainActions } from './app/actions-brain.ts';
import { handoffActions } from './app/actions-handoff.ts';
import { qualityActions } from './app/actions-quality.ts';
import { raceActions } from './app/actions-races.ts';
import { sessionActions } from './app/actions-sessions.ts';
import { workspaceActions } from './app/actions-workspace.ts';

export {
  adoptConsultSessions,
  flushDrafts,
  sessionStore,
  useApp,
  useSession,
  type AppState,
} from './app/state.ts';
export { dispatch } from './app/dispatch.ts';
export { connectRecovery, restoreSnapshot } from './app/recovery.ts';

export const actions = {
  ...mcpCatalogActions,
  ...brainActions,
  ...sessionActions,
  ...workspaceActions,
  ...raceActions,
  ...handoffActions,
  ...qualityActions,
};
