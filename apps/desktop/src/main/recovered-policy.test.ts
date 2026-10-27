import { describe, expect, it, vi } from 'vitest';
import { EngineSnapshot, type Project } from '@solline/protocol';
import { reconcilePolicy } from './recovered-policy.ts';

const project: Project = {
  id: 'project',
  path: 'C:/code/app',
  name: 'app',
  addedAt: 0,
  trusted: false,
  checks: [{ id: 'check', label: 'Check', command: 'new-command', enabled: true }],
  setup: { command: 'new-setup', copyEnv: false },
};
function fixture(current: Project | undefined = project) {
  const snapshot = EngineSnapshot.parse({
    version: 1,
    epoch: 'restored',
    sequence: 10,
    operations: [],
    races: [],
    durability: { status: 'saved' },
    sessions: [
      {
        session: {
          id: 'session',
          projectId: 'project',
          agent: 'claude',
          cwd: project.path,
          title: 'Recovered',
          state: 'error',
          settings: { model: null, mode: null, effort: null },
          agentSessionId: 'provider-session',
        },
        capabilities: null,
        turns: [],
        usage: { costUsd: null, models: [], context: null, tokens: null },
        queue: { items: [], paused: true },
        timeline: null,
        quality: null,
        conflicts: null,
        checks: {
          trusted: true,
          specs: [{ id: 'check', label: 'Check', command: 'old-command', enabled: true }],
          detected: false,
          turnId: 'turn',
          results: [{ id: 'check', state: 'running', tail: null, durationMs: null }],
        },
        interrupted: true,
        error: 'Interrupted',
      },
    ],
  });
  const calls: { command: string; payload: unknown }[] = [];
  const request = vi.fn(async (command: string, payload: unknown) => {
    calls.push({ command, payload });
    if (command === 'engine.snapshot') return snapshot;
    if (command === 'worktrees.list') return { orphans: [{ id: 'orphan', projectId: 'project' }] };
    if (
      ['projects.trustChanged', 'projects.checksChanged', 'projects.setupChanged'].includes(command)
    )
      return {};
    throw new Error(`Unexpected request ${command}`);
  });
  const engine = { request: request as Parameters<typeof reconcilePolicy>[0]['request'] };
  const projects = { get: vi.fn(async (id: string) => (id === current?.id ? current : undefined)) };
  return { snapshot, calls, engine, projects };
}

describe('recovered project policy', () => {
  it.each([
    'checks.run',
    'setup.retry',
    'session.resume',
    'quality.review',
    'session.bring',
  ] as const)(
    '%s revokes stale saved trust and uses current commands before dispatch',
    async (command) => {
      const f = fixture();
      await reconcilePolicy(f.engine, f.projects, command, { sessionId: 'session' });
      expect(f.calls).toEqual([
        { command: 'engine.snapshot', payload: undefined },
        { command: 'projects.trustChanged', payload: { projectId: 'project', trusted: false } },
        {
          command: 'projects.checksChanged',
          payload: { projectId: 'project', checks: project.checks },
        },
        {
          command: 'projects.setupChanged',
          payload: { projectId: 'project', setup: project.setup },
        },
      ]);
    },
  );
  it('keeps active checks intact when their configured commands have not changed', async () => {
    const f = fixture();
    const saved = f.snapshot.sessions[0];
    if (!saved?.checks) throw new Error('Missing fixture checks');
    saved.checks.specs = project.checks ?? [];
    await reconcilePolicy(f.engine, f.projects, 'session.interrupt', { sessionId: 'session' });
    expect(f.calls.map((call) => call.command)).not.toContain('projects.checksChanged');
    expect(saved.checks.results[0]?.state).toBe('running');
  });
  it('revokes a removed project before refusing an effect', async () => {
    const f = fixture();
    f.projects.get.mockResolvedValue(undefined);
    await expect(
      reconcilePolicy(f.engine, f.projects, 'setup.retry', { sessionId: 'session' }),
    ).rejects.toThrow('histórico foi preservado');
    expect(f.calls.at(-1)).toEqual({
      command: 'projects.trustChanged',
      payload: { projectId: 'project', trusted: false },
    });
  });
  it.each(['engine.snapshot', 'checks.get', 'review.timeline'] as const)(
    'keeps %s readable without policy writes',
    async (command) => {
      const f = fixture();
      f.projects.get.mockResolvedValue(undefined);
      await reconcilePolicy(
        f.engine,
        f.projects,
        command,
        command === 'engine.snapshot' ? {} : { sessionId: 'session' },
      );
      expect(f.calls).toEqual([]);
      expect(f.projects.get).not.toHaveBeenCalled();
    },
  );
  it('keeps rules.list readable for a removed project, but rules effects need the project', async () => {
    const f = fixture();
    f.projects.get.mockResolvedValue(undefined);
    await reconcilePolicy(f.engine, f.projects, 'rules.list', { projectId: 'project' });
    expect(f.calls).toEqual([]);
    for (const command of ['rules.save', 'rules.delete', 'rules.import', 'rules.export'] as const) {
      const payload =
        command === 'rules.save'
          ? { projectId: 'project', title: 'A', text: 'b' }
          : command === 'rules.delete'
            ? { projectId: 'project', id: 'x' }
            : { projectId: 'project' };
      await expect(reconcilePolicy(f.engine, f.projects, command, payload)).rejects.toThrow(
        'histórico foi preservado',
      );
    }
  });
  it('resolves orphan scope from the engine rather than interpreting its id as a path', async () => {
    const f = fixture();
    await reconcilePolicy(f.engine, f.projects, 'worktrees.bring', { id: 'orphan' });
    expect(f.calls[0]?.command).toBe('worktrees.list');
    expect(f.projects.get).toHaveBeenCalledWith('project');
  });
  it('resolves direct project effects and refreshes policy on every request', async () => {
    const f = fixture();
    await reconcilePolicy(f.engine, f.projects, 'projects.setTrusted', {
      projectId: 'project',
      trusted: true,
    });
    f.projects.get.mockResolvedValue({ ...project, trusted: true, setup: null });
    await reconcilePolicy(f.engine, f.projects, 'setup.retry', { sessionId: 'session' });
    expect(f.calls.at(-1)).toEqual({
      command: 'projects.setupChanged',
      payload: { projectId: 'project', setup: null },
    });
    expect(
      f.calls
        .filter((call) => call.command === 'projects.trustChanged')
        .map((call) => call.payload),
    ).toEqual([
      { projectId: 'project', trusted: false },
      { projectId: 'project', trusted: true },
    ]);
  });
  it('rejects unknown session and extra forged trust before writing policy', async () => {
    const f = fixture();
    await expect(
      reconcilePolicy(f.engine, f.projects, 'checks.run', { sessionId: 'missing' }),
    ).rejects.toThrow('sessão');
    await expect(
      reconcilePolicy(f.engine, f.projects, 'checks.run', { sessionId: 'session', trusted: true }),
    ).rejects.toThrow();
    expect(f.calls.map((call) => call.command)).toEqual(['engine.snapshot']);
  });
  it('stops before effect dispatch when refreshing policy fails', async () => {
    const f = fixture();
    f.engine.request = vi.fn(async () => {
      throw new Error('disk unavailable');
    }) as typeof f.engine.request;
    await expect(
      reconcilePolicy(f.engine, f.projects, 'checks.run', { sessionId: 'session' }),
    ).rejects.toThrow('disk unavailable');
    expect(f.projects.get).not.toHaveBeenCalled();
  });
});
