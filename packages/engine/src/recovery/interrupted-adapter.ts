import type { AgentCapabilities } from '@solline/protocol';
import type { AgentAdapter } from '../adapters/types.ts';

/** Restoring history must never spawn a provider or resolve an old permission request. */
export function interruptedAdapter(
  capabilities: AgentCapabilities,
  providerId: string | null,
): AgentAdapter {
  const refused = async (): Promise<never> => {
    throw new Error(
      'A sessão foi recuperada e está interrompida. Retoma-a explicitamente antes de continuar.',
    );
  };
  return {
    start: refused,
    send: refused,
    setMode: refused,
    setModel: refused,
    setEffort: refused,
    interrupt: async () => undefined,
    close: async () => undefined,
    answerPermission: () => false,
    capabilities: () => capabilities,
    agentSessionId: () => providerId,
  };
}
