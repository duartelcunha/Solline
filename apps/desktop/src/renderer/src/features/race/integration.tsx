import { useRef, useState, type RefObject } from 'react';
import { CircleDashed, TriangleAlert } from 'lucide-react';
import type { Race } from '@solline/protocol';
import { IconSwap } from '@solline/ui/icon-swap';
import { actions, useSession } from '../../stores/app.ts';
import { Mark } from '../quality/checks.tsx';
import { RaceCloseFooter, panelButton } from './close-footer.tsx';
import { resolverLane, stepRows, visibleFiles, type StepRow } from './integration-model.ts';
import { IntegrationMetricsView, IntegrationOutcome } from './integration-summary.tsx';
import { LABELS } from './lane-name.ts';
import { useReveal } from './use-reveal.ts';

/**
 * Integrar as partes de uma repartição: junta-as uma a uma numa worktree própria, com a
 * verificação depois de cada uma. Num conflito abre-se uma sessão para o resolver; no fim vêm os
 * números, o que o revisor achou e "Trazer".
 */

/** Só estes passos merecem trazer o painel à vista. */
const revealStep = (step: string) =>
  step === 'done:' || step === 'done:conflict' || step === 'assembled:ready';

function StatusIcon({ row }: { row: StepRow }) {
  return (
    <IconSwap swapKey={`${row.status}${row.step?.failures ? '-failed' : ''}`} className="size-4">
      {row.status === 'done' ? (
        <Mark face={row.step && row.step.failures > 0 ? 'failed' : 'passed'} />
      ) : row.status === 'conflict' ? (
        <TriangleAlert size={13} className="text-accent-text" aria-label="Conflito" />
      ) : row.status === 'current' ? (
        <Mark face="running" />
      ) : (
        <CircleDashed size={13} className="text-subtle" aria-hidden />
      )}
    </IconSwap>
  );
}

