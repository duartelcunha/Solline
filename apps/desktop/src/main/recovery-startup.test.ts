import { describe, expect, it, vi } from 'vitest';
import type { EngineHost } from './engine-host';
import { RecoveryStartup } from './recovery-startup';

function fixture() {
  const state = {
    version: 1 as const,
    revision: 7,
    drafts: { saved: { text: 'exact saved text', pendingSend: null } },
  };
  const drafts = { load: vi.fn(async () => state), retry: vi.fn(async () => state) };
  const engine = {
    running: false,
    failedToStart: false,
    start: vi.fn(() => {
      engine.running = true;
    }),
    restartFailed: vi.fn(async () => {
      engine.failedToStart = false;
    }),
    restartStopped: vi.fn(async () => {}),
    request: vi.fn(async () => ({ lifecycle: 'running' })),
  };
  const loadKey = vi.fn(async () => Buffer.alloc(32, 3));
  const startup = new RecoveryStartup(drafts, engine as unknown as EngineHost, loadKey);
  return { startup, drafts, engine, loadKey, state };
}

describe('explicit recovery startup retry', () => {
  it('holds a failed vault initialization until explicit retry and then starts with a protected key', async () => {
    const f = fixture();
    f.loadKey.mockRejectedValueOnce(new Error('vault unavailable'));
    await expect(f.startup.ready()).rejects.toThrow('vault unavailable');
    await expect(f.startup.ready()).rejects.toThrow('vault unavailable');
    expect(f.loadKey).toHaveBeenCalledTimes(1);
    expect(f.engine.start).not.toHaveBeenCalled();
    await f.startup.retry();
    await f.startup.ready();
    expect(f.loadKey).toHaveBeenCalledTimes(2);
    expect(f.drafts.retry).toHaveBeenCalledOnce();
    expect(f.engine.start).toHaveBeenCalledOnce();
    expect(f.state.drafts.saved.text).toBe('exact saved text');
  });
  it('replaces failed draft readiness only after an explicit successful disk retry', async () => {
    const f = fixture();
    f.drafts.load.mockRejectedValueOnce(new Error('temporarily unreadable'));
    await expect(f.startup.ready()).rejects.toThrow('temporarily unreadable');
    expect(f.loadKey).toHaveBeenCalledOnce();
    f.drafts.retry.mockRejectedValueOnce(new Error('still unreadable'));
    await expect(f.startup.retry()).rejects.toThrow('still unreadable');
    await expect(f.startup.ready()).rejects.toThrow('still unreadable');
    expect(f.engine.start).not.toHaveBeenCalled();
    await f.startup.retry();
    await expect(f.startup.ready()).resolves.toBeUndefined();
    expect(f.engine.start).toHaveBeenCalledOnce();
  });
  it('does not restart an engine still settling accepted operations', async () => {
    const f = fixture();
    f.engine.running = true;
    f.engine.request.mockResolvedValue({ lifecycle: 'stopping' });
    await expect(f.startup.retry()).rejects.toThrow('ainda está a guardar');
    expect(f.engine.start).not.toHaveBeenCalled();
    expect(f.engine.restartStopped).not.toHaveBeenCalled();
    expect(f.engine.restartFailed).not.toHaveBeenCalled();
  });
  it('restarts a confirmed stopped engine and validates the new runtime before allowing the UI', async () => {
    const f = fixture();
    f.engine.running = true;
    f.engine.request
      .mockResolvedValueOnce({ lifecycle: 'stopped' })
      .mockResolvedValueOnce({ lifecycle: 'running' });
    await f.startup.retry();
    expect(f.engine.restartStopped).toHaveBeenCalledOnce();
    expect(f.engine.start).not.toHaveBeenCalled();
    expect(f.engine.request).toHaveBeenCalledTimes(2);
  });
  it('shares concurrent explicit retry attempts instead of spawning duplicate engines', async () => {
    const f = fixture();
    await Promise.all([f.startup.retry(), f.startup.retry()]);
    expect(f.loadKey).toHaveBeenCalledOnce();
    expect(f.engine.start).toHaveBeenCalledOnce();
  });
});
