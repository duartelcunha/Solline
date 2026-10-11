import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type SollineApi } from '@solline/protocol/bridge';
import type { CommandName, CommandResult } from '@solline/protocol';

type Reply<T> = { ok: true; result: T } | { ok: false; error: { message: string } };

async function request<C extends CommandName>(command: C): Promise<CommandResult<C>> {
  const reply = (await ipcRenderer.invoke(IPC.engineRequest, { command, payload: {} })) as Reply<
    CommandResult<C>
  >;
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.result;
}

const api: SollineApi = {
  engine: {
    ping: () => request('engine.ping'),
    sdkCheck: () => request('engine.sdkCheck'),
  },
  window: {
    setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme),
  },
};

contextBridge.exposeInMainWorld('solline', api);
