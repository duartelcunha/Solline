import { ChevronRight, Handshake } from 'lucide-react';
import { actions, useApp, useSession } from '../../stores/app.ts';
import { handedBanner, lineageLine } from './handoff-model.ts';

/** O título de uma sessão aberta, se ainda estiver aberta. */
function useOpenSession(id: string | undefined) {
  const open = useApp((s) => (id ? s.sessionIds.includes(id) : false));
  const title = useSession(open ? (id ?? null) : null, (s) => s.info.title);
  return open && id ? { id, title } : undefined;
}

/**
 * "veio de <título> ›": por baixo do título de uma sessão que nasceu de outra (passagem ou
 * bifurcação). Clicar abre a sessão de origem; se já não está aberta, só se lê.
 */
export function SessionOriginLink({ sessionId }: { sessionId: string }) {
  const origin = useSession(sessionId, (s) => s.info.origin);
  const parent = useOpenSession(origin?.sessionId);
  // O número do turno de uma bifurcação vem da linha do tempo da origem.
  const turnNumber = useSession(parent?.id ?? null, (s) =>
    origin?.turnId
      ? (s.timeline?.checkpoints.find((c) => c.turnId === origin.turnId)?.index ?? null)
      : null,
  );
  const line = lineageLine(origin, parent, turnNumber);
  if (!line) return null;
  const { sessionId: parentId } = line;
  return (
    <span
      className="flex min-w-0 items-center gap-1 text-[11.5px] text-muted"
      data-testid="session-origin"
      data-kind={origin?.kind}
    >
      <span className="shrink-0">{line.lead}</span>
      {parentId && line.title ? (
        <button
          type="button"
          onClick={() => actions.selectSession(parentId)}
          title={`Abrir ${line.title}`}
          data-testid="session-origin-open"
          className="no-drag sl-press inline-flex min-w-0 items-center gap-0.5 rounded-sm font-medium text-fg hover:underline focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] focus-visible:outline-none"
        >
          <span className="truncate">{line.title}</span>
          <ChevronRight size={12} strokeWidth={2} aria-hidden className="shrink-0 text-subtle" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * Uma sessão que passou o testemunho só se lê: o aviso diz a quem passou, deixa abrir essa
 * sessão ou retomar aqui (a pasta volta a esta e a outra fica em pausa).
 */
export function HandedBanner({ sessionId }: { sessionId: string }) {
  const handedTo = useSession(sessionId, (s) => s.info.handedTo);
  const busy = useSession(sessionId, (s) => s.info.state !== 'idle');
  const target = useOpenSession(handedTo);
  const banner = handedBanner(handedTo, target);
  if (!banner) return null;
  return (
    <div
      role="status"
      data-testid="handed-banner"
      className="sl-enter sl-motion flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/50 bg-surface-sunken px-5 py-2.5"
    >
      <Handshake size={15} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden />
      <p className="min-w-0 flex-1 text-[12.5px] font-medium">{banner.text}</p>
      <div className="flex shrink-0 items-center gap-1.5">
        {banner.targetId ? (
          <button
            type="button"
            onClick={() => actions.selectSession(banner.targetId ?? '')}
            data-testid="handed-open"
            className="sl-press inline-flex h-8 items-center rounded-control border border-line px-3 text-[12.5px] font-medium hover:bg-surface-hover"
          >
            Abrir
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void actions.resumeHandoff(sessionId)}
          title={
            busy
              ? 'A sessão ainda está ocupada'
              : 'A pasta volta a esta sessão e a outra fica em pausa'
          }
          data-testid="handed-resume"
          className="sl-press inline-flex h-8 items-center rounded-control bg-fg px-3 text-[12.5px] font-medium text-bg disabled:opacity-50"
        >
          Retomar aqui
        </button>
      </div>
    </div>
  );
}
