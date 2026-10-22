import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, GitBranch, Minus, Plus } from 'lucide-react';
import type { AskBlock, Race, RaceLane, RaceLaneVerdict } from '@solline/protocol';
import { actions, sessionStore, useApp, useSession } from '../../stores/app.ts';
import { SessionMark } from '../agents/bots.tsx';
import { ContextMeter, money } from '../composer/composer.tsx';
import { lastAction, pendingAsk } from '../desk/desk-order.ts';
import { Mark } from '../quality/checks.tsx';

const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
/** "claude-haiku-5-5" -> "haiku 5.5": o modelo curto, como nas pílulas. */
const shortModel = (model: string) =>
  model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');
const laneName = (lane: RaceLane) =>
  `${LABELS[lane.agent] ?? lane.agent}${lane.model ? ` · ${shortModel(lane.model)}` : ''}`;

const PHASE: Record<Race['phase'], string> = {
  running: 'A correr',
  done: 'Acabaram todas',
  ranking: 'A ordenar',
  ranked: 'Ordenada',
  closed: 'Fechada',
};

/** "1.º", "2.º": a posição como se escreve em português. */
const ordinal = (rank: number) => `${rank}.º`;

/** As verificações de uma pista ordenada: as que já falhavam na base ficam apagadas. */
function VerdictChecks({ checks }: { checks: RaceLaneVerdict['checks'] }) {
  return checks.map((c) => (
    <span
      key={c.label}
      title={c.preexisting ? `${c.label}: já falhava antes desta mudança` : c.label}
      className={`inline-flex items-center gap-1 ${c.preexisting ? 'opacity-50' : ''}`}
    >
      <Mark face={c.state} />
      {c.label}
    </span>
  ));
}

/**
 * Uma pista: quem é, o que está a fazer, quanto gastou e como estão as verificações. Depois de
 * ordenada, a posição, o melhor e o pior (do juiz, quando foi chamado).
 */
