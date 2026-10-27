import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Split, X } from 'lucide-react';
import { IconSwap } from '@solline/ui/icon-swap';
import { actions, useSession } from '../../stores/app.ts';
import { Mark } from '../quality/checks.tsx';
import { PlanDialog } from './plan-dialog.tsx';
import { draftsFromPlan, templateDrafts, type PartDraft } from './plan-model.ts';

/**
 * "Partir": pede ao planeador que corte o pedido do compositor em partes. Só um gesto teu o
 * arranca, e ignora-se o resultado se desistires. Três respostas possíveis: o plano abre para
 * rever, "não vale a pena" (com a razão) ou partir à mão.
 */

/** `text` é o pedido a que a fase se refere: se o texto mudar, a fase deixa de valer. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'reading'; text: string }
  | { kind: 'keep'; text: string; reason: string };

const pillClass =
  'pill chip-in sl-press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-line px-2.5 text-[12px] whitespace-nowrap text-muted outline-none hover:border-line-strong hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--sl-focus)] disabled:opacity-50';

export function useSplitFlow({
  sessionId,
  projectId,
  text,
  disabled,
  onSendNormal,
}: {
  sessionId: string;
  projectId: string;
  text: string;
  disabled: boolean;
  /** Envia o texto como uma mensagem normal (a sessão, sem partir). */
  onSendNormal: () => void;
}): { pill: ReactNode; card: ReactNode; dialog: ReactNode } {
  const agent = useSession(sessionId, (s) => s.info.agent);
  const model = useSession(sessionId, (s) => s.info.settings.model);
  const checks = useSession(sessionId, (s) => s.checks);
  const [state, setPhase] = useState<Phase>({ kind: 'idle' });
  const [plan, setPlan] = useState<{ drafts: PartDraft[]; text: string } | null>(null);
  const ticket = useRef(0);
  const hasText = text.trim().length > 0;

  // Mudar o texto a meio deixa a fase e a resposta velhas sem efeito.
  const phase: Phase = state.kind !== 'idle' && state.text !== text ? { kind: 'idle' } : state;
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  }, [text]);

  const firstCheck = useMemo(
    () => (checks?.trusted ? (checks.specs.find((c) => c.enabled)?.id ?? null) : null),
    [checks],
  );
  const base = { agent, model };

  const ask = async () => {
    const mine = ++ticket.current;
    const asked = text;
    setPhase({ kind: 'reading', text: asked });
    const result = await actions.planSplit(projectId, asked.trim());
    // Desististe (ou mudaste o texto) enquanto o planeador lia: ignora-se a resposta.
    if (ticket.current !== mine || latest.current !== asked) return;
    if (!result) {
      setPhase({ kind: 'idle' });
      return;
    }
    if (result.plan.decision === 'keep') {
      setPhase({ kind: 'keep', text: asked, reason: result.plan.reason });
      return;
    }
    setPhase({ kind: 'idle' });
    setPlan({ drafts: draftsFromPlan(result.plan.parts, base), text: asked.trim() });
  };
  const cancel = () => {
    ticket.current++;
    setPhase({ kind: 'idle' });
  };
  const byHand = () => {
    setPhase({ kind: 'idle' });
    setPlan({ drafts: templateDrafts(base, firstCheck), text: text.trim() });
  };

  const reading = phase.kind === 'reading';
  const pill =
    projectId && (hasText || phase.kind !== 'idle') ? (
      <button
        type="button"
        disabled={disabled || (!hasText && !reading)}
        onClick={() => (reading ? cancel() : void ask())}
        data-testid="pill-split"
        aria-label={reading ? 'A ler o projeto. Cancelar' : 'Partir o pedido em partes'}
        title={reading ? 'Cancelar' : 'Partir o pedido em partes (custa mais tokens)'}
        className={pillClass}
      >
        <IconSwap swapKey={reading ? 'reading' : 'idle'} className="size-3.5">
          {reading ? <Mark face="running" /> : <Split size={13} />}
        </IconSwap>
        <span>{reading ? 'A ler o projeto…' : 'Partir'}</span>
      </button>
    ) : null;

  const card =
    phase.kind === 'keep' ? (
      <div
        className="sl-enter mb-2 flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3"
        data-testid="split-keep"
      >
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
            <span className="font-semibold">Não vale a pena partir.</span>{' '}
            <span className="text-muted" data-testid="split-keep-reason">
              {phase.reason}
            </span>
          </p>
          <button
            type="button"
            onClick={cancel}
            aria-label="Fechar"
            className="sl-press grid size-6 shrink-0 place-items-center rounded-md text-subtle hover:bg-surface-hover hover:text-fg"
          >
            <X size={13} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              cancel();
              onSendNormal();
            }}
            className="sl-press h-8 rounded-control bg-fg px-3 text-[12.5px] text-bg"
            data-testid="split-keep-send"
          >
            Enviar como uma sessão normal
          </button>
          <button
            type="button"
            onClick={byHand}
            className="sl-press h-8 rounded-control px-3 text-[12.5px] text-muted hover:bg-surface-hover hover:text-fg"
            data-testid="split-by-hand"
          >
            Partir à mão
          </button>
        </div>
      </div>
    ) : null;

  const dialog = plan ? (
    <PlanDialog
      sessionId={sessionId}
      projectId={projectId}
      text={plan.text}
      initial={plan.drafts}
      onClose={() => setPlan(null)}
      onSendNormal={() => {
        setPlan(null);
        onSendNormal();
      }}
    />
  ) : null;

  return { pill, card, dialog };
}
