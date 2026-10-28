import { useCallback, useSyncExternalStore } from 'react';
import { sessionStore, useApp, useSession } from '../../stores/app.ts';
import type { SessionState } from '@solline/protocol';
import { SessionMark } from '../agents/bots.tsx';
import { labelFor } from '../agents/agent-label.tsx';
import { OpenSessionButton } from './consult-card.tsx';

const STATE: Record<SessionState, string> = {
  starting: 'a arrancar',
  idle: 'parada',
  running: 'a trabalhar',
  'needs-you': 'precisa de ti',
  error: 'caiu',
};

/** As sessões abertas por «Perguntar a…» ou «Delegar» a partir desta, pela ordem de abertura. */
export function useConsultChildren(parentId: string): string[] {
  const ids = useApp((s) => s.sessionIds);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const stops = ids.map((id) => sessionStore(id)?.subscribe(onChange));
      return () => stops.forEach((stop) => stop?.());
    },
    [ids],
  );
  const key = useSyncExternalStore(subscribe, () =>
    ids
      .filter((id) => {
        const origin = sessionStore(id)?.getState().info.origin;
        return (
          (origin?.kind === 'ask' || origin?.kind === 'delegate') && origin.sessionId === parentId
        );
      })
      .join('|'),
  );
  return key ? key.split('|') : [];
}

function ChildRow({ id }: { id: string }) {
  const title = useSession(id, (s) => s.info.title);
  const state = useSession(id, (s) => s.info.state);
  const agent = useSession(id, (s) => s.info.agent);
  const kind = useSession(id, (s) => s.info.origin?.kind);
  const agentName = useApp((s) => labelFor(s.agents, agent));
  const lead = kind === 'delegate' ? `Delegada no ${agentName}` : `Pergunta ao ${agentName}`;
  return (
    <li
      className="flex items-center gap-2.5 rounded-control border border-line bg-surface px-3 py-2"
      data-testid="consult-child"
      data-kind={kind}
    >
      <span className="grid w-4 shrink-0 place-items-center">
        <SessionMark sessionId={id} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{title}</span>
        <span className="block truncate text-[11.5px] text-muted">
          {lead} · {STATE[state]}
        </span>
      </span>
      <OpenSessionButton sessionId={id} label={`Abrir ${title}`} />
    </li>
  );
}

/** Do pedido à sessão que ele abriu: um sítio para voltar à consulta ou à delegação. */
export function SessionChildren({ sessionId }: { sessionId: string }) {
  const children = useConsultChildren(sessionId);
  if (!children.length) return null;
  return (
    <section aria-label="Consultas e delegações desta sessão" data-testid="consult-children">
      <h2 className="mb-1.5 text-[11px] font-medium tracking-[0.04em] text-subtle uppercase">
        Consultas e delegações
      </h2>
      <ul className="space-y-1.5">
        {children.map((id) => (
          <ChildRow key={id} id={id} />
        ))}
      </ul>
    </section>
  );
}
