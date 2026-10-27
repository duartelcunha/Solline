import * as Dialog from '@radix-ui/react-dialog';
import { BadgeCheck, CircleAlert, GitMerge, X } from 'lucide-react';
import { actions, useApp, useSession } from '../../stores/app.ts';
import { foldLabel, groupFindings, reviewByline, reviewPhase } from '../quality/findings-model.ts';
import { FindingLine } from '../quality/quality.tsx';

const button =
  'sl-press h-8 rounded-control px-3 text-[12.5px] disabled:cursor-default disabled:opacity-50';

/**
 * "Trazer para o projeto": antes de trazer pede-se uma revisão de toda a sessão e o resultado
 * aparece aqui, só como informação. Trazer nunca espera por ela: o botão está sempre à mão.
 */
export function BringDialog() {
  const sessionId = useApp((s) => s.bringFor);
  if (!sessionId) return null;
  return <BringBody key={sessionId} sessionId={sessionId} />;
}

function BringBody({ sessionId }: { sessionId: string }) {
  const agents = useApp((s) => s.agents);
  const title = useSession(sessionId, (s) => s.info.title);
  const workspace = useSession(sessionId, (s) => s.info.workspace);
  const quality = useSession(sessionId, (s) => s.quality);
  const busy = useSession(sessionId, (s) => s.info.state !== 'idle' && s.info.state !== 'error');
  const stats = workspace?.kind === 'worktree' ? workspace.stats : null;

  const phase = reviewPhase(quality);
  const review = quality?.review;
  // Só vale a revisão pedida por este "Trazer" (ou a que ainda corre): uma antiga não é "antes de trazer".
  const mine = review?.trigger === 'bring' || review?.state === 'running';
  const { shown, folded } = review ? groupFindings(review.findings) : { shown: [], folded: [] };
  const byline = review ? reviewByline(review, agents) : null;

  const bring = () => {
    actions.closeBring();
    void actions.bring(sessionId);
  };

  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : actions.closeBring())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="bring-dialog"
          className="dialog-content fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-raised outline-none"
        >
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[14px] font-semibold tracking-[-0.01em]">
                Trazer para o projeto
              </Dialog.Title>
              <Dialog.Description className="truncate text-[12px] text-muted">
                {title}
                {stats && stats.files > 0 ? (
                  <>
                    {' · '}
                    <span className="font-mono tabular-nums">
                      +{stats.additions} −{stats.deletions}
                    </span>{' '}
                    em {stats.files} {stats.files === 1 ? 'ficheiro' : 'ficheiros'}
                  </>
                ) : null}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Fechar sem trazer"
              className="sl-press grid size-7 shrink-0 place-items-center rounded-md text-subtle hover:bg-surface-hover hover:text-fg"
            >
              <X size={14} />
            </Dialog.Close>
          </header>

          {mine && phase !== 'unavailable' && phase !== 'idle' && phase !== 'off' ? (
            <section
              className="flex flex-col gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2.5"
              data-testid="bring-review"
              data-phase={phase}
            >
              {phase === 'running' ? (
                <p role="status" className="flex items-center gap-2 text-[12.5px] text-muted">
                  <span
                    aria-hidden
                    className="spinner block size-[12px] shrink-0 rounded-full border-[1.5px] border-current border-t-transparent text-subtle"
                  />
                  A rever o trabalho antes de trazer…
                </p>
              ) : phase === 'error' ? (
                <p role="status" className="flex items-start gap-2 text-[12.5px] text-danger">
                  <CircleAlert
                    size={14}
                    strokeWidth={1.9}
                    className="mt-0.5 shrink-0"
                    aria-hidden
                  />
                  <span>
                    A revisão falhou: {review?.error ?? 'sem detalhe'}. Podes trazer na mesma.
                  </span>
                </p>
              ) : phase === 'clean' ? (
                <p role="status" className="flex items-center gap-2 text-[12.5px] font-medium">
                  <BadgeCheck
                    size={14}
                    strokeWidth={1.75}
                    className="shrink-0 text-success"
                    aria-hidden
                  />
                  {folded.length > 0 ? 'Sem achados certos' : 'Sem achados'}
                </p>
              ) : (
                <p role="status" className="text-[12.5px] font-medium">
                  {shown.length === 1 ? '1 achado' : `${shown.length} achados`} antes de trazer
                </p>
              )}
              {shown.length > 0 ? (
                <ul className="flex flex-col gap-1.5" data-testid="bring-findings">
                  {shown.map((finding) => (
                    <FindingLine key={finding.id} finding={finding} />
                  ))}
                </ul>
              ) : null}
              {folded.length > 0 ? (
                <p className="text-[11.5px] text-subtle">{foldLabel(folded.length)} no Rever</p>
              ) : null}
              {byline && phase !== 'running' ? (
                <p className="text-[11.5px] text-muted" data-testid="bring-byline">
                  {byline.by}
                  {byline.sameVendor ? ' · mesmo fabricante' : ''}
                </p>
              ) : null}
            </section>
          ) : phase === 'off' ? (
            <p className="text-[12px] text-subtle" data-testid="bring-no-review">
              O revisor está desligado: não há segunda opinião.
            </p>
          ) : null}

          <p className="text-[12px] text-muted">
            A revisão é só informação: trazer não espera por ela.
          </p>

          <footer className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <button
              type="button"
              onClick={() => actions.closeBring()}
              className={`${button} text-muted hover:bg-surface-hover hover:text-fg`}
              data-testid="bring-cancel"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={busy || !stats || stats.files === 0}
              onClick={bring}
              title={busy ? 'O agente ainda está a trabalhar' : undefined}
              className={`${button} ml-auto inline-flex items-center gap-1.5 bg-fg font-medium text-bg`}
              data-testid="bring-confirm"
            >
              <GitMerge size={13} strokeWidth={2} aria-hidden /> Trazer
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
