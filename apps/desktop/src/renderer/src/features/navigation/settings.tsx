import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Settings, X } from 'lucide-react';
import type { StartupView } from '@solline/protocol';
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
  onChange,
  error,
  onAgents,
}: {
  value: StartupView;
  onChange: (value: StartupView) => Promise<void>;
  error: string | null;
  onAgents: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  async function save(next: StartupView) {
    setSaving(true);
    try {
      await onChange(next);
    } finally {
      setSaving(false);
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
          <fieldset disabled={saving} className="navigation-startup">
            <legend>Ao abrir a aplicação</legend>
            {choices.map((choice) => (
              <label key={choice.value} className="navigation-choice">
                <input
                  type="radio"
                  name="startup-view"
                  value={choice.value}
                  checked={value === choice.value}
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
            {saving ? 'A guardar…' : 'A escolha aplica-se na próxima abertura.'}
          </p>
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
