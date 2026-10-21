import * as Dialog from '@radix-ui/react-dialog';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Folders, GitBranch, GitMerge, RotateCw, Send, Sparkles, X } from 'lucide-react';
import { IconSwap } from '@solline/ui/icon-swap';
import { ActionItem, MenuShell } from '../../components/menu.tsx';
import { actions, useApp, useSession } from '../../stores/app.ts';

function Delta({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="font-mono text-[11px] whitespace-nowrap tabular-nums">
      <span className="text-success">+{additions}</span>{' '}
      <span className="text-danger">−{deletions}</span>
    </span>
  );
}

/**
 * Onde a sessão trabalha, no cabeçalho: numa worktree mostra o branch e o que mudou, e o menu
 * traz o trabalho para o projeto; a partilhar a pasta (projeto sem git) mostra só a marca.
 */
export function WorkspaceChip({ sessionId }: { sessionId: string }) {
  const workspace = useSession(sessionId, (s) => s.info.workspace);
  const conflicts = useSession(sessionId, (s) => s.conflicts);
  const setup = useSession(sessionId, (s) => s.info.setup);
  const port = useSession(sessionId, (s) => s.info.port);
  const busy = useSession(sessionId, (s) => s.info.state !== 'idle' && s.info.state !== 'error');

  if (workspace?.kind === 'shared') {
    return (
      <span
        title="Outra sessão trabalha na mesma pasta (o projeto não é git, por isso não há worktree)"
        data-testid="workspace-shared"
        className="inline-flex h-7 items-center gap-1.5 px-2 text-[12px] text-subtle"
      >
        <Folders size={14} strokeWidth={1.75} />
        Mesma pasta
      </span>
    );
  }
  if (workspace?.kind !== 'worktree') return null;

  const { stats } = workspace;
  const name = workspace.branch.replace(/^solline\//, '');
  return (
    <MenuShell
      title="Worktree"
      side="bottom"
      align="end"
      trigger={
        <Menu.Trigger
          aria-label={`Branch ${workspace.branch}`}
          title={workspace.branch}
          data-testid="workspace-chip"
          data-branch={workspace.branch}
          className="no-drag sl-press inline-flex h-7 max-w-[13rem] items-center gap-1.5 rounded-control px-2 text-[12px] text-muted outline-none hover:bg-surface-hover hover:text-fg data-[state=open]:bg-surface-hover"
        >
          <IconSwap swapKey={setup?.state ?? 'done'}>
            {setup?.state === 'running' ? (
              <span
                aria-hidden
                className="spinner block size-[12px] rounded-full border-[1.5px] border-current border-t-transparent text-subtle"
              />
            ) : setup?.state === 'failed' ? (
              <svg aria-hidden width="11" height="11" viewBox="0 0 10 10" className="text-danger">
                <path d="M3 0h4l3 3v4l-3 3H3L0 7V3z" fill="currentColor" />
              </svg>
            ) : (
              <GitBranch size={14} strokeWidth={1.75} className="shrink-0" />
            )}
          </IconSwap>
          <span className="truncate" data-testid="workspace-label">
            {setup?.state === 'running' ? 'A preparar' : name}
          </span>
        </Menu.Trigger>
      }
    >
      {setup?.state === 'failed' ? (
        <>
          {setup.tail ? (
            <pre
              data-testid="setup-tail"
              className="mx-1 mb-1 max-h-40 overflow-y-auto rounded-control bg-surface-sunken px-2.5 py-2 font-mono text-[11px] leading-snug [overflow-wrap:anywhere] whitespace-pre-wrap text-muted select-text"
            >
              {setup.tail}
            </pre>
          ) : null}
          <ActionItem
            title="Repetir a preparação"
            icon={<RotateCw size={14} />}
            onSelect={() => void actions.retrySetup(sessionId)}
            testId="setup-retry"
          />
          <ActionItem
            title="Mandar ao agente"
            icon={<Send size={14} />}
            disabled={busy}
            onSelect={() => void actions.fixSetup(sessionId)}
            testId="setup-fix"
          />
        </>
      ) : null}
      {conflicts ? (
        <ActionItem
          title="Pedir ao agente para resolver"
          description={`Conflitos em ${conflicts.files.length} ${conflicts.files.length === 1 ? 'ficheiro' : 'ficheiros'}`}
          icon={<Sparkles size={14} />}
          disabled={busy}
          onSelect={() => void actions.resolveConflicts(sessionId)}
          testId="workspace-resolve"
        />
      ) : null}
      <ActionItem
        title="Trazer para o projeto"
        description={
          stats.files > 0
            ? `+${stats.additions} −${stats.deletions} em ${stats.files} ${stats.files === 1 ? 'ficheiro' : 'ficheiros'}`
            : 'Nada por trazer'
        }
        icon={<GitMerge size={14} />}
        disabled={busy || stats.files === 0}
        onSelect={() => void actions.bring(sessionId)}
        testId="workspace-bring"
      />
      {port !== undefined ? (
        <div
          className="px-2.5 py-1 text-[11.5px] text-subtle tabular-nums"
          data-testid="session-port"
        >
          Portas {port}–{port + 9}
        </div>
      ) : null}
      <ActionItem
        title="Fechar sessão"
        icon={<X size={14} />}
        onSelect={() => void actions.closeSession(sessionId)}
        testId="workspace-close"
      />
    </MenuShell>
  );
}

const buttonClass =
  'sl-press inline-flex h-8 items-center rounded-control px-3 text-[12.5px] font-medium disabled:opacity-60';

/** Fechar uma sessão com trabalho por trazer: trazer, guardar o branch ou deitar fora. */
export function CloseDialog() {
  const closing = useApp((s) => s.closing);
  const title = useSession(closing?.sessionId ?? null, (s) => s.info.title);
  if (!closing) return null;
  const close = (choice: 'bring' | 'keep' | 'discard') =>
    void actions.closeSession(closing.sessionId, choice);
  if (closing.queued) {
    // Mensagens na fila: fechar deita-as fora, por isso pergunta antes.
    return (
      <Dialog.Root
        open
        onOpenChange={(open) => (open ? undefined : useApp.setState({ closing: null }))}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
          <Dialog.Content
            data-testid="close-queue-dialog"
            className="dialog-content fixed top-1/2 left-1/2 z-50 flex w-[min(24rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-raised outline-none"
          >
            <div>
              <Dialog.Title className="truncate text-[14px] font-semibold tracking-[-0.01em]">
                {title}
              </Dialog.Title>
              <Dialog.Description className="text-[12px] text-muted">
                {closing.queued === 1
                  ? 'Tens uma mensagem na fila.'
                  : `Tens ${closing.queued} mensagens na fila.`}
              </Dialog.Description>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => useApp.setState({ closing: null })}
                className={`${buttonClass} border border-line hover:bg-surface-hover`}
              >
                Manter aberta
              </button>
              <button
                type="button"
                onClick={() => void actions.closeSession(closing.sessionId, undefined, true)}
                className={`${buttonClass} ml-auto text-danger hover:bg-surface-hover`}
                data-testid="close-drop-queue"
              >
                Fechar e deitar fora
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => (open ? undefined : useApp.setState({ closing: null }))}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="close-dialog"
          className="dialog-content fixed top-1/2 left-1/2 z-50 flex w-[min(26rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-raised outline-none"
        >
          <div>
            <Dialog.Title className="truncate text-[14px] font-semibold tracking-[-0.01em]">
              {title}
            </Dialog.Title>
            <Dialog.Description className="text-[12px] text-muted">
              Trabalho por trazer: <Delta {...closing} /> em {closing.files}{' '}
              {closing.files === 1 ? 'ficheiro' : 'ficheiros'}
            </Dialog.Description>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => close('bring')}
              className={`${buttonClass} bg-fg text-bg`}
              data-testid="close-bring"
            >
              Trazer e fechar
            </button>
            <button
              type="button"
              onClick={() => close('keep')}
              className={`${buttonClass} border border-line hover:bg-surface-hover`}
              data-testid="close-keep"
            >
              Guardar o branch
            </button>
            <button
              type="button"
              onClick={() => close('discard')}
              className={`${buttonClass} ml-auto text-danger hover:bg-surface-hover`}
              data-testid="close-discard"
            >
              Deitar fora
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
