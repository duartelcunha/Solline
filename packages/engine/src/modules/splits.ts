import { detectChecks } from '../checks/detect.ts';
import type { KernelModule } from '../kernel/kernel.ts';
import { SplitManager } from '../races/split-manager.ts';
import { reviewPlan } from '../races/split-review.ts';
import {
  ENGINE_RUNTIME,
  RACE_MANAGER,
  RACE_REGISTRY,
  SESSION_MANAGER,
  SPLIT_MANAGER,
} from './tokens.ts';

export function splitsModule(): KernelModule {
  return {
    manifest: {
      id: 'splits',
      version: '1.0.0',
      dependsOn: ['sessions', 'races'],
      commands: [
        'split.begin',
        'split.planNow',
        'split.review',
        'split.integrate',
        'split.resolveNow',
        'split.continue',
        'split.stop',
        'race.bring',
        'race.closeNow',
      ],
      events: ['race.changed'],
      critical: true,
      toggleable: false,
    },
    init(ctx) {
      const rt = ctx.inject(ENGINE_RUNTIME);
      const sessions = ctx.inject(SESSION_MANAGER);
      const registry = ctx.inject(RACE_REGISTRY);
      const races = ctx.inject(RACE_MANAGER);
      const splits = new SplitManager({
        sessions,
        emit: rt.emitAll,
        registry,
        worktrees: rt.worktrees,
        ...(rt.worktrees
          ? {
              integration: {
                sessions,
                worktrees: rt.worktrees,
                reviewer: rt.reviewing.integration,
              },
            }
          : {}),
      });
      ctx.provide(SPLIT_MANAGER, splits);
      ctx.on('*', (event) => splits.observe(event));
      sessions.claimWorktrees(() => [...races.worktreePaths(), ...splits.worktreePaths()]);

      ctx.registerCommand('split.begin', async ({ cwd, trusted, checks, setup, ...request }) => {
        const specs = trusted ? (checks ?? (await detectChecks(cwd))) : [];
        return splits.begin({
          ...request,
          cwd,
          trusted,
          ...(checks !== undefined ? { checks } : {}),
          ...(setup !== undefined ? { setup } : {}),
          checkRefs: specs.filter((c) => c.enabled).map((c) => ({ id: c.id, label: c.label })),
        });
      });
      ctx.registerCommand('split.planNow', async (p) => {
        if (!rt.planner) throw new Error('O planeador não está disponível');
        const { plan, cost } = await rt.planner({
          cwd: p.cwd,
          request: p.text,
          checks: p.checks,
        });
        const checkIds = p.checks.map((c) => c.id);
        const review =
          plan.decision === 'split'
            ? reviewPlan(plan.parts, checkIds)
            : { sequential: [], dropped: [], hubs: [], costMultiplier: 1, warnings: [] };
        return { plan, review, cost };
      });
      ctx.registerCommand('split.review', async (p) => reviewPlan(p.parts, p.checkIds));
      ctx.registerCommand('split.integrate', (p) => splits.integrate(p.raceId));
      ctx.registerCommand('split.resolveNow', ({ raceId, cwd, trusted, checks, setup }) =>
        splits.resolve(raceId, {
          projectId: registry.get(raceId).projectId,
          cwd,
          trusted,
          ...(checks !== undefined ? { checks } : {}),
          ...(setup !== undefined ? { setup } : {}),
        }),
      );
      ctx.registerCommand('split.continue', (p) => splits.continueIntegration(p.raceId));
      ctx.registerCommand('split.stop', (p) => splits.stopLaunching(p.raceId));
      ctx.registerCommand('race.bring', (p) =>
        registry.get(p.raceId).kind === 'split'
          ? splits.bring(p.raceId)
          : races.bring(p.raceId),
      );
      ctx.registerCommand('race.closeNow', (p) =>
        registry.get(p.raceId).kind === 'split'
          ? splits.close(p.raceId, p.keep)
          : races.close(p.raceId, p.keep),
      );
    },
  };
}
