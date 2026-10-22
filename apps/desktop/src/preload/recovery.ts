import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { IPC as ProtocolIPC, RecoveryNotice } from '@solline/protocol/bridge';
declare const __SOLLINE_IPC__: typeof ProtocolIPC;
const IPC = __SOLLINE_IPC__;

contextBridge.exposeInMainWorld('sollineRecovery', {
  notice: () => ipcRenderer.invoke(IPC.recoveryNotice),
  action: (action: 'wait' | 'restore' | 'close') => ipcRenderer.invoke(IPC.recoveryAction, action),
  onNotice: (listener: (notice: RecoveryNotice) => void) => {
    const handler = (_event: IpcRendererEvent, notice: RecoveryNotice) => listener(notice);
    ipcRenderer.on(IPC.recoveryNotice, handler);
    return () => ipcRenderer.removeListener(IPC.recoveryNotice, handler);
  },
});
