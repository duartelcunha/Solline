import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check } from 'lucide-react';
import type { Race, RaceCandidate, RaceProposal, RaceSlot } from '@solline/protocol';
import { actions } from '../../stores/app.ts';
import { SessionMark } from '../agents/bots.tsx';
import { Mark } from '../quality/checks.tsx';
import { RaceCloseFooter, panelButton } from './close-footer.tsx';
import { laneName } from './lane-name.ts';
import { useReveal } from './use-reveal.ts';

/**
 * Montar o resultado: por zona de cada ficheiro, escolhes de que pista vem o pedaço (ou nenhum).
 * O que várias pistas escreveram igual e o que a melhor pista escreveu já vêm escolhidos. Depois
 * monta-se numa worktree própria, vê-se o resultado das verificações, traz-se e fecham-se as pistas.
 */

const button = panelButton;

const revealPhase = (phase: string) => phase === 'ranked' || phase === 'assembled';

const preferredOf = (proposal: RaceProposal): Set<string> =>
  new Set(
    proposal.files.flatMap((f) =>
      f.slots.flatMap((s) => s.candidates.filter((c) => c.preferred).map((c) => c.id)),
    ),
  );

function Lines({ lines }: { lines: RaceCandidate['hunks'][number]['lines'] }) {
  return (
    <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.55] select-text">
      {lines.map((line, i) => (
        <div
          key={i}
          className={`grid grid-cols-[1.25rem_1fr] ${line.kind === 'add' ? 'diff-add' : line.kind === 'del' ? 'diff-del' : ''}`}
          data-kind={line.kind}
        >
          <span
            className={`text-center select-none ${line.kind === 'context' ? '' : 'diff-direction'}`}
          >
            {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
          </span>
          <span className="pr-2 whitespace-pre">{line.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function Candidate({
  race,
  candidate,
  on,
  onToggle,
}: {
  race: Race;
  candidate: RaceCandidate;
  on: boolean;
  onToggle: () => void;
}) {
  const lanes = candidate.lanes.flatMap((id) => race.lanes.find((l) => l.sessionId === id) ?? []);
  return (
    <div
      role="radio"
      aria-checked={on}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
      data-testid="race-candidate"
      data-picked={on}
      className={`flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg border bg-surface outline-none transition-[border-color] duration-200 focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] motion-reduce:transition-none ${on ? 'border-accent' : 'border-line hover:border-line-strong'}`}
    >
      <header className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 text-[12px]">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
          {lanes.map((lane) => (
            <span key={lane.sessionId} className="inline-flex items-center gap-1.5 truncate">
              <SessionMark sessionId={lane.sessionId} />
              {laneName(lane)}
            </span>
          ))}
        </span>
        {lanes.length > 1 ? (
          <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 text-[10.5px] leading-[18px] font-medium text-muted">
            {lanes.length} pistas iguais
          </span>
        ) : null}
        <span
          className={`grid size-4 shrink-0 place-items-center rounded-full ${on ? 'bg-accent text-on-accent' : 'border border-line'}`}
          aria-hidden
        >
          {on ? <Check size={11} strokeWidth={3} /> : null}
        </span>
      </header>
      <div className="divide-y divide-dashed divide-line">
        {candidate.hunks.map((hunk) => (
          <Lines key={hunk.id} lines={hunk.lines} />
        ))}
      </div>
    </div>
  );
}

function Slot({
  race,
  path,
  slot,
  picks,
  onPick,
}: {
  race: Race;
  path: string;
  slot: RaceSlot;
  picks: ReadonlySet<string>;
  onPick: (slot: RaceSlot, candidate: RaceCandidate) => void;
}) {
  const first = slot.candidates[0]?.hunks[0];
  return (
    <div
      role="radiogroup"
      aria-label={`${path}, a partir da linha ${first?.oldStart ?? 1}`}
      className="grid gap-2 p-2.5 [grid-template-columns:repeat(auto-fit,minmax(18rem,1fr))]"
      data-testid="race-slot"
    >
      {slot.candidates.map((candidate) => (
        <Candidate
          key={candidate.id}
          race={race}
          candidate={candidate}
          on={picks.has(candidate.id)}
          onToggle={() => onPick(slot, candidate)}
        />
      ))}
    </div>
  );
}

const STATUS = { added: 'Novo', deleted: 'Apagado', modified: null } as const;

/** O painel da montagem de uma corrida ordenada (e o que vem depois: trazer e fechar). */
export function AssemblyPanel({
  race,
  area,
}: {
  race: Race;
  /** A área que desliza, para trazer o painel à vista quando a corrida fica ordenada. */
  area: RefObject<HTMLElement | null>;
}) {
  const panel = useRef<HTMLElement>(null);
  const [proposal, setProposal] = useState<RaceProposal | null>(null);
  const [picks, setPicks] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const active =
    race.phase === 'ranked' || race.phase === 'assembling' || race.phase === 'assembled';
  const brought = race.assembly?.brought ?? null;
  const loaded = useRef(false);

  // A proposta carrega uma vez, quando a corrida está ordenada e ainda há o que escolher.
  useEffect(() => {
    if (!active || brought || loaded.current) return;
    loaded.current = true;
    void actions.raceProposal(race.id).then((next) => {
      if (!next) {
        loaded.current = false;
        return;
      }
      setProposal(next);
      setPicks(preferredOf(next));
    });
  }, [active, brought, race.id]);

  // Só desliza quando vê a corrida mudar de fase (abrir uma já ordenada não mexe).
  useReveal(area, panel, race.phase, revealPhase);

  if (!active) return null;

  const pick = (slot: RaceSlot, candidate: RaceCandidate) =>
    setPicks((current) => {
      const next = new Set(current);
      const was = next.has(candidate.id);
      for (const other of slot.candidates) next.delete(other.id);
      if (!was) next.add(candidate.id);
      return next;
    });
  const run = async (action: () => Promise<boolean>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const assembly = race.assembly;

  return (
    <section
      ref={panel}
      className="sl-enter mt-4 flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
      data-testid="race-assembly"
      data-phase={race.phase}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-semibold">Montar o resultado</h2>
        {!brought ? (
          <p className="min-w-0 flex-1 text-[12px] text-muted">
            Escolhe, por zona, o que fica. O que várias pistas escreveram igual e o que a melhor
            pista escreveu já vêm escolhidos.
          </p>
        ) : null}
      </header>

      {assembly ? (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-surface-sunken px-3 py-2 text-[12.5px]"
          data-testid="race-assembly-summary"
        >
          <span className="font-semibold">{brought ? 'Trazida' : 'Montada'}</span>
          <span className="font-mono text-[11.5px] tabular-nums text-muted">
            {assembly.files} {assembly.files === 1 ? 'ficheiro' : 'ficheiros'}{' '}
            <span className="text-success">+{assembly.additions}</span>{' '}
            <span className="text-danger">−{assembly.deletions}</span>
          </span>
          {assembly.checks.map((c) => (
            <span
              key={c.label}
              title={c.preexisting ? `${c.label}: já falhava antes desta mudança` : c.label}
              className={`inline-flex items-center gap-1 text-[12px] text-muted ${c.preexisting ? 'opacity-50' : ''}`}
            >
              <Mark face={c.state} />
              {c.label}
            </span>
          ))}
          <span className="flex-1" />
          {brought ? (
            <span className="text-muted">para {brought.into}</span>
          ) : (
            <button
              type="button"
              disabled={busy || race.phase === 'assembling'}
              onClick={() => void run(() => actions.bringRace(race.id))}
              className={`${button} bg-fg text-bg`}
              data-testid="race-bring"
            >
              Trazer
            </button>
          )}
        </div>
      ) : null}

      {!brought ? (
        <>
          {proposal ? (
            <div className="flex flex-col gap-3">
              {proposal.files.map((file) => (
                <section
                  key={file.path}
                  className="overflow-hidden rounded-lg border border-line"
                  data-testid="race-file"
                >
                  <header className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[12px]"
                      title={file.path}
                    >
                      {file.path}
                    </span>
                    {STATUS[file.status] ? (
                      <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 text-[10.5px] leading-[18px] font-medium text-muted">
                        {STATUS[file.status]}
                      </span>
                    ) : null}
                  </header>
                  <div className="divide-y divide-line">
                    {file.slots.map((slot) => (
                      <Slot
                        key={slot.id}
                        race={race}
                        path={file.path}
                        slot={slot}
                        picks={picks}
                        onPick={pick}
                      />
                    ))}
                  </div>
                </section>
              ))}
              {proposal.skipped.map((s) => (
                <p key={`${s.path}${s.reason}`} className="text-[12px] text-muted">
                  {s.path}: {s.reason}. Não entra na montagem; traz a pista inteira se precisares
                  dele.
                </p>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-muted">A preparar as zonas…</p>
          )}
          <footer className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted tabular-nums" data-testid="race-picks">
              {picks.size} {picks.size === 1 ? 'pedaço escolhido' : 'pedaços escolhidos'}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              disabled={busy || race.phase === 'assembling' || picks.size === 0}
              onClick={() => void run(() => actions.assembleRace(race.id, [...picks]))}
              className={`${button} ${assembly ? 'border border-line hover:bg-surface-hover' : 'bg-fg text-bg'}`}
              data-testid="race-assemble"
            >
              {race.phase === 'assembling' ? 'A montar…' : assembly ? 'Montar de novo' : 'Montar'}
            </button>
          </footer>
        </>
      ) : null}

      <RaceCloseFooter race={race} disabled={busy || race.phase === 'assembling'} />
    </section>
  );
}
