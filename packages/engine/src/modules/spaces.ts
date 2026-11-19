import type { KernelModule } from '../kernel/kernel.ts';
import { SpaceManager } from '../spaces/manager.ts';
import {
  ANALYSIS_MANAGER,
  ENGINE_RUNTIME,
  MEMORY_SERVICE,
  SESSION_MANAGER,
  SPACES_MANAGER,
} from './tokens.ts';

export function spacesModule(): KernelModule {
  return {
    manifest: {
      id: 'spaces',
      version: '1.0.0',
      dependsOn: ['sessions', 'memory', 'rules'],
      commands: [
        'spaces.syncProjects',
        'spaces.snapshot',
        'spaces.taskCreate',
        'spaces.taskUpdate',
        'spaces.dispatch',
        'spaces.configure',
        'spaces.memorySave',
        'spaces.memoryDelete',
        'spaces.insightDecision',
        'session.unqueue',
        'session.closeNow',
      ],
      events: ['spaces.changed'],
      critical: true,
      toggleable: false,
    },
    init(ctx) {
      const rt = ctx.inject(ENGINE_RUNTIME);
      const sessions = ctx.inject(SESSION_MANAGER);
      const memory = ctx.inject(MEMORY_SERVICE);
      const spaces = new SpaceManager({
        save: (state) => rt.emitAll({ kind: 'event', type: 'spaces.changed', spaces: state }),
        create: async (start) => (await sessions.create(start)).session.id,
        send: (id, text, turnId) => sessions.send(id, text, 'queue', turnId),
        projectOf: (id) =>
          sessions.recovery().find((s) => s.view.session.id === id)?.view.session.projectId,
        view: (id) => sessions.recovery().find((s) => s.view.session.id === id)?.view,
        pending: (id, turnId) =>
          sessions
            .recovery()
            .some(
              (s) =>
                s.view.session.id === id && s.view.queue.items.some((item) => item.id === turnId),
            ),
      });
      ctx.provide(SPACES_MANAGER, spaces);
      ctx.on('*', (event) => spaces.observe(event));

      ctx.registerCommand('spaces.syncProjects', async (p) => {
        const before = JSON.stringify(spaces.projects());
        spaces.syncProjects(p.projects, p.generalCwd);
        if (before !== JSON.stringify(spaces.projects())) ctx.tryInject(ANALYSIS_MANAGER)?.cancel();
        return {};
      });
      ctx.registerCommand('spaces.snapshot', async () => {
        await memory.sweepIfDue();
        return spaces.snapshot();
      });
      ctx.registerCommand('spaces.taskCreate', async (p) => spaces.createTask(p));
      ctx.registerCommand('spaces.taskUpdate', async (p) => spaces.updateTask(p));
      ctx.registerCommand('spaces.dispatch', (p) => spaces.delegate(p, p.start));
      ctx.registerCommand('spaces.configure', async (p) => {
        ctx.tryInject(ANALYSIS_MANAGER)?.cancel();
        return spaces.configure(p);
      });
      ctx.registerCommand('spaces.memorySave', async (p) => {
        const before = p.id ? spaces.snapshot().memories.find((m) => m.id === p.id) : undefined;
        if (p.id && before && before.state !== 'active' && p.state === 'active') {
          spaces.saveMemory({ ...p, state: before.state });
          return memory.approve({ ids: [p.id] });
        }
        return spaces.saveMemory(p);
      });
      ctx.registerCommand('spaces.memoryDelete', async (p) => spaces.deleteMemory(p.id));
      ctx.registerCommand('spaces.insightDecision', async (p) =>
        spaces.decideInsight(p.id, p.decision),
      );
      ctx.registerCommand('session.unqueue', async (p) => {
        const removed = sessions.unqueue(p.sessionId, p.id);
        if (removed) spaces.removeQueued(p.sessionId, p.id);
        return { removed };
      });
      ctx.registerCommand('session.closeNow', async (p) => {
        spaces.capture(p.sessionId);
        const result = await sessions.close(p.sessionId, p.worktree, p.dropQueue);
        if (result.closed) spaces.sessionClosed(p.sessionId);
        return result;
      });
    },
  };
}