function Steps({ race }: { race: Race }) {
  const rows = stepRows(race);
  const integration = race.integration;
  if (!integration) return null;
  const finishing =
    integration.state === 'merging' &&
    rows.every((r) => r.status === 'done' || r.status === 'conflict');
  return (
    <ol className="flex flex-col gap-1" data-testid="split-steps">
      {rows.map((row) => (
        <li
          key={row.sessionId}
          className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg bg-surface-sunken px-3 py-2 text-[12.5px] ${row.status === 'waiting' ? 'text-muted' : ''}`}
          data-testid="split-step"
          data-status={row.status}
        >
          <StatusIcon row={row} />
          <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
          {row.step?.checks.map((c) => (
            <span
              key={c.label}
              title={c.preexisting ? `${c.label}: já falhava antes desta mudança` : c.label}
              className={`inline-flex items-center gap-1 text-[12px] text-muted ${c.preexisting ? 'opacity-50' : ''}`}
            >
              <Mark face={c.state} />
              {c.label}
            </span>
          ))}
        </li>
      ))}
      {finishing ? (
        <li className="flex items-center gap-2.5 px-3 py-1.5 text-[12.5px] text-muted">
          <span className="grid size-4 place-items-center">
            <Mark face="running" />
          </span>
          {integration.final ? 'A rever o resultado…' : 'A verificar tudo…'}
        </li>
      ) : null}
    </ol>
  );
}

/** Parou num conflito: os ficheiros, quem os resolve e o regresso à integração. */
function ConflictCard({
  race,
  busy,
  run,
}: {
  race: Race;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const conflict = race.integration?.conflict;
  const resolver = conflict?.resolver ?? null;
  const resolverState = useSession(resolver, (s) => s.info.state);
  if (!conflict) return null;
  const clashing = race.lanes.find((l) => l.sessionId === conflict.sessionId);
  const producer = resolverLane(race);
  const { shown, more } = visibleFiles(conflict.files);
  return (
    <div
      className="sl-enter flex flex-col gap-2.5 rounded-lg border border-accent bg-surface px-3.5 py-3"
      data-testid="split-conflict"
    >
      <p className="text-[13px]">
        <span className="font-semibold">«{clashing?.part?.title ?? 'Parte'}»</span> choca com o que
        já está junto.
      </p>
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-0.5 font-mono text-[11.5px] text-muted">
          {shown.map((file) => (
            <li key={file} className="truncate" title={file}>
              {file}
            </li>
          ))}
          {more > 0 ? <li className="font-sans text-subtle">+{more}</li> : null}
        </ul>
      ) : (
        <p className="text-[12px] text-muted">O git recusou juntar sem dizer que ficheiros.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {resolver ? (
          <>
            <button
              type="button"
              onClick={() => actions.selectSession(resolver)}
              className={`${panelButton} border border-line hover:bg-surface-hover`}
              data-testid="split-open-resolver"
            >
              Abrir a sessão
            </button>
            <button
              type="button"
              disabled={busy || resolverState !== 'idle'}
              onClick={() => void run(() => actions.continueSplit(race.id))}
              className={`${panelButton} bg-fg text-bg`}
              data-testid="split-continue"
            >
              Continuar
            </button>
            <span className="min-w-0 flex-1 text-[12px] text-muted">
              {resolverState === 'idle'
                ? 'Quando o merge estiver gravado, continua.'
                : 'A sessão está a resolver.'}
            </span>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => actions.resolveSplit(race.id))}
            className={`${panelButton} bg-fg text-bg`}
            data-testid="split-resolve"
          >
            Resolver com {producer ? (LABELS[producer.agent] ?? producer.agent) : 'um agente'}
          </button>
        )}
      </div>
    </div>
  );
}

/** O painel da integração de uma repartição (e o que vem depois: trazer e fechar). */
export function IntegrationPanel({
  race,
  area,
}: {
  race: Race;
  /** A área que desliza, para trazer o painel à vista quando a repartição acaba ou pára. */
  area: RefObject<HTMLElement | null>;
}) {
  const panel = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const integration = race.integration ?? null;
  const pending = race.split?.pending ?? [];
  const active = race.phase === 'done' || race.phase === 'assembling' || race.phase === 'assembled';
  useReveal(area, panel, `${race.phase}:${integration?.state ?? ''}`, revealStep);
  if (!active) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const merging = race.phase === 'assembling';

  return (
    <section
      ref={panel}
      className="sl-enter mt-4 flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
      data-testid="split-integration"
      data-phase={race.phase}
      data-state={integration?.state ?? 'idle'}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-semibold">Integrar as partes</h2>
        {!integration ? (
          <p className="min-w-0 flex-1 text-[12px] text-muted">
            Junta uma a uma e verifica depois de cada parte.
          </p>
        ) : null}
      </header>

      {!integration ? (
        pending.length > 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="split-pending-note">
            Há partes que ainda não arrancaram ({pending.map((p) => `«${p.part.title}»`).join(', ')}
            ). Fecha a repartição se já não as queres.
          </p>
        ) : (
          <div>
            <button
              type="button"
              disabled={busy || merging}
              onClick={() => void run(() => actions.integrateSplit(race.id))}
              className={`${panelButton} bg-fg text-bg`}
              data-testid="split-integrate"
            >
              Integrar
            </button>
          </div>
        )
      ) : (
        <>
          <Steps race={race} />
          {integration.state === 'conflict' ? (
            <ConflictCard race={race} busy={busy} run={run} />
          ) : null}
          {integration.state === 'ready' || integration.state === 'brought' ? (
            <>
              <IntegrationOutcome integration={integration} />
              <IntegrationMetricsView integration={integration} />
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-[12.5px]">
                {integration.brought ? (
                  <span className="font-semibold" data-testid="split-brought">
                    Trazida para {integration.brought.into}
                  </span>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 text-muted">
                      Trazer faz o merge no teu branch atual.
                    </span>
                    <button
                      type="button"
                      disabled={busy || merging}
                      onClick={() => void run(() => actions.bringRace(race.id))}
                      className={`${panelButton} bg-fg text-bg`}
                      data-testid="race-bring"
                    >
                      Trazer
                    </button>
                  </>
                )}
              </div>
            </>
          ) : null}
        </>
      )}

      <RaceCloseFooter race={race} disabled={busy || merging} />
    </section>
  );
}
