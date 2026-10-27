import type {
  McpSdkServerConfigWithInstance,
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import type { BrainBinding } from './brain.ts';

/** As duas funções do SDK de que o servidor em processo precisa (o SDK só se carrega com import()). */
export interface ClaudeSdkMcp {
  createSdkMcpServer: typeof createSdkMcpServer;
  tool: typeof tool;
}

export interface ClaudeBrain {
  /** O servidor para o mapa mcpServers do SDK. */
  server: McpSdkServerConfigWithInstance;
  /** Os nomes (mcp__<servidor>__<ferramenta>) das só de leitura: correm sem pedir. As outras pedem. */
  allowedTools: string[];
}

/**
 * O cérebro como servidor MCP dentro do processo do motor (createSdkMcpServer), feito para esta
 * sessão. Cada chamada vai a binding.call, que já sabe de que sessão é.
 */
export function claudeBrain(sdk: ClaudeSdkMcp, binding: BrainBinding): ClaudeBrain {
  const tools = binding.tools.map((info) =>
    sdk.tool(
      info.name,
      info.description,
      info.input,
      async (args) => {
        const result = await binding.call(info.name, args);
        return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
      },
      { annotations: { readOnlyHint: info.readOnly } },
    ),
  );
  return {
    server: sdk.createSdkMcpServer({ name: binding.serverName, version: '0.1.0', tools }),
    allowedTools: binding.tools
      .filter((info) => info.readOnly)
      .map((info) => `mcp__${binding.serverName}__${info.name}`),
  };
}
