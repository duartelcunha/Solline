import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow } from 'electron';
import { PromptWindows } from './prompt-window';

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  windows: [] as unknown[],
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWindow extends EventEmitter {
    url = '';
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
    });
    constructor() {
      super();
      mock.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
    async loadURL(url: string) {
      this.url = url;
    }
    show() {}
  }
  return {
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
        mock.handlers.set(channel, handler),
    },
  };
});
vi.mock('node:fs/promises', () => ({
  realpath: async (path: string) => path,
  stat: async (path: string) => ({ isDirectory: () => path !== 'C:\\file.txt' }),
  readdir: async () => [
    { name: 'project', isDirectory: () => true },
    { name: 'private-file', isDirectory: () => false },
  ],
}));

type TestWindow = { url: string; webContents: object; isDestroyed(): boolean };
function current() {
  const win = mock.windows.at(-1) as TestWindow;
  const nonce = new URL(win.url).searchParams.get('nonce');
  const event = { sender: win.webContents, senderFrame: { url: win.url, parent: null } };
  return { win, nonce, event };
}
async function invoke(channel: string, event: unknown, payload: unknown) {
  const handler = mock.handlers.get(`solline:prompt-${channel}`);
  if (!handler) throw new Error('Missing prompt IPC handler');
  return handler(event, payload);
}
function setup() {
  const parent = new BrowserWindow();
  return new PromptWindows({
    parent: () => parent,
    preload: 'preload',
    renderer: 'C:/renderer',
    initialDirectory: 'C:\\projects',
  });
}
beforeEach(() => {
  mock.windows = [];
  mock.handlers.clear();
});

describe('isolated custom prompts', () => {
  it('rejects wrong sender, frame URL, and nonce', async () => {
    const prompts = setup();
    const pending = prompts.confirm({
      title: 'Confirmar',
      message: 'Confiar?',
      acceptLabel: 'Confiar',
    });
    const { event, nonce } = current();
    await expect(invoke('state', { ...event, sender: {} }, { nonce })).rejects.toThrow('Origem');
    await expect(
      invoke(
        'state',
        { ...event, senderFrame: { url: 'file:///other.html', parent: null } },
        { nonce },
      ),
    ).rejects.toThrow('Origem');
    await expect(
      invoke('state', event, { nonce: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow('Origem');
    await expect(invoke('list', event, { nonce, path: 'C:\\projects' })).rejects.toThrow(
      'não permite',
    );
    prompts.cancelAll();
    expect(await pending).toBe(false);
  });

  it('serializes prompts and cancels queued work when recovery takes priority', async () => {
    const prompts = setup();
    const first = prompts.confirm({
      title: 'Confirmar',
      message: 'Confiar?',
      acceptLabel: 'Confiar',
    });
    const second = prompts.pickDirectory();
    expect(mock.windows).toHaveLength(2); // parent plus exactly one active prompt
    const { event, nonce } = current();
    await invoke('answer', event, { nonce, choice: 'accept' });
    expect(await first).toBe(true);
    expect(mock.windows).toHaveLength(3);
    prompts.cancelAll();
    expect(await second).toBeNull();
    expect(current().win.isDestroyed()).toBe(true);
  });

  it('returns directories only and verifies a chosen path is still a directory', async () => {
    const prompts = setup();
    const pending = prompts.pickDirectory();
    const { event, nonce } = current();
    const result = await invoke('list', event, { nonce, path: 'C:\\projects' });
    expect(result).toMatchObject({ folders: [{ name: 'project' }] });
    await expect(
      invoke('answer', event, { nonce, choice: 'choose', path: 'C:\\file.txt' }),
    ).rejects.toThrow('pasta existente');
    await invoke('answer', event, { nonce, choice: 'choose', path: 'C:\\projects' });
    expect(await pending).toBe('C:\\projects');
  });
});
