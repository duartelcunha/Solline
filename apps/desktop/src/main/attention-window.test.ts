import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { AttentionWindow } from './attention-window';

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, action?: unknown) => unknown>(),
  windows: [] as unknown[],
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWindow extends EventEmitter {
    url = '';
    destroyed = false;
    showInactive = vi.fn();
    hide = vi.fn();
    webContents = Object.assign(new EventEmitter(), {
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
    });
    constructor(readonly options: unknown) {
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
  }
  return {
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: (name: string, handler: (event: unknown, action?: unknown) => unknown) =>
        mock.handlers.set(name, handler),
    },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  };
});

type TestWindow = {
  url: string;
  options: { webPreferences: Record<string, unknown> };
  webContents: {
    session: {
      setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      setPermissionCheckHandler: ReturnType<typeof vi.fn>;
    };
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
  };
  showInactive: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  emit(name: string): void;
  destroyed: boolean;
};
function setup() {
  const open = vi.fn();
  const surface = new AttentionWindow(
    () => undefined as BrowserWindow | undefined,
    'preload',
    'renderer',
    open,
    'http://localhost:5173',
  );
  surface.show({
    sessionId: 'first',
    title: 'Claude · Project',
    body: 'Precisa de ti',
    urgent: true,
  });
  const win = mock.windows.at(-1) as TestWindow;
  const event = { sender: win.webContents, senderFrame: { parent: null, url: win.url } };
  const invoke = (name: string, sender: unknown = event, action?: unknown) => {
    const handler = mock.handlers.get(`solline:attention-${name}`);
    if (!handler) throw new Error('Missing attention handler');
    return handler(sender, action);
  };
  return { surface, open, win, event, invoke };
}
beforeEach(() => {
  vi.useFakeTimers();
  mock.windows = [];
  mock.handlers.clear();
});
afterEach(() => vi.useRealTimers());

describe('isolated attention window', () => {
  it('accepts actions only from its exact top-level document and literal action allowlist', () => {
    const f = setup();
    expect(() => f.invoke('action', { ...f.event, sender: {} }, 'open')).toThrow('Origem');
    expect(() =>
      f.invoke('action', { ...f.event, senderFrame: { parent: {}, url: f.win.url } }, 'open'),
    ).toThrow('Origem');
    expect(() =>
      f.invoke(
        'action',
        { ...f.event, senderFrame: { parent: null, url: 'http://localhost:5173/index.html' } },
        'open',
      ),
    ).toThrow('Origem');
    expect(() => f.invoke('action', f.event, { toString: () => 'open' })).toThrow('Ação inválida');
    expect(f.open).not.toHaveBeenCalled();
    f.invoke('action', f.event, 'open');
    expect(f.open).toHaveBeenCalledExactlyOnceWith('first');
    expect(f.win.hide).toHaveBeenCalledOnce();
    f.surface.dispose();
  });
  it('denies permissions/popups and isolates Node from its renderer', () => {
    const f = setup();
    expect(f.win.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'solline-attention-isolated',
    });
    const grant = vi.fn();
    f.win.webContents.session.setPermissionRequestHandler.mock.calls[0]?.[0]({}, 'camera', grant);
    expect(grant).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.win.webContents.session.setPermissionCheckHandler.mock.calls[0]?.[0]()).toBe(false);
    expect(f.win.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' });
    f.surface.dispose();
  });
  it('renews the deadline for a replacement notice and destroys its timer on disposal', () => {
    const f = setup();
    f.win.emit('ready-to-show');
    expect(f.win.showInactive).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(9000);
    f.surface.show({ sessionId: 'second', title: 'Codex', body: 'Turno acabado', urgent: false });
    vi.advanceTimersByTime(1000);
    expect(f.win.hide).not.toHaveBeenCalled();
    f.invoke('action', f.event, 'open');
    expect(f.open).toHaveBeenCalledExactlyOnceWith('second');
    f.surface.dispose();
    expect(f.win.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['dismissed', 'expired'] as const)(
    'does not resurrect a %s notice when initial loading finishes late',
    (kind) => {
      const f = setup();
      if (kind === 'dismissed') f.surface.hide();
      else vi.advanceTimersByTime(10000);
      f.win.emit('ready-to-show');
      expect(f.win.showInactive).not.toHaveBeenCalled();
      f.surface.dispose();
    },
  );
  it('waits for rendering when a second notice replaces the first during initial loading', () => {
    const f = setup();
    f.surface.show({ sessionId: 'second', title: 'Codex', body: 'Turno acabado', urgent: false });
    expect(f.win.showInactive).not.toHaveBeenCalled();
    expect(f.invoke('notice')).toMatchObject({ sessionId: 'second' });
    f.win.emit('ready-to-show');
    expect(f.win.showInactive).toHaveBeenCalledOnce();
    f.surface.dispose();
  });
  it('does not resurrect a disposed window when its pending ready callback arrives', () => {
    const f = setup();
    f.surface.dispose();
    f.win.emit('ready-to-show');
    expect(f.win.showInactive).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
