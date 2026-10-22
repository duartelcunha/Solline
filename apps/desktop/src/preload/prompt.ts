import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
declare const location: { readonly href: string };
const nonce = new URL(location.href).searchParams.get('nonce');
contextBridge.exposeInMainWorld('sollinePrompt', {
  state: () => ipcRenderer.invoke('solline:prompt-state', { nonce }),
  list: (path: string) => ipcRenderer.invoke('solline:prompt-list', { nonce, path }),
  answer: (choice: 'cancel' | 'accept' | 'choose', path?: string) =>
    ipcRenderer.invoke('solline:prompt-answer', {
      nonce,
      choice,
      ...(path === undefined ? {} : { path }),
    }),
  onTheme: (listener: (theme: 'light' | 'dark') => void) => {
    const handler = (_event: IpcRendererEvent, theme: unknown) => {
      if (theme === 'light' || theme === 'dark') listener(theme);
    };
    ipcRenderer.on('solline:prompt-theme', handler);
    return () => ipcRenderer.removeListener('solline:prompt-theme', handler);
  },
});
