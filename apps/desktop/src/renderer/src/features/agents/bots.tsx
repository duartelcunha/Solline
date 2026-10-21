import { useEffect, useState } from 'react';
import type { AgentDescriptor } from '@solline/protocol';
import { Bot, type Hood, type Mood } from '@solline/ui/bot';
import { useApp, useSession } from '../../stores/app.ts';
import { hoodOf, moodOf, nextMoodChange } from './bot-mood.ts';

/**
 * O bot de cada sessão: a cor do capuz diz o agente, a cara e a bainha dizem o estado. Aqui
 * só se traduz a sessão para o bot; o desenho vive em @solline/ui/bot.
 */

const NAMES: Partial<Record<Hood, string>> = { claude: 'Claude', codex: 'Codex' };

/** O humor de uma sessão, que muda sozinho no fim dos olhos contentes e ao adormecer. */
function useSessionMood(sessionId: string): Mood {
  const state = useSession(sessionId, (s) => s.info.state);
  const stateSince = useSession(sessionId, (s) => s.stateSince);
  const turnEndedAt = useSession(sessionId, (s) => s.turnEndedAt);
  const [now, setNow] = useState(() => Date.now());
  const input = { state, stateSince, turnEndedAt };
  const next = nextMoodChange(input, now);
  useEffect(() => {
    // Acorda no próximo limite (e logo, se o estado acabou de mudar).
    const wait = next === null ? null : Math.max(0, next - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), wait ?? 0);
    return () => clearTimeout(timer);
  }, [next, state, stateSince, turnEndedAt]);
  return moodOf(input, Math.max(now, stateSince));
}

export function SessionBot({ sessionId, size }: { sessionId: string; size?: number }) {
  const agent = useSession(sessionId, (s) => s.info.agent);
  const transport = useApp((s) => s.agents.find((a) => a.id === agent)?.transport);
  const hood = hoodOf(agent, transport);
  return <Bot hood={hood} mood={useSessionMood(sessionId)} size={size} title={NAMES[hood]} />;
}

/** O bot de um agente fora de uma sessão (escolha do agente, painel), cinzento se não está pronto. */
export function AgentBot({ agent, size = 22 }: { agent: AgentDescriptor; size?: number }) {
  const ready = agent.status === 'ready';
  return (
    <Bot
      hood={hoodOf(agent.id, agent.transport)}
      mood={agent.login?.pending ? 'working' : 'waiting'}
      size={size}
      className={ready ? undefined : 'opacity-60 grayscale'}
    />
  );
}

/** O familiar: o bot cinzento da Solline, que te recebe no início e nos projetos vazios. */
export function Familiar({ size = 120 }: { size?: number }) {
  return (
    <span data-testid="familiar" className="sl-enter sl-motion select-none">
      <Bot hood="familiar" mood="waiting" size={size} />
    </span>
  );
}
