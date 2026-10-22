import { useEffect, useState } from 'react';
import type { AgentDescriptor } from '@solline/protocol';
import { Bot, HOODS, STATE_COLOURS, type Hood, type Mood } from '@solline/ui/bot';
import { useApp, useSession } from '../../stores/app.ts';
import { hoodOf, moodOf, nextMoodChange } from './bot-mood.ts';

/**
 * O bot de cada sessão: silhueta e cor dizem o agente, expressão e rótulo dizem o estado. Aqui
 * só se traduz a sessão para o bot; o desenho vive em @solline/ui/bot.
 */

const NAMES: Partial<Record<Hood, string>> = { claude: 'Claude', codex: 'Codex' };
const MOOD_LABEL: Record<Mood, string> = {
  waiting: 'à espera',
  working: 'a trabalhar',
  'needs-you': 'precisa de ti',
  done: 'concluído',
  crashed: 'erro',
  sleeping: 'em repouso',
  reading: 'a ler',
};

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

/** alive: o bot da sessão aberta, o único que pisca. */
export function SessionBot({
  sessionId,
  size,
  alive = false,
}: {
  sessionId: string;
  size?: number;
  alive?: boolean;
}) {
  const agent = useSession(sessionId, (s) => s.info.agent);
  const transport = useApp((s) => s.agents.find((a) => a.id === agent)?.transport);
  const hood = hoodOf(agent, transport);
  const mood = useSessionMood(sessionId);
  return (
    <Bot
      hood={hood}
      mood={mood}
      size={size}
      title={`${NAMES[hood] ?? agent}: ${MOOD_LABEL[mood]}`}
      alive={alive}
    />
  );
}

/**
 * A marca de uma sessão na lista: só o capuz, sem cara. O bot inteiro fica no cabeçalho da
 * sessão aberta; aqui basta a cor do agente e o estado (âmbar precisa de ti, vermelho caiu,
 * estático enquanto trabalha, apagado a dormir).
 */
export function SessionMark({ sessionId, size = 12 }: { sessionId: string; size?: number }) {
  const agent = useSession(sessionId, (s) => s.info.agent);
  const transport = useApp((s) => s.agents.find((a) => a.id === agent)?.transport);
  const mood = useSessionMood(sessionId);
  const fill =
    mood === 'needs-you'
      ? STATE_COLOURS.attention
      : mood === 'crashed'
        ? STATE_COLOURS.danger
        : HOODS[hoodOf(agent, transport)];
  return (
    <svg
      aria-hidden
      width={size}
      height={(size * 8) / 12}
      viewBox="0 0 12 8"
      data-testid="session-mark"
      data-mood={mood}
      className={`shrink-0 transition-opacity duration-300 ${mood === 'sleeping' ? 'opacity-40' : ''}`}
    >
      <path d="M0 7.5a6 6 0 0 1 12 0z" fill={fill} style={{ transition: 'fill 200ms ease' }} />
    </svg>
  );
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

/** O familiar amarelo recebe-te no início e nos projetos vazios. */
export function Familiar({ size = 120 }: { size?: number }) {
  return (
    <span data-testid="familiar" className="sl-enter sl-motion select-none">
      <Bot hood="familiar" mood="waiting" size={size} alive />
    </span>
  );
}
