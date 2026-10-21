import { useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { CircleAlert, CircleCheck, Eye, EyeOff, RotateCw } from 'lucide-react';
import type { Finding, FindingSeverity, Quality } from '@solline/protocol';
import { ActionItem, MenuShell } from '../../components/menu.tsx';
import { actions, useSession } from '../../stores/app.ts';
import { Spinner } from '../conversation/blocks.tsx';

/** A cor de cada gravidade, igual no chip, nos pontos e nas linhas do diff. */
export const SEVERITY: Record<FindingSeverity, { label: string; dot: string; text: string }> = {
  bug: { label: 'Erro', dot: 'bg-danger', text: 'text-danger' },
  risk: { label: 'Risco', dot: 'bg-accent', text: 'text-accent-text' },
  slop: { label: 'Ruído', dot: 'bg-subtle', text: 'text-muted' },
};

const ORDER: FindingSeverity[] = ['bug', 'risk', 'slop'];

/** O que o chip mostra: uma chave por estado, para o ícone se transformar quando muda. */
function face(quality: Quality): string {
  if (!quality.enabled) return 'off';
  const { review } = quality;
  if (review.state === 'done') return review.findings.length ? 'found' : 'clean';
  return review.state;
}

function Counts({ findings }: { findings: readonly Finding[] }) {
  return (
    <span className="inline-flex items-center gap-2">
      {ORDER.map((severity) => {
        const n = findings.filter((f) => f.severity === severity).length;
        return n ? (
          <span key={severity} className="inline-flex items-center gap-1 tabular-nums">
            <span aria-hidden className={`size-1.5 rounded-full ${SEVERITY[severity].dot}`} />
            {n}
          </span>
        ) : null;
      })}
    </span>
  );
}

/**
 * A segunda opinião de relance, no cabeçalho: a girar enquanto revê, um visto quando está
 * limpo, pontos por gravidade quando achou alguma coisa. O clique abre o rever.
 */
export function QualityChip({ sessionId }: { sessionId: string }) {
  const quality = useSession(sessionId, (s) => s.quality);
  const busy = useSession(sessionId, (s) => s.info.state !== 'idle');
  // Muda de cara só depois do primeiro desenho: abrir uma sessão não anima.
  const [shown, setShown] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const current = quality ? face(quality) : null;
  if (current !== shown) {
    if (shown !== null) setChanged(true);
    setShown(current);
  }
  if (!quality?.available || !current) return null;
  const { review } = quality;

  const label =
    current === 'off'
      ? 'Revisor desligado'
      : current === 'running'
        ? 'O revisor está a ler o último turno'
        : current === 'clean'
          ? 'O revisor não achou nada'
          : current === 'found'
            ? `O revisor achou ${review.findings.length}`
            : current === 'error'
              ? `O revisor falhou: ${review.error ?? ''}`
              : 'Revisor ligado: lê cada turno que mude ficheiros';

  return (
    <MenuShell
      title="Segunda opinião"
      side="bottom"
      align="end"
      trigger={
        <Menu.Trigger
          aria-label={label}
          title={label}
          data-testid="quality-chip"
          data-state={current}
          className="no-drag sl-press inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted transition-colors duration-150 outline-none hover:bg-surface-hover hover:text-fg data-[state=open]:bg-surface-hover"
        >
          <span
            key={current}
            className={`inline-flex items-center gap-1.5 ${changed ? 'icon-morph' : ''}`}
          >
            {current === 'off' ? (
              <EyeOff size={14} strokeWidth={1.75} className="text-subtle" />
            ) : current === 'running' ? (
              <Spinner label="A rever" />
            ) : current === 'clean' ? (
              <CircleCheck size={14} strokeWidth={2} className="text-success" />
            ) : current === 'found' ? (
              <Counts findings={review.findings} />
            ) : current === 'error' ? (
              <CircleAlert size={14} strokeWidth={1.75} className="text-subtle" />
            ) : (
              <Eye size={14} strokeWidth={1.75} />
            )}
          </span>
        </Menu.Trigger>
      }
    >
      {current === 'found' ? (
        <ActionItem
          title="Ver os achados"
          icon={<Eye size={14} />}
          onSelect={() => actions.toggleReview(true)}
          testId="quality-open"
        />
      ) : null}
      {quality.enabled ? (
        <ActionItem
          title="Rever de novo"
          icon={<RotateCw size={14} />}
          disabled={busy || current === 'running'}
          onSelect={() => void actions.reviewAgain(sessionId)}
          testId="quality-again"
        />
      ) : null}
      <ActionItem
        title={quality.enabled ? 'Desligar o revisor' : 'Ligar o revisor'}
        description={quality.enabled ? undefined : 'Lê cada turno que mude ficheiros'}
        icon={quality.enabled ? <EyeOff size={14} /> : <Eye size={14} />}
        onSelect={() => void actions.setQualityEnabled(sessionId, !quality.enabled)}
        testId="quality-toggle"
      />
    </MenuShell>
  );
}

/** Um achado por baixo da linha a que se refere, com a caixa para o escolher. */
export function FindingRow({
  finding,
  picked,
  onPick,
}: {
  finding: Finding;
  picked: boolean;
  onPick: (picked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const tone = SEVERITY[finding.severity];
  return (
    <div
      className="sl-enter sl-motion flex items-start gap-2 border-y border-line bg-surface px-3 py-1.5 font-sans text-[12.5px]"
      data-testid="finding"
      data-severity={finding.severity}
    >
      <input
        type="checkbox"
        checked={picked}
        onChange={(e) => onPick(e.target.checked)}
        aria-label={`Escolher: ${finding.title}`}
        className="mt-[3px] size-3.5 shrink-0 accent-[var(--sl-accent)]"
        data-testid="finding-pick"
      />
      <span aria-hidden className={`mt-[7px] size-1.5 shrink-0 rounded-full ${tone.dot}`} />
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block leading-snug">
          <span className={`font-medium ${tone.text}`}>{tone.label}</span> {finding.title}
        </span>
        {open && finding.detail ? (
          <span className="mt-0.5 block leading-snug text-muted select-text">{finding.detail}</span>
        ) : null}
      </button>
    </div>
  );
}
