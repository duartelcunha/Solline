import '@solline/ui/fonts.css';
import './recovery.css';
import type { RecoveryNotice } from '@solline/protocol/bridge';

declare global {
  interface Window {
    sollineRecovery: {
      notice(): Promise<RecoveryNotice>;
      action(action: 'wait' | 'restore' | 'close'): Promise<void>;
      onNotice(listener: (notice: RecoveryNotice) => void): () => void;
    };
  }
}
const buttons = ['wait', 'restore', 'close'] as const;
function focusSafeAction() {
  for (const id of ['wait', 'restore']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button && !button.hidden && !button.disabled) {
      button.focus();
      return;
    }
  }
}
function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Elemento de recuperação em falta: ${id}`);
  return found;
}
function show(notice: RecoveryNotice) {
  document.documentElement.dataset.theme = notice.theme;
  element('title').textContent =
    notice.reason === 'close' ? 'Fechar a Solline?' : 'Recuperar a Solline';
  element('message').textContent = notice.message;
  for (const id of buttons) {
    const button = document.getElementById(id) as HTMLButtonElement;
    button.disabled = notice.busy;
    button.hidden =
      (id === 'wait' && !notice.canWait) || (id === 'restore' && notice.reason === 'close');
  }
  element('wait').textContent = notice.reason === 'close' ? 'Continuar a trabalhar' : 'Esperar';
  if (document.activeElement === document.body) focusSafeAction();
}
const off = window.sollineRecovery.onNotice(show);
void window.sollineRecovery
  .notice()
  .then(show)
  .catch(() => {
    element('error').textContent =
      'Não foi possível consultar a recuperação. Mantém esta janela aberta.';
  });
for (const id of buttons)
  element(id).addEventListener('click', () => {
    void window.sollineRecovery.action(id).catch((error: unknown) => {
      element('error').textContent = error instanceof Error ? error.message : String(error);
    });
  });
window.addEventListener('unload', off, { once: true });
window.addEventListener('focus', focusSafeAction);
window.addEventListener('keydown', (event) => {
  const wait = document.getElementById('wait') as HTMLButtonElement;
  if (event.key === 'Escape' && !wait.hidden && !wait.disabled) {
    event.preventDefault();
    wait.click();
  }
});
