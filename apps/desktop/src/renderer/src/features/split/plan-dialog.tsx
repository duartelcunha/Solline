import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, X } from 'lucide-react';
import type { SplitReview } from '@solline/protocol';
import { useDragScroll } from '@solline/ui/scroll';
import { actions, useApp, useSession } from '../../stores/app.ts';
import { shortModelName } from '../composer/pills.tsx';
import { laneOptions } from '../race/lane-options.ts';
import { PartCard } from './part-card.tsx';
import {
  MAX_PARTS,
  addDraft,
  launchCount,
  patchDraft,
  removeDraft,
  toReviewPayload,
  toStartParts,
  type PartDraft,
} from './plan-model.ts';
import { ReviewStrip } from './review-strip.tsx';

const button =
  'sl-press h-8 rounded-control px-3 text-[12.5px] disabled:cursor-default disabled:opacity-50';

/**
 * O plano de uma repartição, para rever e editar antes de lançar: um cartão por parte, a
 * conferência ao vivo por baixo e o custo à vista. Fechar descarta; nada arranca sozinho.
 */
export function PlanDialog({
  sessionId,
  projectId,
  text,
  initial,
  onClose,
  onSendNormal,
}: {
  sessionId: string;
  projectId: string;
  text: string;
  initial: PartDraft[];
  onClose: () => void;
  /** "Não partir": envia o pedido como uma sessão normal. */
  onSendNormal: () => void;
}) {
  const agents = useApp((s) => s.agents);
  const agent = useSession(sessionId, (s) => s.info.agent);
  const settings = useSession(sessionId, (s) => s.info.settings);
  const capabilities = useSession(sessionId, (s) => s.capabilities);
  const projectChecks = useSession(sessionId, (s) => s.checks);
  const checks = useMemo(
    () =>
      projectChecks?.trusted
        ? projectChecks.specs.filter((c) => c.enabled).map((c) => ({ id: c.id, label: c.label }))
        : [],
    [projectChecks],
  );
  const checkKey = checks.map((c) => c.id).join(',');
  const options = useMemo(
    () =>
      laneOptions({
        agent,
        model: settings.model,
        models: capabilities?.models ?? [],
        agents,
        modelLabel: (m) => shortModelName(m, m.id),
        includeCurrent: true,
      }),
    [agent, settings.model, capabilities, agents],
  );

  const [drafts, setDrafts] = useState<PartDraft[]>(initial);
  const [review, setReview] = useState<SplitReview | null>(null);
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useDragScroll(body);

  // A conferência acompanha as edições, com um pequeno atraso para não correr a cada letra.
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      const payload = toReviewPayload(drafts, checkKey ? checkKey.split(',') : []);
      void actions.reviewSplit(payload.parts, payload.checkIds).then((result) => {
        if (current) setReview(result);
      });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [drafts, checkKey]);

  const base = { agent, model: settings.model };
  const firstCheck = checks[0]?.id ?? null;
  const count = launchCount(review);
  const droppedAt = (index: number) =>
    review?.dropped.find((d) => d.index === index)?.reason ?? null;

  const launch = async () => {
    setBusy(true);
    try {
      const started = await actions.startSplit(projectId, text, toStartParts(drafts));
      if (started) {
        actions.editComposer(sessionId, '');
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="split-plan"
          className="dialog-content fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(72rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-raised outline-none"
        >
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[14px] font-semibold tracking-[-0.01em]">
                Partir em partes
              </Dialog.Title>
              <Dialog.Description className="text-[12px] text-muted">
                Cada parte corre numa pista própria. Só se lança a que tem uma verificação.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Fechar sem lançar"
              data-testid="split-plan-close"
              className="sl-press grid size-7 shrink-0 place-items-center rounded-md text-subtle hover:bg-surface-hover hover:text-fg"
            >
              <X size={14} />
            </Dialog.Close>
          </header>

          <div
            ref={body}
            className="scroll-fade-y flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
          >
            <p className="line-clamp-2 text-[12.5px] text-muted" data-testid="split-text">
              {text}
            </p>
            {checks.length === 0 ? (
              <p className="text-[12px] text-muted" data-testid="split-no-checks">
                O projeto não tem verificações ligadas: sem elas nenhuma parte se lança.
              </p>
            ) : null}
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(18rem,1fr))]">
              {drafts.map((draft, index) => (
                <PartCard
                  key={draft.id}
                  index={index}
                  draft={draft}
                  options={options}
                  checks={checks}
                  dropped={droppedAt(index)}
                  canRemove={drafts.length > 2}
                  onChange={(patch) => setDrafts((d) => patchDraft(d, index, patch))}
                  onRemove={() => setDrafts((d) => removeDraft(d, index))}
                />
              ))}
            </div>
            {drafts.length < MAX_PARTS ? (
              <button
                type="button"
                onClick={() => setDrafts((d) => addDraft(d, base, firstCheck))}
                className="sl-press inline-flex items-center gap-1 self-start rounded-md px-2 py-1 text-[12px] font-medium text-muted hover:bg-surface-hover hover:text-fg"
                data-testid="split-add-part"
              >
                <Plus size={13} /> Parte
              </button>
            ) : null}
            <ReviewStrip review={review} zeroFirst={drafts[0]?.zero === true} />
          </div>

          <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
            <span className="min-w-0 flex-1 text-[12.5px] text-muted" data-testid="split-cost">
              {review
                ? count > 0
                  ? `Custa cerca de ${count}× os tokens de um agente só.`
                  : 'Nenhuma parte se lança.'
                : 'A conferir…'}
            </span>
            <button
              type="button"
              onClick={onSendNormal}
              title="Enviar o pedido como uma sessão normal"
              className={`${button} text-muted hover:bg-surface-hover hover:text-fg`}
              data-testid="split-dont"
            >
              Não partir
            </button>
            <button
              type="button"
              disabled={busy || count === 0}
              onClick={() => void launch()}
              className={`${button} bg-fg text-bg`}
              data-testid="split-launch"
            >
              {count === 1 ? 'Lançar 1 parte' : `Lançar ${count} partes`}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
