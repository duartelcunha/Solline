import '@solline/ui/fonts.css';
import './prompt.css';

type PromptState =
  | {
      kind: 'confirm';
      theme: 'light' | 'dark';
      title: string;
      message: string;
      detail?: string;
      acceptLabel: string;
      cancelLabel?: string;
    }
  | { kind: 'directory'; theme: 'light' | 'dark'; title: string; path: string; home: string };
type Directory = {
  path: string;
  parent: string | null;
  crumbs: { name: string; path: string }[];
  folders: { name: string; path: string }[];
  truncated: boolean;
};
declare global {
  interface Window {
    sollinePrompt: {
      state(): Promise<PromptState>;
      list(path: string): Promise<Directory>;
      answer(choice: 'cancel' | 'accept' | 'choose', path?: string): Promise<void>;
      onTheme(listener: (theme: 'light' | 'dark') => void): () => void;
    };
  }
}
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Falta o elemento ${id}`);
  return found as T;
}
let state: PromptState | undefined;
let parent: string | null = null;
let listing = 0;
let busy = false;
const input = element<HTMLInputElement>('path');
const accept = element<HTMLButtonElement>('accept');
const cancel = element<HTMLButtonElement>('cancel');
const error = element('error');
function failure(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  error.textContent = message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
function setBusy(value: boolean) {
  busy = value;
  accept.disabled = value;
}
async function answer(choice: 'cancel' | 'accept' | 'choose') {
  if (busy && choice !== 'cancel') return;
  setBusy(true);
  error.textContent = '';
  try {
    await window.sollinePrompt.answer(choice, choice === 'choose' ? input.value : undefined);
  } catch (value) {
    failure(value);
    setBusy(false);
  }
}
function folderButton(name: string, path: string, decorated = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', name);
  if (decorated) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute(
      'd',
      'M3 7V6a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
    );
    icon.append(shape);
    const label = document.createElement('span');
    label.textContent = name;
    button.append(icon, label);
  } else {
    button.textContent = name;
  }
  button.addEventListener('click', () => {
    void load(path);
  });
  return button;
}
async function load(path: string) {
  const focusFolders = element('folders').contains(document.activeElement);
  const request = ++listing;
  setBusy(true);
  error.textContent = '';
  element('folder-status').textContent = 'A abrir pasta…';
  try {
    const result = await window.sollinePrompt.list(path);
    if (request !== listing) return;
    input.value = result.path;
    parent = result.parent;
    element<HTMLButtonElement>('up').disabled = parent === null;
    element('crumbs').replaceChildren(
      ...result.crumbs.map((crumb) => folderButton(crumb.name, crumb.path)),
    );
    element('folders').replaceChildren(
      ...result.folders.map((folder) => {
        const button = folderButton(folder.name, folder.path, true);
        button.tabIndex = -1;
        return button;
      }),
    );
    if (focusFolders) element('folders').focus();
    element('folder-status').textContent = result.truncated
      ? 'A mostrar as primeiras 1000 pastas. Podes abrir um caminho diretamente.'
      : result.folders.length
        ? `${result.folders.length} pastas`
        : 'Esta pasta não tem subpastas. Podes escolhê-la.';
  } catch (value) {
    if (request === listing) {
      failure(value);
      element('folder-status').textContent = '';
    }
  } finally {
    if (request === listing) setBusy(false);
  }
}
cancel.addEventListener('click', () => {
  void answer('cancel');
});
element('dismiss').addEventListener('click', () => {
  void answer('cancel');
});
accept.addEventListener('click', () => {
  if (state) void answer(state.kind === 'directory' ? 'choose' : 'accept');
});
element('path-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void load(input.value);
});
element('home').addEventListener('click', () => {
  if (state?.kind === 'directory') void load(state.home);
});
element('up').addEventListener('click', () => {
  if (parent) void load(parent);
});
element('folders').addEventListener('keydown', (event) => {
  const buttons = [...element('folders').querySelectorAll('button')];
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === 'ArrowDown'
      ? Math.min(current + 1, buttons.length - 1)
      : event.key === 'ArrowUp'
        ? Math.max(current - 1, 0)
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : -1;
  if (next >= 0) {
    event.preventDefault();
    buttons[next]?.focus();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    void answer('cancel');
  }
});
const off = window.sollinePrompt.onTheme((theme) => {
  document.documentElement.dataset.theme = theme;
});
window.addEventListener('unload', off, { once: true });
void window.sollinePrompt
  .state()
  .then(async (value) => {
    state = value;
    document.documentElement.dataset.theme = value.theme;
    element('title').textContent = value.title;
    if (value.kind === 'confirm') {
      element('message').textContent = value.message;
      element('detail').textContent = value.detail ?? '';
      accept.textContent = value.acceptLabel;
      cancel.textContent = value.cancelLabel ?? 'Cancelar';
    } else {
      document.body.dataset.kind = 'directory';
      element('directory').hidden = false;
      accept.textContent = 'Escolher esta pasta';
      input.value = value.path;
      await load(value.path);
    }
    cancel.focus();
  })
  .catch(failure);
