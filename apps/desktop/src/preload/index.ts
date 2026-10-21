import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type SollineApi } from '@solline/protocol/bridge';
import type { EngineEvent } from '@solline/protocol';

type Reply = { ok: true; result: unknown } | { ok: false; error: { message: string } };

const api: SollineApi = {
  request: async (command, payload) => {
    const reply = (await ipcRenderer.invoke(IPC.request, { command, payload })) as Reply;
    if (!reply.ok) throw new Error(reply.error.message);
    return reply.result as never;
  },
  onEvent: (listener) => {
    // O main só reenvia eventos que já passaram pelo zod.
    const handler = (_event: IpcRendererEvent, data: unknown) => listener(data as EngineEvent);
    ipcRenderer.on(IPC.event, handler);
    return () => {
      ipcRenderer.removeListener(IPC.event, handler);
    };
  },
  window: {
    setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme),
  },
  onFocusSession: (listener) => {
    const handler = (_event: IpcRendererEvent, sessionId: unknown) => {
      if (typeof sessionId === 'string') listener(sessionId);
    };
    ipcRenderer.on(IPC.focusSession, handler);
    return () => {
      ipcRenderer.removeListener(IPC.focusSession, handler);
    };
  },
};

contextBridge.exposeInMainWorld('solline', api);
