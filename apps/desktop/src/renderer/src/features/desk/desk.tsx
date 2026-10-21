import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { GitBranch, GitMerge, Trash2 } from 'lucide-react';
import type { Orphan } from '@solline/protocol';
import { useReducedMotion } from '@solline/ui/react';
import { actions, useApp, useSession } from '../../stores/app.ts';
import { SessionBot } from '../agents/bots.tsx';
import { ContextMeter, money } from '../composer/composer.tsx';
import { Mark } from '../quality/checks.tsx';
import { deskOrder, lastAction, pendingAsk } from './desk-order.ts';
import { sessionStore } from '../../stores/app.ts';

function Delta({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="font-mono text-[11px] whitespace-nowrap tabular-nums">
      <span className="text-success">+{additions}</span>{' '}
      <span className="text-danger">−{deletions}</span>
    </span>
  );
}

const smallButton =
  'sl-press inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium disabled:opacity-50';

/** O pedido à espera, em pequeno: o título e Permitir / Negar; o resto abre a conversa. */
function CompactAsk({ sessionId }: { sessionId: string }) {
  const ask = useSession(sessionId, (s) => pendingAsk(s.turns));
  if (!ask) return null;
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (ask.kind !== 'permission') {
    return (
      <div className="flex items-center gap-2 text-[12px]" onClick={stop}>
        <span className="min-w-0 flex-1 truncate text-fg">
          {ask.kind === 'plan' ? 'Um plano para aprovares' : 'Uma pergunta para ti'}
        </span>
        <button
          type="button"
          onClick={() => actions.selectSession(sessionId)}
          className={`${smallButton} bg-fg text-bg`}
        >
          Abrir
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-[12px]" onClick={stop} data-testid="card-ask">
      <span className="min-w-0 flex-1 truncate text-fg">{ask.title}</span>
      <button
        type="button"
        onClick={() => void actions.answer(sessionId, ask.id, { decision: 'allow-once' })}
        className={`${smallButton} bg-fg text-bg`}
        data-testid="card-allow"
      >
        Permitir
      </button>
      <button
        type="button"
        onClick={() => void actions.answer(sessionId, ask.id, { decision: 'deny' })}
        className={`${smallButton} border border-line hover:bg-surface-hover`}
        data-testid="card-deny"
      >
        Negar
      </button>
    </div>
  );
}

/** Um cartão por sessão: quem é, o que está a fazer, quanto gastou e se precisa de ti. */
function SessionCard({ sessionId }: { sessionId: string }) {
  const title = useSession(sessionId, (s) => s.info.title);
  const state = useSession(sessionId, (s) => s.info.state);
  const projectId = useSession(sessionId, (s) => s.projectId);
  const workspace = useSession(sessionId, (s) => s.info.workspace);
  const usage = useSession(sessionId, (s) => s.usage);
  const action = useSession(sessionId, (s) => lastAction(s.turns));
  const checks = useSession(sessionId, (s) => s.checks);
  const error = useSession(sessionId, (s) => s.error);
  const project = useApp((s) => s.projects.find((p) => p.id === projectId)?.name);
  const needsYou = state === 'needs-you';
  const idle = state === 'idle';
  const enabled = checks?.trusted ? checks.specs.filter((c) => c.enabled) : [];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => actions.selectSession(sessionId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) actions.selectSession(sessionId);
      }}
      data-testid="desk-card"
      data-session={sessionId}
      data-state={state}
      data-flip={sessionId}
      className={`sl-enter sl-motion sl-press flex cursor-pointer flex-col gap-2.5 rounded-xl border bg-surface p-3.5 text-left outline-none transition-[border-color,box-shadow] duration-200 hover:border-line-strong focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] ${
        needsYou ? 'border-accent shadow-raised' : 'border-line'
      }`}
    >
      <div className="flex items-start gap-3">
        <SessionBot sessionId={sessionId} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold tracking-[-0.01em]">{title}</div>
          <div className="truncate text-[11.5px] text-subtle">{project ?? ''}</div>
        </div>
      </div>

      {needsYou ? (
        <CompactAsk sessionId={sessionId} />
      ) : (
        <div className="min-h-[1.25rem] truncate text-[12px] text-muted" data-testid="card-action">
          {state === 'error'
            ? (error ?? 'Caiu')
            : (action ?? (idle ? 'À espera da primeira mensagem' : ''))}
        </div>
      )}

      <div className="flex items-center gap-2.5 text-[11.5px] text-muted">
        {usage.context ? (
          <ContextMeter
            used={usage.context.usedTokens}
            max={usage.context.maxTokens}
            percent={usage.context.percent}
          />
        ) : null}
        {usage.costUsd !== null ? (
          <span className="tabular-nums">{money.format(usage.costUsd)}</span>
        ) : null}
        {workspace?.kind === 'worktree' ? (
          <span className="inline-flex min-w-0 items-center gap-1" title={workspace.branch}>
            <GitBranch size={12} className="shrink-0" />
            {workspace.stats.files > 0 ? <Delta {...workspace.stats} /> : null}
          </span>
        ) : null}
        {enabled.length ? (
          <span className="inline-flex items-center gap-1" data-testid="card-checks">
            {enabled.map((c) => (
              <span key={c.id} title={c.label} className="grid size-3.5 place-items-center">
                <Mark face={checks?.results.find((r) => r.id === c.id)?.state ?? 'waiting'} />
              </span>
            ))}
          </span>
        ) : null}
        {workspace?.kind === 'worktree' && workspace.stats.files > 0 && idle ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void actions.bring(sessionId);
            }}
            className={`${smallButton} ml-auto border border-line text-fg hover:bg-surface-hover`}
            data-testid="card-bring"
          >
            <GitMerge size={13} /> Trazer
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Uma worktree que ficou por trazer quando a app fechou. */
function OrphanCard({ orphan }: { orphan: Orphan }) {
  const project = useApp((s) => s.projects.find((p) => p.id === orphan.projectId)?.name);
  return (
    <div
      data-testid="orphan-card"
      data-flip={orphan.id}
      className="sl-enter sl-motion flex flex-col gap-2.5 rounded-xl border border-dashed border-line bg-surface-sunken p-3.5"
    >
      <div className="flex items-center gap-2 text-[13px] font-medium text-muted">
        <GitBranch size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{orphan.branch.replace(/^solline\//, '')}</span>
      </div>
      <div className="flex items-center gap-2 text-[11.5px] text-subtle">
        <span className="truncate">{project ?? ''} · por trazer</span>
        <Delta {...orphan.stats} />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={orphan.stats.files === 0}
          onClick={() => void actions.bringOrphan(orphan.id)}
          className={`${smallButton} border border-line text-fg hover:bg-surface`}
          data-testid="orphan-bring"
        >
          <GitMerge size={13} /> Trazer
        </button>
        <button
          type="button"
          onClick={() => void actions.discardOrphan(orphan.id)}
          className={`${smallButton} ml-auto text-subtle hover:text-danger`}
          data-testid="orphan-discard"
        >
          <Trash2 size={13} /> Deitar fora
        </button>
      </div>
    </div>
  );
}

/**
 * Quando a ordem muda, cada cartão desliza do sítio antigo para o novo (FLIP, só transform,
 * ~250 ms). Com movimento reduzido, troca sem deslizar.
 */
function useFlip(order: string) {
  const grid = useRef<HTMLDivElement>(null);
  const last = useRef(new Map<string, DOMRect>());
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const next = new Map<string, DOMRect>();
    for (const child of el.querySelectorAll<HTMLElement>('[data-flip]')) {
      const id = child.dataset.flip ?? '';
      const rect = child.getBoundingClientRect();
      next.set(id, rect);
      const before = last.current.get(id);
      if (!before || reduced) continue;
      const dx = before.left - rect.left;
      const dy = before.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      child.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: 250, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      );
    }
    last.current = next;
  }, [order, reduced]);
  return grid;
}

