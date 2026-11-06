import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { actions, useApp, useSession } from '../../stores/app.ts';

const button =
  'sl-press h-8 rounded-control px-3 text-[12.5px] disabled:cursor-default disabled:opacity-50';

/**
 * Gravar o commit: o primeiro clique abre isto, o segundo grava.
 * Fica na worktree. Não faz merge nem push.
 */
export function CommitDialog() {
  const sessionId = useApp((s) => s.commitFor);
  if (!sessionId) return null;
  return <CommitBody key={sessionId} sessionId={sessionId} />;
}

function CommitBody({ sessionId }: { sessionId: string }) {
  const title = useSession(sessionId, (s) => s.info.title);
  const busy = useSession(sessionId, (s) => s.info.state !== 'idle' && s.info.state !== 'error');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ready = text.trim().length > 0 && !busy && !saving;

  const save = () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    void actions.saveCommit(sessionId, text.trim()).then((result) => {
      setSaving(false);
      if ('error' in result) setError(result.error);
      else if (result.sha === null) setError('Nada para gravar.');
    });
  };

  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : actions.closeCommit())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="commit-dialog"
          className="dialog-content fixed top-1/2 left-1/2 z-50 flex w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-raised outline-none"
        >
          <div>
            <Dialog.Title className="text-[14px] font-semibold tracking-[-0.01em]">
              Gravar commit
            </Dialog.Title>
            <Dialog.Description className="text-[12px] text-muted">
              {title}
            </Dialog.Description>
            <p className="text-[12px] text-subtle">Fica na worktree. Sem merge nem push.</p>
          </div>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="A mensagem do commit"
            data-testid="commit-message"
            className="w-full resize-none rounded-control border border-line bg-surface-sunken px-3 py-2 text-[13px] outline-none placeholder:text-subtle"
          />
          {error ? (
            <p className="text-[12.5px] text-danger" data-testid="commit-error">
              {error}
            </p>
          ) : null}
          <footer className="flex items-center gap-2 border-t border-line pt-3">
            <button
              type="button"
              onClick={() => actions.closeCommit()}
              className={`${button} text-muted hover:bg-surface-hover hover:text-fg`}
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={save}
              className={`${button} ml-auto bg-fg font-medium text-bg`}
              data-testid="commit-confirm"
            >
              Gravar
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
