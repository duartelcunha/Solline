import { useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { BadgeCheck, CircleAlert, Eye, EyeOff, RotateCw } from 'lucide-react';
import type { Finding, FindingSeverity, Quality } from '@solline/protocol';
import { ActionItem, MenuShell } from '../../components/menu.tsx';
import { actions, useSession } from '../../stores/app.ts';
import { IconSwap } from '@solline/ui/icon-swap';

/** Cada gravidade tem cor e forma: lê-se mesmo sem distinguir as cores. */
const SEVERITY: Record<FindingSeverity, { label: string; text: string }> = {
  bug: { label: 'Erro', text: 'text-danger' },
  risk: { label: 'Risco', text: 'text-accent-text' },
  slop: { label: 'Ruído', text: 'text-muted' },
};

/** Octógono para erro, triângulo para risco, círculo para ruído. */
function SeverityMark({ severity, size = 9 }: { severity: FindingSeverity; size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 10 10"
      className={`shrink-0 ${SEVERITY[severity].text}`}
      fill="currentColor"
    >
      {severity === 'bug' ? (
        <path d="M3 0h4l3 3v4l-3 3H3L0 7V3z" />
      ) : severity === 'risk' ? (
        <path d="M5 0.5 9.8 9.5H0.2z" />
      ) : (
        <circle cx="5" cy="5" r="4.2" />
      )}
    </svg>
  );
}

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
            <SeverityMark severity={severity} />
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
  const busy = useSession(
    sessionId,
    (s) => s.info.state === 'running' || s.info.state === 'starting',
  );
  const current = quality ? face(quality) : null;
  if (!quality?.available || !current) return null;
  const { review } = quality;

  const label =
    current === 'off'
      ? 'Revisor desligado'
      : current === 'running'
        ? 'A rever…'
        : current === 'clean'
          ? 'Revisor sem achados'
          : current === 'found'
            ? `${review.findings.length} ${review.findings.length === 1 ? 'achado' : 'achados'}`
            : current === 'error'
              ? `Falhou: ${review.error ?? ''}`
              : 'Revisor ligado';

  return (
    <MenuShell
      title="Revisor"
      side="bottom"
      align="end"
      trigger={
        <Menu.Trigger
          aria-label={label}
          title={label}
          data-testid="quality-chip"
          data-quality={current}
          className="no-drag sl-press inline-flex h-7 items-center gap-1.5 rounded-control px-2 text-[12px] text-muted transition-colors duration-150 outline-none hover:bg-surface-hover hover:text-fg data-[state=open]:bg-surface-hover"
        >
          <IconSwap swapKey={current}>
            {current === 'off' ? (
              <EyeOff size={14} strokeWidth={1.75} className="text-subtle" />
            ) : current === 'running' ? (
              <span
                aria-hidden
                className="spinner block size-[12px] rounded-full border-[1.5px] border-current border-t-transparent text-subtle"
              />
            ) : current === 'clean' ? (
              <BadgeCheck size={14} strokeWidth={1.75} className="text-success" />
            ) : current === 'found' ? (
              <Counts findings={review.findings} />
            ) : current === 'error' ? (
              <CircleAlert size={14} strokeWidth={1.75} className="text-subtle" />
            ) : (
              <Eye size={14} strokeWidth={1.75} />
            )}
          </IconSwap>
        </Menu.Trigger>
      }
    >
      {current === 'found' ? (
        <ActionItem
          title="Ver achados"
          icon={<Eye size={14} />}
          onSelect={() => actions.toggleReview(true)}
          testId="quality-open"
        />
      ) : null}
      {quality.enabled ? (
        <ActionItem
          title="Repetir"
          icon={<RotateCw size={14} />}
          disabled={busy || current === 'running'}
          onSelect={() => void actions.reviewAgain(sessionId)}
          testId="quality-again"
        />
      ) : null}
      <ActionItem
        title={quality.enabled ? 'Desligar o revisor' : 'Ligar o revisor'}
        icon={quality.enabled ? <EyeOff size={14} /> : <Eye size={14} />}
        onSelect={() => void actions.setQualityEnabled(sessionId, !quality.enabled)}
        testId="quality-toggle"
      />
    </MenuShell>
  );
}

function FindingTitle({
  finding,
  label,
  open,
}: {
  finding: Finding;
  label: string;
  open: boolean;
}) {
  return (
    <span className={`block leading-snug font-medium ${open ? '' : 'truncate'}`}>
      <span className="sr-only">{label}: </span>
      {finding.title}
    </span>
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
        className="mt-[3px] size-3.5 shrink-0 accent-[var(--sl-text)]"
        data-testid="finding-pick"
      />
      <span className="mt-[5px]">
        <SeverityMark severity={finding.severity} />
      </span>
      {finding.detail ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
        >
          <FindingTitle finding={finding} label={tone.label} open={open} />
          {open ? (
            <span className="mt-0.5 block leading-snug text-muted select-text">
              {finding.detail}
            </span>
          ) : null}
        </button>
      ) : (
        <span className="min-w-0 flex-1">
          <FindingTitle finding={finding} label={tone.label} open />
        </span>
      )}
    </div>
  );
}
