import { Brain, sourceShimPath } from '../brain/brain.ts';
import { contextTool } from '../brain/tools/context.ts';
import { consultTools } from '../consult/tools.ts';
import type { KernelModule } from '../kernel/kernel.ts';
import { memoryTools } from '../memory/tools.ts';
import { rulesTools } from '../rules/tools.ts';
import {
  BRAIN_SERVICE,
  CONSULT_MANAGER,
  ENGINE_RUNTIME,
  MEMORY_SERVICE,
  RULES_MANAGER,
} from './tokens.ts';

export function brainModule(): KernelModule {
  return {
    manifest: {
      id: 'brain',
      version: '1.0.0',
      dependsOn: ['rules', 'memory', 'consult'],
      commands: [],
      events: [],
      critical: true,
      toggleable: false,
    },
    init(ctx) {
      const rt = ctx.inject(ENGINE_RUNTIME);
      const rules = ctx.inject(RULES_MANAGER);
      const memory = ctx.inject(MEMORY_SERVICE);
      const consult = ctx.tryInject(CONSULT_MANAGER);
      const brain = rt.options.brain
        ? new Brain({
            ...rt.options.brain,
            tools: rt.options.brain.tools ?? [
              contextTool,
              ...rulesTools(rules),
              ...memoryTools(memory),
              ...(consult ? consultTools(consult) : []),
            ],
            shim: rt.options.brain.shim ?? sourceShimPath(),
          })
        : undefined;
      ctx.provide(BRAIN_SERVICE, brain);
    },
    async dispose(ctx) {
      await ctx.tryInject(BRAIN_SERVICE)?.dispose();
    },
  };
}
