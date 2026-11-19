import { LoginManager } from '../agents/login.ts';
import { builtinRegistry, withFactories } from '../agents/registry.ts';
import { SECRET_NAME } from '../env.ts';
import type { KernelModule } from '../kernel/kernel.ts';
import { AGENT_REGISTRY, ENGINE_RUNTIME, LOGIN_MANAGER } from './tokens.ts';

export function agentsModule(): KernelModule {
  return {
    manifest: {
      id: 'agents',
      version: '1.0.0',
      dependsOn: ['recovery'],
      commands: [
        'agents.list',
        'agents.loginStart',
        'agents.loginCancel',
        'agents.keys',
        'agents.saveKeys',
        'agents.keyCandidates',
      ],
      events: ['agents.changed'],
      critical: true,
      toggleable: false,
    },
    init(ctx) {
      const rt = ctx.inject(ENGINE_RUNTIME);
      const { options, settings, env, emit } = rt;
      const base =
        options.registry ??
        builtinRegistry({
          claudeExecutable: options.claudeExecutable,
          isolated: options.isolated,
          dataDir: options.dataDir,
          packaged: options.packaged,
        });
      const registry = options.adapters ? withFactories(base, options.adapters) : base;
      const logins = new LoginManager({
        onChange: (agent, error) => {
          if (!error && !logins.pending(agent)) ctx.circuits.reset(`adapter-start:${agent}`);
          emit({ kind: 'event', type: 'agents.changed', agent, ...(error ? { error } : {}) });
        },
      });
      ctx.provide(AGENT_REGISTRY, registry);
      ctx.provide(LOGIN_MANAGER, logins);

      const definitionOf = (id: string) => {
        const found = registry.get(id);
        if (!found) throw new Error(`Agente desconhecido: ${id}`);
        return found;
      };
      const configurable = (id: string) => {
        const definition = definitionOf(id);
        if (!definition.configurableKeys) throw new Error('Este agente não deixa escolher variáveis');
        return definition;
      };
      const ok = {} as Record<string, never>;

      ctx.registerCommand('agents.list', async (p) => ({
        agents: await Promise.all(
          registry.list().map(async (d) => {
            if (p.refresh) ctx.circuits.reset(`adapter-start:${d.id}`);
            return {
              id: d.id,
              label: d.label,
              transport: d.transport,
              experimental: d.experimental === true,
              untrustedProjects: d.untrustedProjects,
              mcp: d.mcp === true,
              ...(d.login ? { login: { label: d.login.label, pending: logins.pending(d.id) } } : {}),
              ...(d.configurableKeys ? { keys: await settings.keys(d.id) } : {}),
              ...(await d
                .detect({ refresh: p.refresh === true })
                .catch((error: unknown): { status: 'error'; detail: string } => ({
                  status: 'error',
                  detail: error instanceof Error ? error.message : String(error),
                }))),
            };
          }),
        ),
      }));
      ctx.registerCommand('agents.loginStart', async (p) => {
        const login = definitionOf(p.agent).login;
        if (!login) throw new Error('Este agente não tem login dentro da app');
        return { url: (await logins.start(p.agent, () => login.start())).url };
      });
      ctx.registerCommand('agents.loginCancel', async (p) => (await logins.cancel(p.agent), ok));
      ctx.registerCommand('agents.keys', async (p) => {
        const definition = configurable(p.agent);
        return { label: definition.label, keys: await settings.keys(p.agent) };
      });
      ctx.registerCommand('agents.saveKeys', async (p) => {
        configurable(p.agent);
        await settings.setKeys(p.agent, p.keys);
        emit({ kind: 'event', type: 'agents.changed', agent: p.agent });
        return ok;
      });
      ctx.registerCommand('agents.keyCandidates', async () => ({
        names: Object.keys(env)
          .filter((name) => SECRET_NAME.test(name) && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
          .sort(),
      }));
    },
  };
}
