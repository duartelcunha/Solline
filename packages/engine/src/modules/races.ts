import type { KernelModule } from '../kernel/kernel.ts';
import { Assembler } from '../races/assembler.ts';
import { RaceManager } from '../races/race-manager.ts';
import { RaceRegistry } from '../races/race-registry.ts';
import { claudeJudge } from '../verify/judge.ts';
import { ENGINE_RUNTIME, RACE_MANAGER, RACE_REGISTRY, SESSION_MANAGER } from './tokens.ts';

export function racesModule(): KernelModule {
  return {
    manifest: {
      id: 'races',
      version: '1.0.0',
      dependsOn: ['sessions'],
      commands: ['race.begin', 'race.get', 'race.proposal', 'race.assemble'],
      events: ['race.changed'],
      critical: true,
      toggleable: false,
    },
    init(ctx) {
      const rt = ctx.inject(ENGINE_RUNTIME);
      const sessions = ctx.inject(SESSION_MANAGER);
      const registry = new RaceRegistry(rt.emitAll);
      const races = new RaceManager({
        beforeEffect: (command, raceId) => rt.beforeEffect(command, { raceId }),
        sessions,
        emit: rt.emitAll,
        registry,
        ...(rt.worktrees ? { assembler: new Assembler({ worktrees: rt.worktrees }) } : {}),
        ...(rt.options.isolated || rt.options.reviewer === false
          ? {}
          : { judge: claudeJudge({ claudeExecutable: rt.options.claudeExecutable }) }),
      });
      ctx.provide(RACE_REGISTRY, registry);
      ctx.provide(RACE_MANAGER, races);
      ctx.on('*', (event) => races.observe(event));

      ctx.registerCommand('race.begin', (p) => races.begin(p));
      ctx.registerCommand('race.get', async (p) => registry.get(p.raceId));
      ctx.registerCommand('race.proposal', (p) => races.proposal(p.raceId));
      ctx.registerCommand('race.assemble', (p) => races.assemble(p.raceId, p.picks));
    },
  };
}
