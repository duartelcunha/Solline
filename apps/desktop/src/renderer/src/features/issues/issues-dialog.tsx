import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import type { IssueList } from '@solline/protocol';
import { actions, useApp } from '../../stores/app.ts';

const button =
  'sl-press h-8 rounded-control px-3 text-[12.5px] disabled:cursor-default disabled:opacity-50';

/** A lista de issues do projeto. Sem gh, diz porquê. A sessão normal continua no menu ao lado. */
export function IssuesDialog() {
  const projectId = useApp((s) => s.issuesFor);
  if (!projectId) return null;
  return <IssuesBody key={projectId} projectId={projectId} />;
}

function IssuesBody({ projectId }: { projectId: string }) {
  const project = useApp((s) => s.projects.find((item) => item.id === projectId));
  const creating = useApp((s) => s.creatingIn === projectId);
  const [list, setList] = useState<IssueList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    void actions.listIssues(projectId)
      .then((result) => {
        if (!gone) setList(result);
      })
      .catch((reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : 'Não consegui ler as issues.');
      });
    return () => {
      gone = true;
    };
  }, [projectId]);

  const note =
    error ??
    (list?.unavailable === 'missing'
      ? 'Não encontrei o gh. As sessões normais continuam.'
      : list?.unavailable === 'logged-out'
        ? 'O gh não tem sessão. As sessões normais continuam.'
        : list && list.issues.length === 0
          ? 'Não há issues abertas.'
          : null);

  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : actions.closeIssues())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="issues-dialog"
          className="dialog-content fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-raised outline-none"
        >
          <div>
            <Dialog.Title className="text-[14px] font-semibold tracking-[-0.01em]">
              Issues
            </Dialog.Title>
            <Dialog.Description className="truncate text-[12px] text-muted">
              {project?.name ?? 'Projeto'}. Cada uma abre uma sessão na sua worktree.
            </Dialog.Description>
          </div>
          {note ? (
            <p className="text-[13px] text-muted" data-testid="issues-note">
              {note}
            </p>
          ) : list ? (
            <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto" data-testid="issues-list">
              {list.issues.map((issue) => (
                <li key={issue.id}>
                  <button
                    type="button"
                    disabled={creating}
                    onClick={() => void actions.openIssue(projectId, issue.id)}
                    data-testid="issue-row"
                    className="sl-press flex w-full items-baseline gap-2 rounded-control px-2 py-1.5 text-left hover:bg-surface-hover disabled:opacity-50"
                  >
                    <span className="shrink-0 font-mono text-[12px] text-subtle">#{issue.key}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{issue.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-subtle" data-testid="issues-note">
              A ler…
            </p>
          )}
          <footer className="flex border-t border-line pt-3">
            <button
              type="button"
              onClick={() => actions.closeIssues()}
              className={`${button} text-muted hover:bg-surface-hover hover:text-fg`}
            >
              Fechar
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
