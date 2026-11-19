import type { KernelModule } from '../kernel/kernel.ts';
import { RulesManager } from '../rules/manager.ts';
import { ENGINE_RUNTIME, RULES_MANAGER } from './tokens.ts';

export function rulesModule(): KernelModule {
  return {
    manifest: {
      id: 'rules',
      version: '1.0.0',
      dependsOn: ['recovery'],
      commands: ['rules.list', 'rules.save', 'rules.delete', 'rules.undo', 'rules.preview'],
      events: ['rules.changed'],
      critical: true,
      toggleable: false,
    },
    init(ctx) {
      const rt = ctx.inject(ENGINE_RUNTIME);
      const rules = new RulesManager({
        save: (state) => rt.emitAll({ kind: 'event', type: 'rules.changed', rules: state }),
      });
      ctx.provide(RULES_MANAGER, rules);

      ctx.registerCommand('rules.list', async (p) => rules.view(p.projectId));
      ctx.registerCommand('rules.save', async (p) => rules.save(p));
      ctx.registerCommand('rules.delete', async (p) => rules.delete(p.projectId, p.id));
      ctx.registerCommand('rules.undo', async (p) => rules.undo(p.projectId));
      ctx.registerCommand('rules.preview', async (p) => rules.preview(p.projectId));
    },
  };
}
