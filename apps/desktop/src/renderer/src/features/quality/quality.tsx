import { useMemo, useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  EyeOff,
  RotateCw,
  ScanEye,
  Wand2,
  X,
} from 'lucide-react';
import type { Finding, FindingSeverity, Quality } from '@solline/protocol';
import { ActionItem, MenuShell } from '../../components/menu.tsx';
import { actions, useApp, useSession } from '../../stores/app.ts';
import { IconSwap } from '@solline/ui/icon-swap';
import {
  SCOPE_CHOICES,
  confidenceLabel,
  foldLabel,
  groupFindings,
  priorityLabel,
  reviewByline,
  reviewHeadline,
  reviewPhase,
  secondOpinionGate,
  statsLabel,
} from './findings-model.ts';

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

/** Os achados à vista no chip: só os que a revisão põe à frente (os dobrados ficam no painel). */
function visibleOf(quality: Quality): Finding[] {
  return groupFindings(quality.review.findings).shown;
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

/** A sessão já acabou pelo menos um turno (só então há o que rever). */
function useHasFinishedTurn(sessionId: string): boolean {
  return useSession(
    sessionId,
    (s) => s.timeline?.checkpoints.some((c) => c.state === 'done') ?? false,
  );
}

/** Pode pedir-se já uma segunda opinião? Dá também o motivo quando não. */
function useSecondOpinionGate(sessionId: string) {
  const quality = useSession(sessionId, (s) => s.quality);
  const busy = useSession(sessionId, (s) => s.info.state !== 'idle');
  const hasFinishedTurn = useHasFinishedTurn(sessionId);
  return secondOpinionGate(quality, { busy, hasFinishedTurn });
}

/** As duas escolhas da segunda opinião (este turno, toda a sessão), como itens de menu. */
function ScopeItems({ sessionId, enabled }: { sessionId: string; enabled: boolean }) {
  return (
    <>
      {SCOPE_CHOICES.map((choice) => (
        <ActionItem
          key={choice.scope}
          title={choice.title}
          description={choice.description}
          icon={<ScanEye size={14} />}
          disabled={!enabled}
          onSelect={() => void actions.secondOpinion(sessionId, choice.scope)}
          testId={`second-opinion-${choice.scope}`}
        />
      ))}
    </>
  );
}

/**
 * "Segunda opinião": pede já uma revisão, a pedido. Um menu pequeno escolhe o âmbito (este turno
 * ou toda a sessão); desligado, o título diz porquê.
 */
export function SecondOpinionButton({ sessionId }: { sessionId: string }) {
  const gate = useSecondOpinionGate(sessionId);
  const available = useSession(sessionId, (s) => s.quality?.available === true);
  if (!available) return null;
  return (
    <MenuShell
      title="Segunda opinião sobre"
      side="bottom"
      align="end"
      trigger={
        <Menu.Trigger
          disabled={!gate.enabled}
          title={gate.reason ?? 'Pedir a outro revisor que veja o trabalho'}
          data-testid="second-opinion"
          className="no-drag sl-press inline-flex h-7 items-center gap-1.5 rounded-control border border-line px-2 text-[12px] font-medium whitespace-nowrap text-muted outline-none hover:border-line-strong hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] disabled:opacity-50 data-[state=open]:border-line-strong data-[state=open]:bg-surface-hover data-[state=open]:text-fg"
        >
          <ScanEye size={13} strokeWidth={1.9} aria-hidden />
          Segunda opinião
          <ChevronDown size={12} strokeWidth={2} aria-hidden className="opacity-60" />
        </Menu.Trigger>
      }
    >
      <ScopeItems sessionId={sessionId} enabled={gate.enabled} />
    </MenuShell>
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
  const gate = useSecondOpinionGate(sessionId);
  const phase = reviewPhase(quality);
  if (!quality?.available || phase === 'unavailable') return null;
  const current = phase;
  const { review } = quality;
  const visible = visibleOf(quality);
  const hasFolded = groupFindings(review.findings).folded.length > 0;

  const label =
    current === 'off'
      ? 'Revisor desligado'
      : current === 'running'
        ? 'A rever…'
        : current === 'clean'
          ? 'Revisor sem achados'
          : current === 'found'
            ? `${visible.length} ${visible.length === 1 ? 'achado' : 'achados'}`
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
              <Counts findings={visible} />
            ) : current === 'error' ? (
              <CircleAlert size={14} strokeWidth={1.75} className="text-subtle" />
            ) : (
              <Eye size={14} strokeWidth={1.75} />
            )}
          </IconSwap>
        </Menu.Trigger>
      }
    >
      {current === 'found' || hasFolded ? (
        <ActionItem
          title={current === 'found' ? 'Ver achados' : 'Ver achados menos certos'}
          icon={<Eye size={14} />}
          onSelect={() => actions.toggleReview(true)}
          testId="quality-open"
        />
      ) : null}
      <ScopeItems sessionId={sessionId} enabled={gate.enabled} />
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

