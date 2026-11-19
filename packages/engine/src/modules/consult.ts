import { ConsultManager } from '../consult/manager.ts';
import type { KernelModule } from '../kernel/kernel.ts';
import {
  AGENT_REGISTRY,
  CONSULT_MANAGER,
  ENGINE_RUNTIME,
  SESSION_MANAGER,
} from './tokens.ts';

export function consultModule(): KernelModule {
  return {
    manifest: {
      id: 'consult',
      version: '1.0.0',
      dependsOn: ['agents'],
      commands: ['consult.answer'],
      events: ['consult.request', 'consult.resolved'],
      critical: false,
      toggleable: true,
    },
    init(ctx) {
      const rt = ctx.inject(ENGINE_RUNTIME);
      const registry = ctx.inject(AGENT_REGISTRY);
      const existing = ctx.tryInject(CONSULT_MANAGER);
      const consult =
        existing ?? new ConsultManager({ emit: rt.emitAll, registry, worktrees: rt.worktrees });
      if (!existing) ctx.provide(CONSULT_MANAGER, consult);
      const sessions = ctx.tryInject(SESSION_MANAGER);
      if (sessions) consult.attach(sessions);
      ctx.on('*', (event) => consult.observe(event));
      const ok = {} as Record<string, never>;
      ctx.registerCommand('consult.answer', async (p) => (
        consult.answer(p.sessionId, p.requestId, p.decision),
        ok
      ));
    },
    dispose(ctx) {
      ctx.tryInject(CONSULT_MANAGER)?.stop();
    },
  };
}
