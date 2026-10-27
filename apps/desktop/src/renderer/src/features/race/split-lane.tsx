import { useState } from 'react';
import type { Race, RaceLane, SplitPending, SplitWarning } from '@solline/protocol';
import { LABELS, laneName } from './lane-name.ts';

/**
 * As peças das pistas que só as repartições têm: a parte que a pista faz, os avisos de âmbito e
 * de choque, e o lugar das partes que ainda não arrancaram.
 */

/** A letra da parte no plano (A, B…), a partir da informação da repartição. */
export function partLetter(race: Race, sessionId: string): string | null {
  const info = race.split?.lanes?.find((l) => l.sessionId === sessionId);
  return info ? String.fromCharCode(65 + info.index) : null;
}

/** O título da parte que está nesta posição do plano (já a correr ou ainda por arrancar). */
export function partTitleAt(race: Race, index: number): string | null {
  const started = race.split?.lanes?.find((info) => info.index === index);
  const lane = started ? race.lanes.find((l) => l.sessionId === started.sessionId) : undefined;
  return (
    lane?.part?.title ?? race.split?.pending.find((p) => p.index === index)?.part.title ?? null
  );
}

/** O que cada aviso diz, em palavras; `other` é a pista com quem choca. */
export function warningText(warning: SplitWarning, race: Race): string {
  if (warning.kind === 'outside') return `fora do âmbito: ${warning.path}`;
  const other = race.lanes.find((l) => l.sessionId === warning.other)?.part?.title;
  return `pode chocar com «${other ?? 'outra parte'}» em ${warning.path}`;
}

/** A etiqueta do agente numa parte: pequena, ao lado do título. */
export function AgentChip({ lane }: { lane: RaceLane }) {
  return (
    <span
      className="shrink-0 rounded-full bg-surface-sunken px-1.5 text-[10.5px] leading-[18px] font-medium text-muted"
      data-testid="lane-agent"
    >
      {laneName(lane)}
    </span>
  );
}

/** No máximo três avisos à vista; o resto abre com "+N". Nunca um castigo, só uma nota. */
export function WarningChips({
  warnings,
  race,
}: {
  warnings: readonly SplitWarning[];
  race: Race;
}) {
  const [all, setAll] = useState(false);
  if (warnings.length === 0) return null;
  const shown = all ? warnings : warnings.slice(0, 3);
  const more = warnings.length - shown.length;
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid="split-warnings">
      {shown.map((warning, i) => (
        <li
          key={`${warning.kind}:${warning.path}:${warning.other ?? ''}:${i}`}
          className="max-w-full truncate rounded-full border border-line px-2 text-[11px] leading-[20px] text-muted"
          title={warningText(warning, race)}
          data-testid="split-warning"
          data-kind={warning.kind}
        >
          {warningText(warning, race)}
        </li>
      ))}
      {more > 0 ? (
        <li>
          <button
            type="button"
            onClick={() => setAll(true)}
            className="sl-press rounded-full border border-line px-2 text-[11px] leading-[20px] text-muted hover:bg-surface-hover hover:text-fg"
            data-testid="split-warnings-more"
          >
            +{more}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Uma parte que ainda não arrancou: o mesmo tamanho das outras, apagada e parada (sem esqueleto
 * a pulsar). Diz de quem está à espera.
 */
export function PendingLane({ race, pending }: { race: Race; pending: SplitPending }) {
  const waitingFor = pending.after === null ? null : partTitleAt(race, pending.after);
  return (
    <section
      className="sl-enter flex min-w-0 flex-1 flex-col gap-3 rounded-xl border border-dashed border-line bg-surface p-4 opacity-70"
      data-testid="race-lane-pending"
    >
      <header className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {pending.part.title}
        </span>
        <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 text-[10.5px] leading-[18px] font-medium text-muted">
          {LABELS[pending.agent] ?? pending.agent}
        </span>
      </header>
      <p className="min-h-[2.5rem] text-[12.5px] leading-snug text-muted">
        {waitingFor ? `À espera de «${waitingFor}»` : 'Por arrancar'}
      </p>
    </section>
  );
}
