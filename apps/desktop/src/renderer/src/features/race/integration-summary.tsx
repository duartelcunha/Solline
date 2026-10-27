import type { RaceIntegration } from '@solline/protocol';
import { money } from '../composer/composer.tsx';
import { FindingLine } from '../quality/quality.tsx';
import { Mark } from '../quality/checks.tsx';
import { formatDuration } from './integration-model.ts';

function Metric({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <dt className="text-[11.5px] text-subtle">{label}</dt>
      <dd className="text-[13px] font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * O que a integração mediu, em números simples: nada de veredicto sobre se partir compensou.
 * O tempo compara a pista mais lenta com a soma de todas; o custo é a soma do último custo de cada.
 */
export function IntegrationMetricsView({ integration }: { integration: RaceIntegration }) {
  const { metrics } = integration;
  return (
    <dl
      className="grid gap-x-4 gap-y-2.5 [grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr))]"
      data-testid="split-metrics"
    >
      <Metric
        label="Custo somado"
        value={metrics.costUsd === null ? 'sem valor' : money.format(metrics.costUsd)}
        testId="split-metric-cost"
      />
      <Metric
        label="Pista mais lenta"
        value={formatDuration(metrics.slowestMs)}
        testId="split-metric-slowest"
      />
      <Metric
        label="Soma das pistas"
        value={formatDuration(metrics.totalMs)}
        testId="split-metric-total"
      />
      <Metric label="Conflitos" value={`${metrics.conflicts}`} testId="split-metric-conflicts" />
      <Metric
        label="Falhas depois de integrar"
        value={`${metrics.failures}`}
        testId="split-metric-failures"
      />
    </dl>
  );
}

/** O que sobrou no fim: as verificações todas, o que o revisor achou e os avisos da integração. */
export function IntegrationOutcome({ integration }: { integration: RaceIntegration }) {
  const { final, review, warnings } = integration;
  return (
    <div className="flex flex-col gap-3" data-testid="split-outcome">
      {final ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
          <span className="font-semibold">Verificações finais</span>
          {final.checks.length === 0 ? <span className="text-muted">nenhuma</span> : null}
          {final.checks.map((c) => (
            <span
              key={c.label}
              title={c.preexisting ? `${c.label}: já falhava antes desta mudança` : c.label}
              className={`inline-flex items-center gap-1 text-[12px] text-muted ${c.preexisting ? 'opacity-50' : ''}`}
            >
              <Mark face={c.state} />
              {c.label}
            </span>
          ))}
        </div>
      ) : null}
      {review ? (
        review.length > 0 ? (
          <ul className="flex flex-col gap-1.5" data-testid="split-findings">
            {review.map((finding) => (
              <FindingLine key={finding.id} finding={finding} />
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-muted">O revisor não achou nada no resultado.</p>
        )
      ) : (
        <p className="text-[12.5px] text-subtle">O revisor não deu resposta sobre o resultado.</p>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="text-[12px] text-muted">
          {warning}
        </p>
      ))}
    </div>
  );
}
