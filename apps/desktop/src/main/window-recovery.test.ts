import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { IPC } from '@solline/protocol/bridge';
import { WindowRecovery } from './window-recovery';
import type { EngineHost } from './engine-host';
import type { UiRecoveryStore } from './ui-recovery';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: vi.fn() }));

function setup(retryStartup?: () => Promise<void>) {
  const request = vi.fn(async (_command: string): Promise<unknown> => ({}));
  const engine = { running: true, request };
  const drafts = { flush: vi.fn(async () => {}) };
  const contents = Object.assign(new EventEmitter(), {
    isCrashed: () => false,
    isDestroyed: () => false,
    send: vi.fn(),
    reload: vi.fn(),
  });
  const win = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    close: vi.fn(),
  });
  const recovery = new WindowRecovery(
    engine as unknown as EngineHost,
    drafts as unknown as UiRecoveryStore,
    'preload',
    'renderer',
    undefined,
    retryStartup,
  );
  const show = vi.spyOn(recovery, 'show').mockImplementation(() => {});
  recovery.attach(win as unknown as BrowserWindow);
  const acknowledge = () => {
    const token = contents.send.mock.calls.find(
      ([channel]) => channel === IPC.prepareClose,
    )?.[1] as string | undefined;
    if (!token) throw new Error('Missing prepare token');
    recovery.prepared(token, true);
  };
  return { recovery, request, drafts, contents, win, show, acknowledge };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

it('monitors only a loaded visible renderer, suspends across navigation and disposes on close', () => {
  vi.useFakeTimers();
  const { recovery, contents, win, show } = setup();
  expect(contents.send).not.toHaveBeenCalled();
  contents.emit('did-finish-load');
  const probe = () =>
    contents.send.mock.calls.filter(([channel]) => channel === IPC.healthProbe).at(-1)?.[1];
  expect(probe()).toEqual(expect.any(String));
  recovery.healthy(probe());
  win.emit('hide');
  vi.advanceTimersByTime(20_000);
  expect(show).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  win.emit('show');
  vi.advanceTimersByTime(8000);
  expect(show).toHaveBeenCalledWith('unresponsive', expect.any(String));
  contents.emit('unresponsive');
  expect(show).toHaveBeenCalledTimes(1);
  recovery.healthy(probe());
  contents.emit('did-start-navigation', {}, 'file:///index.html', false, true);
  win.emit('show');
  expect(vi.getTimerCount()).toBe(0);
  contents.emit('did-finish-load');
  expect(vi.getTimerCount()).toBe(1);
  win.emit('closed');
  expect(vi.getTimerCount()).toBe(0);
});

describe('window close acknowledgement barrier', () => {
  it('retries failed startup before asking a responsive renderer to save, without reloading until acknowledged', async () => {
    let ready = false;
    const retry = vi.fn(async () => {
      ready = true;
    });
    retry.mockRejectedValueOnce(new Error('vault still unavailable'));
    const { recovery, contents, acknowledge, request } = setup(retry);
    await expect(recovery.restore()).rejects.toThrow('vault still unavailable');
    expect(contents.send).not.toHaveBeenCalled();
    expect(contents.reload).not.toHaveBeenCalled();
    const second = recovery.restore();
    await vi.waitFor(() =>
      expect(contents.send).toHaveBeenCalledWith(IPC.prepareClose, expect.any(String)),
    );
    expect(ready).toBe(true);
    expect(contents.reload).not.toHaveBeenCalled();
    acknowledge();
    await second;
    expect(request).toHaveBeenCalledWith('engine.flush');
    expect(contents.reload).toHaveBeenCalledOnce();
  });
  it('always warns before flushing, including an idle window', async () => {
    const { recovery, request, drafts, contents, show } = setup();
    await recovery.close();
    await recovery.close();
    expect(show).toHaveBeenCalledWith('close', expect.any(String));
    expect(contents.send).not.toHaveBeenCalled();
    expect(drafts.flush).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('waits for the renderer and engine, deduplicating repeated close requests', async () => {
    const { recovery, request, win, acknowledge, contents } = setup();
    let release: () => void = () => {};
    request.mockImplementation(async (command) => {
      if (command === 'engine.flush')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return {};
    });
    const close = recovery.close(true);
    const repeated = recovery.close(true);
    expect(win.close).not.toHaveBeenCalled();
    acknowledge();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('engine.flush'));
    expect(win.close).not.toHaveBeenCalled();
    expect(
      contents.send.mock.calls.filter(([channel]) => channel === IPC.prepareClose),
    ).toHaveLength(1);
    release();
    await Promise.all([close, repeated]);
    expect(win.close).toHaveBeenCalledOnce();
    expect(recovery.mayQuit).toBe(true);
  });

  it('thaws the renderer and blocks closing when persistence fails', async () => {
    const { recovery, request, win, acknowledge, contents } = setup();
    request.mockRejectedValue(new Error('disk failed'));
    const close = recovery.close(true);
    acknowledge();
    await expect(close).rejects.toThrow('disk failed');
    expect(contents.send).toHaveBeenCalledWith(IPC.closeCancelled);
    expect(win.close).not.toHaveBeenCalled();
    expect(recovery.mayQuit).toBe(false);
  });

  it('rejects the pending handshake when the window disappears', async () => {
    const { recovery, win, request } = setup();
    const close = recovery.close(true);
    win.emit('closed');
    await expect(close).rejects.toThrow('gravação dos rascunhos');
    expect(request).not.toHaveBeenCalled();
    expect(recovery.mayQuit).toBe(false);
  });
});
