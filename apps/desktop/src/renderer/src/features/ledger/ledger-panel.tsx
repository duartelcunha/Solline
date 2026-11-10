import { useState } from 'react';
import type { BudgetLimits, TokenSnapshot } from '@solline/protocol';
import { actions, useSession } from '../../stores/app.ts';
import { shownAmount } from './format.ts';

const money = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const tokens = new Intl.NumberFormat('pt-PT');

function field(label: string, value: number | null, format: (value: number) => string) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span>{label}</span>
      <span className="tabular-nums">{shownAmount(value, format)}</span>
    </div>
  );
}

function rows(snapshot: TokenSnapshot) {
  return (
    <div className="grid gap-1">
      {field('Entrada nova', snapshot.freshInput, tokens.format)}
      {field('Em cache', snapshot.cachedInput, tokens.format)}
      {field('Saída', snapshot.output, tokens.format)}
      {field('Custo reportado', snapshot.costUsd, (value) => money.format(value))}
    </div>
  );
}

export function LedgerPanel({ sessionId }: { sessionId: string }) {
  const ledger = useSession(sessionId, (s) => s.ledger);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState('');
  const [attempts, setAttempts] = useState('');
  const [minutes, setMinutes] = useState('');
  const limit = (value: string): number | null => {
    const text = value.trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const save = () => {
    const limits: BudgetLimits = {
      maxTurns: limit(turns),
      maxAttempts: limit(attempts),
      maxMinutes: limit(minutes),
    };
    void actions.setBudget(sessionId, limits);
  };
  return (
    <div className="mb-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-testid="ledger-toggle"
        className="sl-press rounded-sm px-1 text-[12px] text-muted hover:text-fg"
      >
        Consumo
      </button>
      {open ? (
        <div
          data-testid="ledger-panel"
          className="mt-1 grid gap-2 rounded-md border border-line bg-surface px-3 py-2 text-[12px] text-muted"
        >
          {ledger ? (
            <>
              {rows(ledger.total)}
              <p>Quota: {ledger.quota.reason}</p>
              <p>
                Estimativa de tabela ({ledger.priceVersion}):{' '}
                {shownAmount(ledger.estimateUsd, (value) => money.format(value))}
              </p>
              {ledger.budget.stop ? (
                <p data-testid="ledger-stop">{ledger.budget.stop.text}</p>
              ) : null}
              {ledger.executions.some((item) => item.kind === 'subagent') ? (
                <p>Uma consulta ou delegação tem o seu próprio livro e não entra nesta soma.</p>
              ) : null}
            </>
          ) : (
            <p>Ainda não há leitura desta sessão.</p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-0.5">
              Turnos
              <input
                value={turns}
                onChange={(event) => setTurns(event.target.value)}
                inputMode="numeric"
                aria-label="Limite de turnos"
                data-testid="budget-turns"
                className="h-7 w-16 rounded-control border border-line bg-transparent px-2 text-fg"
              />
            </label>
            <label className="grid gap-0.5">
              Tentativas
              <input
                value={attempts}
                onChange={(event) => setAttempts(event.target.value)}
                inputMode="numeric"
                aria-label="Limite de tentativas"
                data-testid="budget-attempts"
                className="h-7 w-16 rounded-control border border-line bg-transparent px-2 text-fg"
              />
            </label>
            <label className="grid gap-0.5">
              Minutos
              <input
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                inputMode="decimal"
                aria-label="Limite de minutos"
                data-testid="budget-minutes"
                className="h-7 w-16 rounded-control border border-line bg-transparent px-2 text-fg"
              />
            </label>
            <button
              type="button"
              onClick={save}
              data-testid="budget-save"
              className="sl-press h-7 rounded-control border border-line px-2 text-fg"
            >
              Guardar limites
            </button>
          </div>
          <p>O turno que já vai a meio pode passar o limite. O próximo não começa.</p>
        </div>
      ) : null}
    </div>
  );
}