/** O estado de cada sessão, para ordenar; volta a desenhar só quando algum muda. */
function useSessionStates(ids: readonly string[]): string {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const stops = ids.map((id) => sessionStore(id)?.subscribe(onChange));
      return () => stops.forEach((stop) => stop?.());
    },
    [ids],
  );
  return useSyncExternalStore(subscribe, () =>
    ids.map((id) => `${id}:${sessionStore(id)?.getState().info.state ?? 'idle'}`).join('|'),
  );
}

/** Quantas sessões precisam de ti agora (para o botão da mesa). */
export function useNeedsYouCount(): number {
  const ids = useApp((s) => s.sessionIds);
  const key = useSessionStates(ids);
  return key.split('|').filter((pair) => pair.endsWith(':needs-you')).length;
}

/** A mesa: um cartão vivo por sessão, ordenados pelo que precisa de ti. */
export function Desk() {
  const ids = useApp((s) => s.sessionIds);
  const orphans = useApp((s) => s.orphans);
  const key = useSessionStates(ids);
  const sessions = deskOrder(
    key
      .split('|')
      .filter(Boolean)
      .map((pair) => {
        const [id, state] = pair.split(':') as [string, 'idle'];
        return { id, state };
      }),
  );
  const order = [...sessions.map((s) => s.id), ...orphans.map((o) => o.id)].join(',');
  const grid = useFlip(order);
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-8" data-testid="desk">
      <div
        ref={grid}
        className="mx-auto grid max-w-[64rem] grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3"
      >
        {sessions.map((s) => (
          <SessionCard key={s.id} sessionId={s.id} />
        ))}
        {orphans.map((o) => (
          <OrphanCard key={o.id} orphan={o} />
        ))}
      </div>
    </section>
  );
}
