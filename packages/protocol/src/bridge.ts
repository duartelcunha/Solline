import type { CommandName, CommandPayload, CommandResult } from './commands.ts';
import type { EngineEvent } from './events.ts';

export type Theme = 'light' | 'dark';

/** A única superfície que o preload expõe à interface (window.solline). */
export interface SollineApi {
  /** Qualquer comando do contrato; o main valida e encaminha. */
  request<C extends CommandName>(command: C, payload: CommandPayload<C>): Promise<CommandResult<C>>;
  /** Eventos do motor, já validados no main. Devolve a função para deixar de ouvir. */
  onEvent(listener: (event: EngineEvent) => void): () => void;
  window: {
    setTheme(theme: Theme): Promise<void>;
  };
  /** Clicaste num aviso do Windows: a interface abre essa sessão. */
  onFocusSession(listener: (sessionId: string) => void): () => void;
}

/** Canais IPC entre preload e main. */
export const IPC = {
  request: 'solline:request',
  event: 'solline:event',
  setTheme: 'solline:set-theme',
  focusSession: 'solline:focus-session',
} as const;
