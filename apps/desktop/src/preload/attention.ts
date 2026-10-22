import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
contextBridge.exposeInMainWorld('sollineAttention', {
  notice: () => ipcRenderer.invoke('solline:attention-notice'),
  action: (action: 'open' | 'dismiss') => ipcRenderer.invoke('solline:attention-action', action),
  onNotice: (listener: (notice: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, notice: unknown) => listener(notice);
    ipcRenderer.on('solline:attention-notice', handler);
    return () => ipcRenderer.removeListener('solline:attention-notice', handler);
  },
});
