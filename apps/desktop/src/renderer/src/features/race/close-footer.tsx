import { useState } from 'react';
import type { Race } from '@solline/protocol';
import { actions } from '../../stores/app.ts';
import { laneTitle } from './lane-name.ts';

export const panelButton =
  'sl-press h-8 rounded-control px-3 text-[12.5px] disabled:cursor-default disabled:opacity-50';

/**
 * O fim de qualquer painel de uma corrida ou repartição: guardar o branch de uma pista e fechar.
 * Fechar pede a confirmação nativa (no main) e deita fora as pistas.
 */
export function RaceCloseFooter({ race, disabled }: { race: Race; disabled: boolean }) {
  const [keep, setKeep] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <footer className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[12px] text-muted">
      <label className="flex items-center gap-2">
        Guardar o branch de
        <select
          value={keep}
          onChange={(event) => setKeep(event.target.value)}
          className="h-7 rounded-control border border-line bg-surface px-2 text-[12px] text-fg"
          data-testid="race-keep"
        >
          <option value="">nenhuma pista</option>
          {race.lanes.map((lane) => (
            <option key={lane.sessionId} value={lane.sessionId}>
              {laneTitle(lane)}
            </option>
          ))}
        </select>
      </label>
      <span className="flex-1" />
      <button
        type="button"
        disabled={busy || disabled}
        onClick={() => {
          setBusy(true);
          void actions.closeRace(race.id, keep || undefined).finally(() => setBusy(false));
        }}
        className={`${panelButton} border border-line text-fg hover:bg-surface-hover`}
        data-testid="race-close"
      >
        Fechar a corrida
      </button>
    </footer>
  );
}
