import type { KernelModule } from '../kernel/kernel.ts';
import { MemoryService } from '../memory/manager.ts';
import { MEMORY_SERVICE, RULES_MANAGER, SESSION_MANAGER, SPACES_MANAGER } from './tokens.ts';

export function memoryModule(): KernelModule {
  return {
    manifest: {
      id: 'memory',
      version: '1.0.0',
      dependsOn: ['rules'],
      commands: ['memory.approve', 'memory.reject', 'memory.confirm', 'memory.toRule'],
      events: [],
      critical: true,
      toggleable: false,
    },
    init(ctx) {
      const rules = ctx.inject(RULES_MANAGER);
      const spaces = () => ctx.inject(SPACES_MANAGER);
      const memory = new MemoryService({
        store: {
          snapshot: () => spaces().snapshot(),
          change: (update) => spaces().change(update),
          root: (projectId) => spaces().projectPath(projectId),
        },
        rules,
        onMemoryUsed: (sessionId, ids) =>
          ctx.tryInject(SESSION_MANAGER)?.recordMemoryUsed(sessionId, ids),
      });
      ctx.provide(MEMORY_SERVICE, memory);

      ctx.registerCommand('memory.approve', async (p) => memory.approve(p));
      ctx.registerCommand('memory.reject', async (p) => spaces().deleteMemories(p.ids));
      ctx.registerCommand('memory.confirm', async (p) => memory.confirm(p.ids));
      ctx.registerCommand('memory.toRule', async (p) => memory.toRule(p));
    },
  };
}
