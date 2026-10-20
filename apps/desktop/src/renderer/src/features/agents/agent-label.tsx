import { createContext, useContext } from 'react';
import type { AgentDescriptor } from '@solline/protocol';
import { useApp, useSession } from '../../stores/app.ts';

/** O nome do agente para a interface; sem descrição, o próprio id. */
export function labelFor(agents: readonly AgentDescriptor[], id: string): string {
  return agents.find((a) => a.id === id)?.label ?? id;
}

/** O nome do agente de uma sessão ("Claude", "Codex"…). */
export function useSessionAgentLabel(sessionId: string | null): string {
  const agent = useSession(sessionId, (s) => s.info.agent);
  return useApp((s) => labelFor(s.agents, agent));
}

/** Para os cartões dentro da conversa saberem com que agente estão a falar. */
export const AgentLabelContext = createContext('agente');

export function useAgentLabel(): string {
  return useContext(AgentLabelContext);
}
