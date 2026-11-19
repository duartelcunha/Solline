import type { KernelModule } from '../kernel/kernel.ts';
import { MCP_CATALOG, findNode } from '../mcp/catalog.ts';
import { UserMcpCatalog, combinedCatalog } from '../mcp/user-catalog.ts';
import { COMBINED_MCP, ENGINE_RUNTIME, USER_MCP } from './tokens.ts';

export function mcpModule(): KernelModule {
  return {
    manifest: {
      id: 'mcp',
      version: '1.0.0',
      dependsOn: ['recovery'],
      commands: [
        'mcp.list',
        'mcp.catalog',
        'mcp.search',
        'mcp.setProject',
        'mcp.probe',
        'mcp.draft',
        'mcp.get',
        'mcp.addNow',
        'mcp.updateNow',
        'mcp.approveNow',
        'mcp.removeNow',
      ],
      events: ['mcp.changed'],
      critical: true,
      toggleable: false,
    },
    init(ctx) {
      const rt = ctx.inject(ENGINE_RUNTIME);
      const { options, builtinMcp, emitAll } = rt;
      const userMcp = new UserMcpCatalog({
        dataDir: options.dataDir,
        secrets: options.mcpSecrets,
        node: () => findNode(),
        reserved: () => (options.mcp ? [] : MCP_CATALOG.map((e) => e.name)),
        builtinIds: async () => (await builtinMcp.list()).map((d) => d.id),
        onChange: (state) => emitAll({ kind: 'event', type: 'mcp.changed', mcp: state }),
        circuits: ctx.circuits,
        ...options.mcpUser,
      });
      const combined = combinedCatalog(builtinMcp, userMcp);
      ctx.provide(USER_MCP, userMcp);
      ctx.provide(COMBINED_MCP, combined);

      ctx.registerCommand('mcp.list', async () => ({ servers: await combined.list() }));
      ctx.registerCommand('mcp.catalog', async () => userMcp.state());
      ctx.registerCommand('mcp.search', async (p) => userMcp.search(p.query, p.cursor));
      ctx.registerCommand('mcp.setProject', async (p) =>
        userMcp.setProject(p.projectId, p.serverIds),
      );
      ctx.registerCommand('mcp.probe', async (p) => ({ server: await userMcp.probe(p.id) }));
      ctx.registerCommand('mcp.draft', async (p) => ({ spec: await userMcp.draft(p.source) }));
      ctx.registerCommand('mcp.get', async (p) => ({ server: userMcp.get(p.id) }));
      ctx.registerCommand('mcp.addNow', async (p) => ({ server: userMcp.add(p.id, p.spec) }));
      ctx.registerCommand('mcp.updateNow', async (p) => ({ server: userMcp.update(p.id, p.spec) }));
      ctx.registerCommand('mcp.approveNow', async (p) =>
        userMcp.approve(p.id, { fingerprint: p.fingerprint, toolsHash: p.toolsHash }),
      );
      ctx.registerCommand('mcp.removeNow', async (p) => ({ removed: userMcp.remove(p.id) }));
    },
  };
}
