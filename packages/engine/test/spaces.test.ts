import { describe, expect, it } from 'vitest';
import { emptySpaces } from '@solline/protocol';
import { SpaceManager } from '../src/spaces/manager.ts';

function setup() {
  const saved: unknown[] = [];
  const sends: string[] = [];
  const starts: unknown[] = [];
  let fail = false;
  const manager = new SpaceManager({
    save: (state) => {
      if (fail) throw new Error('disco cheio');
      saved.push(structuredClone(state));
    },
    create: async (start) => {
      starts.push(start);
      return 'session';
    },
    send: async (_id, text, turnId) => {
      sends.push(text);
      return { turnId, how: 'queued' };
    },
    projectOf: () => 'p',
  });
  manager.syncProjects(
    [{ id: 'p', path: '/project', name: 'Projeto', trusted: true, addedAt: 0 }],
    '/general',
  );
  return {
    manager,
    saved,
    sends,
    starts,
    fail: () => {
      fail = true;
    },
  };
}

describe('espaços e delegação', () => {
  it('captura uma tarefa sem arrancar agentes e recusa projetos desconhecidos', () => {
    const { manager, sends } = setup();
    expect(
      manager.createTask({ projectId: null, title: 'Uma ideia', description: '' }).status,
    ).toBe('todo');
    expect(sends).toEqual([]);
    expect(() =>
      manager.createTask({ projectId: 'outro', title: 'Não', description: '' }),
    ).toThrow();
  });
  it('não confirma alterações que falharam na gravação', () => {
    const { manager, fail } = setup();
    fail();
    expect(() =>
      manager.createTask({ projectId: null, title: 'Guardar', description: '' }),
    ).toThrow('disco cheio');
    expect(manager.snapshot().tasks).toEqual([]);
  });
  it('liga a tarefa ao seu turno, sem confundir outros turnos da mesma conversa', async () => {
    const { manager, sends } = setup();
    const task = manager.createTask({ projectId: 'p', title: 'Arranjar', description: '' });
    const input = {
      id: task.id,
      requestId: crypto.randomUUID(),
      target: { kind: 'existing' as const, sessionId: 'session' },
      text: 'Arranjar',
      memoryIds: [],
    };
    const queued = await manager.delegate(input);
    const attempt = queued.attempts[0]!;
    manager.observe({
      kind: 'event',
      type: 'session.event',
      sessionId: 'session',
      delta: { type: 'turn.start', turn: { id: 'anterior', role: 'user', blocks: [] } },
    });
    manager.observe({
      kind: 'event',
      type: 'session.event',
      sessionId: 'session',
      delta: { type: 'turn.end', turnId: 'resposta-anterior', outcome: 'done' },
    });
    expect(manager.snapshot().tasks[0]?.status).toBe('active');
    manager.observe({
      kind: 'event',
      type: 'session.event',
      sessionId: 'session',
      delta: { type: 'turn.start', turn: { id: attempt.turnId, role: 'user', blocks: [] } },
    });
    manager.observe({
      kind: 'event',
      type: 'session.event',
      sessionId: 'session',
      delta: { type: 'turn.end', turnId: 'resposta', outcome: 'done' },
    });
    expect(manager.snapshot().tasks[0]?.status).toBe('review');
    await expect(manager.delegate(input)).rejects.toThrow();
    expect(sends).toHaveLength(1);
  });
  it('a sessão aberta por uma delegação nasce com a origem da tarefa (só o id)', async () => {
    const { manager, starts } = setup();
    const task = manager.createTask({ projectId: 'p', title: 'Arranjar', description: '' });
    await manager.delegate(
      {
        id: task.id,
        requestId: crypto.randomUUID(),
        target: { kind: 'new', agent: 'claude' },
        text: 'Arranjar',
        memoryIds: [],
      },
      { projectId: 'p', cwd: '/project', trusted: true, agent: 'claude' },
    );
    expect(starts).toEqual([
      expect.objectContaining({ origin: { kind: 'task', taskId: task.id } }),
    ]);
    // Numa conversa que já existe, não se abre sessão nenhuma.
    const other = manager.createTask({ projectId: 'p', title: 'Outra', description: '' });
    await manager.delegate({
      id: other.id,
      requestId: crypto.randomUUID(),
      target: { kind: 'existing', sessionId: 'session' },
      text: 'Outra',
      memoryIds: [],
    });
    expect(starts).toHaveLength(1);
  });
  it('isola projetos e memórias, e só promove memórias por escolha explícita', async () => {
    const { manager, sends } = setup();
    const task = manager.createTask({ projectId: null, title: 'Ideia', description: '' });
    manager.saveMemory({
      projectId: 'p',
      text: 'Preferência privada',
      source: 'Duarte',
      sourceId: null,
      state: 'active',
    });
    const memory = manager.snapshot().memories[0]!;
    await expect(
      manager.delegate({
        id: task.id,
        requestId: crypto.randomUUID(),
        target: { kind: 'new', agent: 'claude' },
        text: 'Ideia',
        memoryIds: [memory.id],
      }),
    ).rejects.toThrow();
    expect(sends).toEqual([]);
  });
  it('restaura intenções incertas sem repetir envios', () => {
    const { manager, sends } = setup();
    const state = emptySpaces();
    state.analysis.state = 'running';
    state.tasks = [
      {
        id: 't',
        projectId: null,
        title: 'Ideia',
        description: '',
        status: 'active',
        sourceId: null,
        createdAt: 0,
        updatedAt: 0,
        attempts: [
          {
            id: crypto.randomUUID(),
            sessionId: 'session',
            turnId: 'turn',
            text: 'Ideia',
            state: 'running',
            at: 0,
            error: null,
          },
        ],
      },
    ];
    manager.restore(state);
    expect(manager.snapshot().tasks[0]?.attempts[0]?.state).toBe('unknown');
    expect(manager.snapshot().analysis.state).toBe('paused');
    expect(sends).toEqual([]);
  });
});
