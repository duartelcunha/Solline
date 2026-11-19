import type { KernelModule } from '../kernel/kernel.ts';
import { ENGINE_VERSION } from '../version.ts';
import { CONSULT_MANAGER, ENGINE_RUNTIME, type EngineRuntime } from './tokens.ts';

export function recoveryModule(runtime: EngineRuntime): KernelModule {
  return {
    manifest: {
      id: 'recovery',
      version: '1.0.0',
      dependsOn: [],
      commands: [
        'engine.snapshot',
        'engine.flush',
        'engine.shutdown',
        'engine.ping',
        'engine.health',
        'engine.moduleToggle',
      ],
      events: ['engine.error'],
      critical: true,
      toggleable: false,
    },
    init(ctx) {
      ctx.provide(ENGINE_RUNTIME, runtime);
      ctx.registerCommand('engine.snapshot', async () => {
        // Os pedidos de consulta à espera só vão a quem liga agora; nunca para o diário.
        const consults = ctx.tryInject(CONSULT_MANAGER)?.pending() ?? [];
        return { ...runtime.snapshot(), ...(consults.length ? { consults } : {}) };
      });
      ctx.registerCommand('engine.flush', async () => {
        await runtime.flush();
        return {};
      });
      ctx.registerCommand('engine.shutdown', async () => {
        await runtime.shutdown();
        return {};
      });
      ctx.registerCommand('engine.ping', async () => ({
        pong: true,
        engineVersion: ENGINE_VERSION,
        pid: process.pid,
        receivedAt: Date.now(),
      }));
      ctx.registerCommand('engine.health', async () => runtime.health());
      ctx.registerCommand('engine.moduleToggle', async (p) =>
        runtime.toggleModule(p.id, p.enabled),
      );
    },
  };
}
