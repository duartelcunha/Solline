import type { CommandResult } from './commands.ts';

export type Theme = 'light' | 'dark';

/** A única superfície que o preload expõe à interface (window.solline). */
export interface SollineApi {
  engine: {
    ping(): Promise<CommandResult<'engine.ping'>>;
    sdkCheck(): Promise<CommandResult<'engine.sdkCheck'>>;
  };
  window: {
    setTheme(theme: Theme): Promise<void>;
  };
}

/** Canais IPC entre preload e main. */
export const IPC = {
  engineRequest: 'solline:engine-request',
  setTheme: 'solline:set-theme',
} as const;
