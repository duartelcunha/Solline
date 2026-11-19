import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { RefreshCw, Settings, X } from 'lucide-react';
import type { CommandResult, StartupView } from '@solline/protocol';
import './navigation.css';

const choices: { value: StartupView; label: string; detail: string }[] = [
  {
    value: 'resume',
    label: 'Retomar onde estava',
    detail: 'Volta ao último espaço ou conversa. Os agentes não arrancam sozinhos.',
  },
  {
    value: 'general-tasks',
    label: 'Tarefas do Geral',
    detail: 'Começa pelas tarefas e ideias guardadas no Geral.',
  },
  { value: 'desk', label: 'Mesa', detail: 'Começa pela visão do trabalho dos agentes.' },
];
export function NavigationSettings({
  value,
  writable,
  onChange,
  error,
  onAgents,
}: {
  value: StartupView;
  writable: boolean;
  onChange: (value: StartupView) => Promise<void>;
  error: string | null;
  onAgents: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<CommandResult<'app.checkUpdate'> | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  async function save(next: StartupView) {
    setSaving(true);
    try {
      await onChange(next);
    } finally {
      setSaving(false);
    }
  }

  async function checkUpdates() {
    setCheckingUpdate(true);
    setUpdateMessage(null);
    try {
      const result = await window.solline.request('app.checkUpdate', {});
      setUpdateResult(result);
    } catch (err) {
      setUpdateMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function installUpdate(version: string) {
    setInstallingUpdate(true);
    setUpdateMessage(null);
    try {
      const result = await window.solline.request('app.installUpdate', { version });
      if (result.started) {
        setUpdateMessage(
          result.openedReleasePage
            ? 'Página do lançamento aberta no browser.'
            : 'Instalador verificado e aberto.',
        );
      }
    } catch (err) {
      setUpdateMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingUpdate(false);
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="navigation-icon"
          aria-label="Definições"
          title="Definições"
          data-testid="navigation-settings"
        >
          <Settings size={16} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="navigation-overlay" />
        <Dialog.Content className="navigation-dialog navigation-settings-dialog">
          <div className="flex items-center justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">Definições</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="navigation-icon" aria-label="Fechar definições">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-2 text-sm text-muted">
            Escolhe como queres começar no Solline.
          </Dialog.Description>
          <fieldset disabled={saving || !writable} className="navigation-startup">
            <legend>Ao abrir a aplicação</legend>
            {choices.map((choice) => (
              <label key={choice.value} className="navigation-choice">
                <input
                  type="radio"
                  name="startup-view"
                  value={choice.value}
                  checked={writable && value === choice.value}
                  onChange={() => void save(choice.value)}
                />
                <span>
                  <strong>{choice.label}</strong>
                  <small>{choice.detail}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <p className="mt-4 text-xs text-muted" role="status">
            {!writable
              ? 'As preferências estão indisponíveis. Podes continuar a usar o Solline.'
              : saving
                ? 'A guardar…'
                : 'A escolha aplica-se na próxima abertura.'}
          </p>
          <section className="mt-5 border-t border-line pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold">Atualizações</h3>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:bg-surface-hover disabled:opacity-50"
                onClick={() => void checkUpdates()}
                disabled={checkingUpdate || installingUpdate}
                data-testid="check-updates"
              >
                <RefreshCw size={12} className={checkingUpdate ? 'animate-spin' : undefined} />
                {checkingUpdate ? 'A verificar…' : 'Verificar atualizações'}
              </button>
            </div>
            <div role="status" className="mt-2 space-y-2 text-xs text-muted">
              {updateResult ? (
                updateResult.status === 'available' && updateResult.latestVersion ? (
                  <>
                    <p className="font-medium text-fg">
                      Nova versão disponível: v{updateResult.latestVersion} (atual: v
                      {updateResult.currentVersion})
                    </p>
                    {updateResult.notes ? (
                      <pre className="max-h-24 overflow-auto rounded-control border border-line bg-surface-sunken p-2 font-sans text-xs whitespace-pre-wrap text-muted">
                        {updateResult.notes}
                      </pre>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        className="rounded-control bg-fg px-2.5 py-1 text-xs font-medium text-bg disabled:opacity-50"
                        disabled={installingUpdate}
                        onClick={() => void installUpdate(updateResult.latestVersion ?? '')}
                        data-testid="install-update"
                      >
                        {installingUpdate
                          ? 'A transferir…'
                          : updateResult.installer
                            ? 'Transferir e instalar'
                            : 'Abrir lançamento'}
                      </button>
                      {updateResult.releaseUrl ? (
                        <button
                          type="button"
                          className="rounded-control border border-line px-2.5 py-1 text-xs hover:bg-surface-hover"
                          onClick={() => window.open(updateResult.releaseUrl ?? undefined)}
                        >
                          Ver no GitHub
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : updateResult.status === 'up-to-date' ? (
                  <p>
                    {updateResult.detail ??
                      `O Solline está atualizado (v${updateResult.currentVersion}).`}
                  </p>
                ) : (
                  <p>{updateResult.detail ?? 'Não foi possível verificar atualizações.'}</p>
                )
              ) : null}
              {updateMessage ? <p className="text-fg">{updateMessage}</p> : null}
            </div>
          </section>
          <button
            type="button"
            className="mt-5 rounded-control border border-line px-3 py-2 text-sm hover:bg-surface-hover"
            onClick={() => {
              setOpen(false);
              requestAnimationFrame(onAgents);
            }}
          >
            Gerir agentes
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