function Lane({
  lane,
  verdict,
  celebrate,
  tied,
}: {
  lane: RaceLane;
  verdict: RaceLaneVerdict | undefined;
  celebrate: boolean;
  tied: boolean;
}) {
  const id = lane.sessionId;
  const winner = verdict?.rank === 1 && !tied;
  const action = useSession(id, (s) => lastAction(s.turns));
  const usage = useSession(id, (s) => s.usage);
  const interrupted = useSession(id, (s) => s.interrupted);
  const workspace = useSession(id, (s) => s.info.workspace);
  const checks = useSession(id, (s) => s.checks);
  const enabled = checks?.trusted ? checks.specs.filter((c) => c.enabled) : [];
  return (
    <section
      className={`sl-enter flex min-w-0 flex-1 flex-col gap-3 rounded-xl border bg-surface p-4 transition-[border-color] duration-200 ${winner ? 'border-accent' : 'border-line'}`}
      data-testid="race-lane"
      data-state={lane.state}
      data-rank={verdict?.rank}
      data-winner={winner}
    >
      <header className="flex items-center gap-2.5">
        <SessionMark sessionId={id} size={18} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{laneName(lane)}</span>
        {verdict ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold tabular-nums ${winner ? `bg-accent text-on-accent ${celebrate ? 'sl-reward' : ''}` : 'bg-surface-hover text-muted'}`}
            data-testid="race-rank"
          >
            {tied ? 'Empate' : ordinal(verdict.rank)}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => actions.selectSession(id)}
          aria-label="Abrir a conversa desta pista"
          className="grid size-7 place-items-center rounded-control text-subtle sl-press hover:bg-surface-hover hover:text-fg"
        >
          <ArrowUpRight size={14} />
        </button>
      </header>
      <p className="min-h-[2.5rem] text-[12.5px] leading-snug text-muted line-clamp-2">
        {lane.state === 'error'
          ? interrupted
            ? 'Execução interrompida · histórico recuperado'
            : 'A pista falhou'
          : verdict?.empty
            ? 'Não mudou nada'
            : (action ??
              (lane.state === 'starting'
                ? 'A arrancar…'
                : lane.state === 'needs-you'
                  ? 'Precisa de ti'
                  : lane.state === 'running'
                    ? 'A pensar…'
                    : 'Concluída'))}
      </p>
      {verdict?.best || verdict?.worst ? (
        <ul className="flex flex-col gap-1 text-[12px] leading-snug">
          {verdict.best ? (
            <li className="flex gap-1.5">
              <Plus size={13} className="mt-px shrink-0 text-success" aria-label="Melhor" />
              {verdict.best}
            </li>
          ) : null}
          {verdict.worst ? (
            <li className="flex gap-1.5 text-muted">
              <Minus size={13} className="mt-px shrink-0 text-danger" aria-label="Pior" />
              {verdict.worst}
            </li>
          ) : null}
        </ul>
      ) : null}
      <footer className="mt-auto flex flex-wrap items-center gap-2.5 text-[11.5px] text-muted">
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
        {workspace?.kind === 'worktree' && workspace.stats.files > 0 ? (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums">
            <GitBranch size={12} />
            <span className="text-success">+{workspace.stats.additions}</span>
            <span className="text-danger">−{workspace.stats.deletions}</span>
          </span>
        ) : null}
        {verdict ? (
          <VerdictChecks checks={verdict.checks} />
        ) : (
          enabled.map((c) => {
            const face = checks?.results.find((r) => r.id === c.id)?.state ?? 'waiting';
            return face === 'waiting' ? null : (
              <span key={c.id} title={c.label} className="inline-flex items-center gap-1">
                <Mark face={face} />
                {c.label}
              </span>
            );
          })
        )}
      </footer>
    </section>
  );
}

/** Os pedidos de todas as pistas, para os mostrar um de cada vez no topo. */
function usePendingAsks(lanes: readonly RaceLane[]): { sessionId: string; ask: AskBlock }[] {
  const ids = lanes.map((l) => l.sessionId);
  const idsKey = ids.join(',');
  const subscribe = useCallback(
    (onChange: () => void) => {
      const stops = idsKey.split(',').map((id) => sessionStore(id)?.subscribe(onChange));
      return () => stops.forEach((stop) => stop?.());
    },
    [idsKey],
  );
  const key = useSyncExternalStore(subscribe, () =>
    ids
      .map((id) => {
        const ask = pendingAsk(sessionStore(id)?.getState().turns ?? []);
        return ask ? `${id}|${ask.id}` : '';
      })
      .filter(Boolean)
      .join(','),
  );
  return key
    .split(',')
    .filter(Boolean)
    .flatMap((pair) => {
      const [sessionId] = pair.split('|') as [string];
      const ask = pendingAsk(sessionStore(sessionId)?.getState().turns ?? []);
      return ask ? [{ sessionId, ask }] : [];
    });
}

/**
 * Um pedido de cada vez, com o nome da pista. Quando o mesmo pedido (o mesmo título) chega de
 * várias pistas, "Permitir para todas" responde a todos de uma vez.
 */
function AskBar({ race }: { race: Race }) {
  const asks = usePendingAsks(race.lanes);
  const first = asks[0];
  if (!first) return null;
  const lane = race.lanes.find((l) => l.sessionId === first.sessionId);
  const title = first.ask.kind === 'permission' ? first.ask.title : null;
  const same = title
    ? asks.filter((a) => a.ask.kind === 'permission' && a.ask.title === title)
    : [first];
  const answer = (decision: 'allow-once' | 'deny', all: boolean) => {
    for (const a of all ? same : [first]) void actions.answer(a.sessionId, a.ask.id, { decision });
  };
  return (
    <div
      className="sl-enter mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent bg-surface px-4 py-2.5 text-[13px]"
      data-testid="race-ask"
    >
      <span className="text-[12px] text-accent-text">{lane ? laneName(lane) : ''}</span>
      <span className="min-w-0 flex-1 truncate">
        {title ?? (first.ask.kind === 'plan' ? 'Um plano para aprovares' : 'Uma pergunta para ti')}
      </span>
      {asks.length > 1 ? (
        <span className="text-[11.5px] text-subtle">+{asks.length - 1}</span>
      ) : null}
      {first.ask.kind === 'permission' ? (
        <>
          {same.length > 1 ? (
            <button
              type="button"
              onClick={() => answer('allow-once', true)}
              className="sl-press h-7 rounded-control border border-line px-2.5 text-[12px] hover:bg-surface-hover"
              data-testid="race-allow-all"
            >
              Permitir para todas
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => answer('allow-once', false)}
            className="sl-press h-7 rounded-control bg-fg px-2.5 text-[12px] text-bg"
            data-testid="race-allow"
          >
            Permitir
          </button>
          <button
            type="button"
            onClick={() => answer('deny', false)}
            className="sl-press h-7 rounded-control border border-line px-2.5 text-[12px] hover:bg-surface-hover"
          >
            Negar
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => actions.selectSession(first.sessionId)}
          className="sl-press h-7 rounded-control bg-fg px-2.5 text-[12px] text-bg"
        >
          Abrir
        </button>
      )}
    </div>
  );
}

/**
 * Celebra uma vez: só quando esta vista viu a corrida passar de "a ordenar" a "ordenada" (abrir
 * uma corrida já ordenada não celebra outra vez).
 */
function useCelebrate(phase: Race['phase'] | undefined): boolean {
  const last = useRef(phase);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (last.current === 'ranking' && phase === 'ranked') setCelebrate(true);
    last.current = phase;
  }, [phase]);
  return celebrate;
}

/** Empate que a execução e o juiz não desfizeram, ou o juiz que falhou: decides tu. */
function TieNote({ race }: { race: Race }) {
  const verdict = race.verdict;
  if (!verdict?.tie && !verdict?.judgeError) return null;
  const names = (verdict.tie ?? [])
    .map((id) => race.lanes.find((l) => l.sessionId === id))
    .filter((l): l is RaceLane => Boolean(l))
    .map(laneName);
  return (
    <div
      className="sl-enter mb-3 flex flex-wrap items-baseline gap-2 rounded-xl border border-line bg-surface px-4 py-2.5 text-[13px]"
      data-testid="race-tie"
    >
      {verdict.tie ? <span className="font-semibold">Empate: escolhe tu</span> : null}
      {names.length ? <span className="text-muted">{names.join(' · ')}</span> : null}
      {verdict.judgeError ? (
        <span className="text-[12px] text-subtle">
          O juiz não respondeu; a ordem é só pela execução.
        </span>
      ) : null}
    </div>
  );
}

/** A corrida: o pedido, os pedidos das pistas no topo e as pistas lado a lado. */
export function RaceView({ raceId }: { raceId: string }) {
  const race = useApp((s) => s.races[raceId]);
  const celebrate = useCelebrate(race?.phase);
  if (!race) return null;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-2 pb-8"
      data-testid="race"
    >
      <p className="mb-3 line-clamp-2 text-[13.5px] text-muted" data-testid="race-text">
        {race.text}
      </p>
      <AskBar race={race} />
      <TieNote race={race} />
      <div className="flex min-h-0 gap-3">
        {race.lanes.map((lane) => (
          <Lane
            key={lane.sessionId}
            lane={lane}
            verdict={race.verdict?.lanes.find((v) => v.sessionId === lane.sessionId)}
            celebrate={celebrate}
            tied={race.verdict?.tie?.includes(lane.sessionId) ?? false}
          />
        ))}
      </div>
    </section>
  );
}

export function RaceTitle({ raceId }: { raceId: string }) {
  const phase = useApp((s) => s.races[raceId]?.phase);
  return (
    <div className="flex min-w-0 items-baseline gap-2.5">
      <h1 className="text-[15px] font-semibold tracking-[-0.015em]">Corrida</h1>
      {phase ? (
        <span className="text-[12px] text-muted" data-testid="race-phase" data-phase={phase}>
          {PHASE[phase]}
        </span>
      ) : null}
    </div>
  );
}

/** A corrida na mesa: um cartão com as pistas em miniatura. */
export function RaceCard({ race }: { race: Race }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => actions.openRace(race.id)}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          actions.openRace(race.id);
        }
      }}
      data-flip={race.id}
      data-testid="race-card"
      className="sl-enter sl-press flex cursor-pointer flex-col gap-3 rounded-xl border border-line bg-surface p-4 outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)]"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold">Corrida</span>
        <span className="text-[11.5px] text-subtle">{PHASE[race.phase]}</span>
      </div>
      <p className="truncate text-[12px] text-muted">{race.text}</p>
      <div className="flex items-center gap-2">
        {race.lanes.map((lane) => (
          <span
            key={lane.sessionId}
            className="inline-flex items-center gap-1 text-[11.5px] text-muted"
          >
            <SessionMark sessionId={lane.sessionId} />
            {LABELS[lane.agent] ?? lane.agent}
          </span>
        ))}
      </div>
    </div>
  );
}
