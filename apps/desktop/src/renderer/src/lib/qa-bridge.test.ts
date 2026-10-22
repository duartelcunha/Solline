import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SollineApi } from '@solline/protocol/bridge';
import { installBridge } from '../../../../qa/bridge';

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('window', {});
});
afterEach(() => vi.unstubAllGlobals());

const api = (): SollineApi => window.solline;

async function create() {
  const { projects } = await api().request('projects.list', {});
  const project = projects[0];
  if (!project) throw new Error('Expected fixture project');
  return api().request('session.create', { projectId: project.id, agent: 'claude' });
}

describe('strict QA recovery bridge', () => {
  it('restores the canonical transcript, draft, and event sequence after renderer reload', async () => {
    installBridge('conversation');
    const { session } = await create();
    await api().recovery.saveDraft({
      sessionId: session.id,
      text: 'draft',
      pendingSend: 'uncertain',
    });
    const before = await api().request('engine.snapshot', {});
    expect(before.sessions[0]?.turns).toHaveLength(2);
    expect(before.sequence).toBeGreaterThan(0);
    installBridge('conversation');
    expect(await api().request('engine.snapshot', {})).toEqual(before);
    expect((await api().recovery.ui()).drafts[session.id]).toEqual({
      text: 'draft',
      pendingSend: 'uncertain',
    });
    const events: unknown[] = [];
    api().onEvent((event) => events.push(event));
    await api().request('session.interrupt', { sessionId: session.id });
    expect(events.at(-1)).toMatchObject({ sequence: before.sequence + 2, epoch: before.epoch });
  });

  it('maximizes with monotonic state and waits for drafts before closing', async () => {
    const qa = installBridge('conversation');
    const { session } = await create();
    const states: unknown[] = [];
    api().window.onState((state) => states.push(state));
    await api().window.action('toggle-maximize');
    expect(states).toEqual([{ maximized: true, customControls: true, revision: 1 }]);
    qa.hold('recovery.saveDraft');
    api().window.onPrepareClose(() =>
      api()
        .recovery.saveDraft({ sessionId: session.id, text: 'last edit', pendingSend: null })
        .then(() => undefined),
    );
    await api().window.action('close');
    expect(qa.windowState().closed).toBe(false);
    const close = qa.confirmClose();
    await Promise.resolve();
    expect(qa.windowState().closed).toBe(false);
    qa.release('recovery.saveDraft');
    await close;
    expect(qa.windowState().closed).toBe(true);
    expect((await api().recovery.ui()).drafts[session.id]?.text).toBe('last edit');
    expect(qa.journal.at(-1)).toMatchObject({ name: 'engine.flush' });
  });

  it('rejects unsupported inputs and does not close after a failed flush', async () => {
    const qa = installBridge('conversation');
    await expect(api().window.action('destroy' as 'close')).rejects.toThrow();
    await expect(
      api().recovery.saveDraft({ sessionId: 'absent', text: 'draft', pendingSend: null }),
    ).rejects.toThrow('QA:');
    qa.fail('engine.flush');
    const cancelled = vi.fn();
    api().window.onCloseCancelled(cancelled);
    await api().window.action('close');
    await expect(qa.confirmClose()).rejects.toThrow('Falha simulada');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(qa.windowState().closed).toBe(false);
  });
});
