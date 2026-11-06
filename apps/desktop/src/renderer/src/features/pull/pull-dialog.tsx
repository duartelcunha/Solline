import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import type { CiCheck } from '@solline/protocol';
import { actions, useApp, useSession } from '../../stores/app.ts';

const button =
  'sl-press h-8 rounded-control px-3 text-[12.5px] disabled:cursor-default disabled:opacity-50';

const STATE: Record<CiCheck['state'], string> = {
  pending: 'à espera',
  passed: 'passou',
  failed: 'falhou',
  skipped: 'ignorado',
};

/** O texto que entra na fila, como mensagem tua. Um clique, uma mensagem. */
export function failedCheckText(check: Pick<CiCheck, 'name' | 'summary'>): string {
  const summary = check.summary.trim();
  const head = `O check ${check.name} falhou.`;
  return summary ? `${head}\n\n${summary}` : head;
}

/** Título e corpo editáveis. Depois do PR, os checks e o botão do que falhou. */
export function PullDialog() {
  const sessionId = useApp((s) => s.pullFor);
  if (!sessionId) return null;
  return <PullBody key={sessionId} sessionId={sessionId} />;
}

function PullBody({ sessionId }: { sessionId: string }) {
  const title = useSession(sessionId, (s) => s.info.title);
  const pull = useSession(sessionId, (s) => s.pull);
  const archived = useSession(sessionId, (s) => s.info.archived === true);
  const ci = useSession(sessionId, (s) => s.ci);
  const [heading, setHeading] = useState(title);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);

  useEffect(() => {
    if (!pull) return;
    void actions.readCi(sessionId).then((result) => {
      if (result.error) setError(result.error);
    });
  }, [sessionId, pull]);

  const open = () => {
    const next = heading.trim();
    if (!next || opening) return;
    setOpening(true);
    setError(null);
    void actions.openPull(sessionId, next, body.trim()).then((result) => {
      setOpening(false);
      if ('error' in result) setError(result.error);
    });
  };

  const sendFailed = (check: CiCheck) => {
    if (sending) return;
    setSending(check.id);
    setError(null);
    void actions.send(sessionId, failedCheckText(check), 'queue').then((ok) => {
      setSending(null);
      if (ok) setQueued(check.id);
      else setError('Não consegui pôr o check na fila.');
    });
  };

  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : actions.closePull())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="pull-dialog"
          className="dialog-content fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface p-4 shadow-raised outline-none"
        >
          <div>
            <Dialog.Title className="text-[14px] font-semibold tracking-[-0.01em]">
              {pull ? `PR #${pull.key}` : 'Abrir pull request'}
            </Dialog.Title>
            <Dialog.Description className="text-[12px] text-muted">
              {pull ? pull.title : 'Envia o branch da worktree. Não faz merge.'}
            </Dialog.Description>
          </div>
          {pull ? (
            <section className="flex flex-col gap-2" data-testid="ci-panel">
              {ci ? (
                ci.checks.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {ci.checks.map((check) => (
                      <li
                        key={check.id}
                        data-testid="ci-check"
                        data-state={check.state}
                        className="rounded-control border border-line bg-surface-sunken px-3 py-2"
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-[13px]">{check.name}</span>
                          <span className="shrink-0 text-[12px] text-subtle">{STATE[check.state]}</span>
                        </div>
                        {check.summary ? (
                          <p className="mt-1 text-[12px] text-muted">{check.summary}</p>
                        ) : null}
                        {check.state === 'failed' ? (
                          <button
                            type="button"
                            disabled={sending !== null || archived}
                            onClick={() => sendFailed(check)}
                            className={`${button} mt-2 border border-line hover:bg-surface-hover`}
                            data-testid="ci-send"
                          >
                            Mandar ao agente
                          </button>
                        ) : null}
                        {queued === check.id ? (
                          <p className="mt-1 text-[12px] text-subtle">Na fila.</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-muted" data-testid="ci-empty">
                    Ainda não há checks.
                  </p>
                )
              ) : (
                <p className="text-[13px] text-subtle" data-testid="ci-loading">
                  A ler os checks…
                </p>
              )}
            </section>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-[12px] text-subtle">
                Título
                <input
                  value={heading}
                  onChange={(event) => setHeading(event.target.value)}
                  maxLength={300}
                  data-testid="pull-title"
                  className="h-8 rounded-control border border-line bg-surface-sunken px-3 text-[13px] text-fg outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-[12px] text-subtle">
                Corpo
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={5}
                  maxLength={20000}
                  data-testid="pull-body"
                  className="w-full resize-none rounded-control border border-line bg-surface-sunken px-3 py-2 text-[13px] text-fg outline-none"
                />
              </label>
            </>
          )}
          {error ? (
            <p className="text-[12.5px] text-danger" data-testid="pull-error">
              {error}
            </p>
          ) : null}
          <footer className="flex items-center gap-2 border-t border-line pt-3">
            <button
              type="button"
              onClick={() => actions.closePull()}
              className={`${button} text-muted hover:bg-surface-hover hover:text-fg`}
            >
              Fechar
            </button>
            {pull ? null : (
              <button
                type="button"
                disabled={!heading.trim() || opening}
                onClick={open}
                className={`${button} ml-auto bg-fg font-medium text-bg`}
                data-testid="pull-open"
              >
                Abrir
              </button>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
