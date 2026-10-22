import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { IPC as ProtocolIPC, SollineApi, WindowState } from '@solline/protocol/bridge';
declare const __SOLLINE_IPC__: typeof ProtocolIPC;
const IPC = __SOLLINE_IPC__;
import type { EngineEvent } from '@solline/protocol';

// Kept inside the isolated preload; the page cannot manufacture health acknowledgements.
ipcRenderer.on(IPC.healthProbe, (_event, token: unknown) => {
  if (typeof token === 'string') ipcRenderer.send(IPC.healthReply, token);
});

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
    state: () => ipcRenderer.invoke(IPC.windowState),
    action: (action) => ipcRenderer.invoke(IPC.windowAction, action),
    onState: (listener) => {
      const handler = (_event: IpcRendererEvent, state: WindowState) => listener(state);
      ipcRenderer.on(IPC.windowState, handler);
      return () => ipcRenderer.removeListener(IPC.windowState, handler);
    },
    onPrepareClose: (listener) => {
      const handler = (_event: IpcRendererEvent, token: unknown) => {
        if (typeof token !== 'string') return;
        void listener()
          .then(
            () => ipcRenderer.invoke(IPC.preparedClose, { token, ok: true }),
            () => ipcRenderer.invoke(IPC.preparedClose, { token, ok: false }),
          )
          .catch(() => undefined);
      };
      ipcRenderer.on(IPC.prepareClose, handler);
      return () => ipcRenderer.removeListener(IPC.prepareClose, handler);
    },
    onCloseCancelled: (listener) => {
      const handler = () => listener();
      ipcRenderer.on(IPC.closeCancelled, handler);
      return () => ipcRenderer.removeListener(IPC.closeCancelled, handler);
    },
  },
  recovery: {
    open: () => ipcRenderer.invoke(IPC.recoveryOpen),
    ui: () => ipcRenderer.invoke(IPC.recoveryUi),
    saveDraft: (update) => ipcRenderer.invoke(IPC.recoveryDraft, update),
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