/** Uma pequena etiqueta calada ao lado de um texto (a prioridade, "mesmo fabricante"). */
function Quiet({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center rounded-full border border-line px-1.5 text-[10.5px] leading-[16px] whitespace-nowrap text-subtle"
    >
      {children}
    </span>
  );
}

/**
 * Quem reviu, porquê e com que resultado, no topo do painel de rever: o estado em palavras (nunca
 * um erro com cara de "limpo"), os contadores, "Corrigir todos" para os que estão à vista e a
 * segunda opinião a pedido.
 */
export function QualityStrip({ sessionId }: { sessionId: string }) {
  const quality = useSession(sessionId, (s) => s.quality);
  const agents = useApp((s) => s.agents);
  const busy = useSession(sessionId, (s) => s.info.state !== 'idle');
  const [fixing, setFixing] = useState(false);
  const shownOpen = useMemo(
    () =>
      quality
        ? groupFindings(quality.review.findings).shown.filter((f) => f.status === 'open')
        : [],
    [quality],
  );
  if (!quality?.available) return null;
  const phase = reviewPhase(quality);
  const headline = reviewHeadline(quality);
  const byline = reviewByline(quality.review, agents);
  const counts = statsLabel(quality.stats);

  const fixAll = async () => {
    setFixing(true);
    await actions.fixFindings(
      sessionId,
      shownOpen.map((f) => f.id),
    );
    setFixing(false);
  };

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-2"
      data-testid="quality-strip"
      data-phase={phase}
    >
      <div className="min-w-[14rem] flex-1">
        <div
          role="status"
          className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] font-medium ${
            headline.tone === 'error' ? 'text-danger' : 'text-fg'
          }`}
          data-testid="quality-headline"
        >
          {headline.tone === 'progress' ? (
            <span
              aria-hidden
              className="spinner block size-[12px] shrink-0 rounded-full border-[1.5px] border-current border-t-transparent text-subtle"
            />
          ) : headline.tone === 'error' ? (
            <CircleAlert size={14} strokeWidth={1.9} className="shrink-0" aria-hidden />
          ) : headline.tone === 'calm' ? (
            <BadgeCheck
              size={14}
              strokeWidth={1.75}
              className="shrink-0 text-success"
              aria-hidden
            />
          ) : null}
          <span className="min-w-0 break-words">{headline.text}</span>
          {counts ? (
            <span className="font-normal text-muted" data-testid="quality-stats">
              · {counts}
            </span>
          ) : null}
        </div>
        {byline && phase !== 'idle' && phase !== 'off' ? (
          <div
            className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-muted"
            data-testid="quality-byline"
          >
            <span>{byline.by}</span>
            {byline.when ? <span className="text-subtle">· {byline.when}</span> : null}
            {byline.sameVendor ? (
              <Quiet title="O revisor é do mesmo fabricante que o agente: a segunda opinião vale menos">
                mesmo fabricante
              </Quiet>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {phase === 'error' && quality.enabled ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void actions.reviewAgain(sessionId)}
            data-testid="quality-retry"
            className="sl-press inline-flex h-7 items-center gap-1 rounded-control px-2 text-[12px] text-muted hover:bg-surface-hover hover:text-fg disabled:opacity-50"
          >
            <RotateCw size={13} /> Tentar de novo
          </button>
        ) : null}
        {shownOpen.length > 0 ? (
          <button
            type="button"
            disabled={busy || fixing}
            onClick={() => void fixAll()}
            title={
              busy
                ? 'O agente ainda está a trabalhar'
                : 'Pedir ao agente que corrija os que estão à vista'
            }
            data-testid="fix-shown"
            className="sl-press inline-flex h-7 items-center gap-1.5 rounded-control bg-fg px-2.5 text-[12px] font-medium whitespace-nowrap text-bg disabled:opacity-50"
          >
            <Wand2 size={13} strokeWidth={2} aria-hidden />
            Corrigir todos
            <span className="tabular-nums opacity-70">{shownOpen.length}</span>
          </button>
        ) : null}
        <SecondOpinionButton sessionId={sessionId} />
      </div>
    </div>
  );
}

/** Os achados que o revisor tem por menos certos: dobrados, abrem com um clique. */
export function FoldedFindings({ count, children }: { count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <section
      className="overflow-hidden rounded-lg border border-line bg-surface"
      data-testid="findings-fold"
      data-open={open}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-testid="findings-fold-toggle"
        className="sl-press flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] text-muted hover:bg-surface-hover hover:text-fg"
      >
        {open ? (
          <ChevronDown size={14} strokeWidth={1.9} aria-hidden />
        ) : (
          <ChevronRight size={14} strokeWidth={1.9} aria-hidden />
        )}
        {foldLabel(count)}
      </button>
      {open ? <div className="border-t border-line">{children}</div> : null}
    </section>
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

/** Um achado só para ler (sem caixa de escolha): a mesma marca e o mesmo título que no rever. */
export function FindingLine({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(false);
  const tone = SEVERITY[finding.severity];
  return (
    <li
      className="flex items-start gap-2 text-[12.5px]"
      data-testid="finding-line"
      data-severity={finding.severity}
    >
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
    </li>
  );
}

/**
 * Um achado por baixo da linha a que se refere: a caixa para o escolher, a prioridade e a
 * confiança em letra calada, e Corrigir e Dispensar à mão (a caixa serve para juntar vários).
 */
export function FindingRow({
  sessionId,
  finding,
  picked,
  onPick,
}: {
  sessionId: string;
  finding: Finding;
  picked: boolean;
  onPick: (picked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState<'fix' | 'dismiss' | null>(null);
  const busy = useSession(sessionId, (s) => s.info.state !== 'idle');
  const tone = SEVERITY[finding.severity];
  const fixed = finding.status === 'fixed';

  const fix = async () => {
    setWorking('fix');
    await actions.fixFindings(sessionId, [finding.id]);
    setWorking(null);
  };
  const dismiss = async () => {
    setWorking('dismiss');
    await actions.dismissFindings(sessionId, [finding.id]);
    setWorking(null);
  };

  return (
    <div
      className="sl-enter sl-motion flex items-start gap-2 border-y border-line bg-surface px-3 py-1.5 font-sans text-[12.5px]"
      data-testid="finding"
      data-severity={finding.severity}
      data-status={finding.status}
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
      <div className="min-w-0 flex-1">
        {finding.detail ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="block w-full min-w-0 text-left"
          >
            <FindingTitle finding={finding} label={tone.label} open={open} />
            {open ? (
              <span className="mt-0.5 block leading-snug text-muted select-text">
                {finding.detail}
              </span>
            ) : null}
          </button>
        ) : (
          <FindingTitle finding={finding} label={tone.label} open />
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className="inline-flex items-center gap-1.5 text-[11px] text-subtle tabular-nums"
            data-testid="finding-meta"
            title={`Prioridade ${priorityLabel(finding.priority)} (P0 é a mais grave) · confiança do revisor ${confidenceLabel(finding.confidence)}`}
          >
            <span className="font-medium text-muted">{priorityLabel(finding.priority)}</span>
            <span>{confidenceLabel(finding.confidence)} de confiança</span>
          </span>
          <span className="ml-auto flex items-center gap-1">
            {fixed ? (
              <span className="text-[11.5px] text-muted" data-testid="finding-fixed">
                Pedido ao agente
              </span>
            ) : (
              <button
                type="button"
                disabled={busy || working !== null}
                onClick={() => void fix()}
                title={
                  busy ? 'O agente ainda está a trabalhar' : 'Pedir ao agente que corrija este'
                }
                aria-label={`Corrigir: ${finding.title}`}
                data-testid="finding-fix"
                className="sl-press inline-flex h-6 items-center gap-1 rounded-control px-1.5 text-[11.5px] font-medium text-fg hover:bg-surface-hover disabled:opacity-50"
              >
                <Wand2 size={12} strokeWidth={2} aria-hidden /> Corrigir
              </button>
            )}
            <button
              type="button"
              disabled={working !== null}
              onClick={() => void dismiss()}
              title="Já não mostrar este achado"
              aria-label={`Dispensar: ${finding.title}`}
              data-testid="finding-dismiss"
              className="sl-press inline-flex h-6 items-center gap-1 rounded-control px-1.5 text-[11.5px] text-muted hover:bg-surface-hover hover:text-fg disabled:opacity-50"
            >
              <X size={12} strokeWidth={2} aria-hidden /> Dispensar
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
