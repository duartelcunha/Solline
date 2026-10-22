import type { CommandName, CommandPayload, CommandResult } from './commands.ts';
import type { EngineEvent } from './events.ts';
import type { DiffScope, ReviewComment } from './review.ts';
import type { NavigationPreferences, NavigationUpdate } from './navigation.ts';

export type Theme = 'light' | 'dark';

export type WindowAction = 'minimize' | 'toggle-maximize' | 'close';
export type WindowState = { maximized: boolean; customControls: boolean; revision: number };
export type ReviewDraft = {
  scope: DiffScope;
  comments: ReviewComment[];
  note: string;
  editing: ReviewComment | null;
};
export type SavedDraft = { text: string; pendingSend: string | null; review?: ReviewDraft };
export type DraftUpdate = SavedDraft & { sessionId: string };
export type UiRecoveryState = { version: 1; revision: number; drafts: Record<string, SavedDraft> };
export type RecoveryNotice = {
  reason: 'unresponsive' | 'crashed' | 'save-failed' | 'close';
  message: string;
  canWait: boolean;
  busy: boolean;
  theme: Theme;
};

/** A única superfície que o preload expõe à interface (window.solline). */
export interface SollineApi {
  navigation: {
    read(): Promise<NavigationPreferences>;
    update(patch: NavigationUpdate): Promise<NavigationPreferences>;
  };
  /** Qualquer comando do contrato; o main valida e encaminha. */
  request<C extends CommandName>(command: C, payload: CommandPayload<C>): Promise<CommandResult<C>>;
  /** Eventos do motor, já validados no main. Devolve a função para deixar de ouvir. */
  onEvent(listener: (event: EngineEvent) => void): () => void;
  window: {
    setTheme(theme: Theme): Promise<void>;
    state(): Promise<WindowState>;
    action(action: WindowAction): Promise<void>;
    onState(listener: (state: WindowState) => void): () => void;
    onPrepareClose(listener: () => Promise<void>): () => void;
    onCloseCancelled(listener: () => void): () => void;
  };
  recovery: {
    open(): Promise<void>;
    ui(): Promise<UiRecoveryState>;
    saveDraft(update: DraftUpdate): Promise<number>;
  };
  /** Clicaste num aviso da Solline: a interface abre essa sessão. */
  onFocusSession(listener: (sessionId: string) => void): () => void;
}

/** Canais IPC entre preload e main. */
export const IPC = {
  navigationRead: 'solline:navigation-read',
  navigationUpdate: 'solline:navigation-update',
  request: 'solline:request',
  event: 'solline:event',
  setTheme: 'solline:set-theme',
  focusSession: 'solline:focus-session',
  windowState: 'solline:window-state',
  windowAction: 'solline:window-action',
  prepareClose: 'solline:prepare-close',
  preparedClose: 'solline:prepared-close',
  closeCancelled: 'solline:close-cancelled',
  recoveryUi: 'solline:recovery-ui',
  recoveryOpen: 'solline:recovery-open',
  recoveryDraft: 'solline:recovery-draft',
  recoveryNotice: 'solline:recovery-notice',
  recoveryAction: 'solline:recovery-action',
  healthProbe: 'solline:health-probe',
  healthReply: 'solline:health-reply',
} as const;
