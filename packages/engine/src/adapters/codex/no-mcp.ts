import type { JsonRpcPeer } from '../../rpc/json-rpc.ts';
import type { JsonValue } from './protocol/serde_json/JsonValue';
import type { ConfigReadParams } from './protocol/v2/ConfigReadParams';
import type { ConfigReadResponse } from './protocol/v2/ConfigReadResponse';
import type { ListMcpServerStatusParams } from './protocol/v2/ListMcpServerStatusParams';
import type { ListMcpServerStatusResponse } from './protocol/v2/ListMcpServerStatusResponse';

/**
 * Um revisor não pode ter ferramentas MCP: o sandbox só de leitura não as limita, e um diff
 * com instruções escondidas podia levar o Codex a chamar uma. Os servidores do utilizador
 * (config.toml, camadas do projeto, plugins, apps) arrancam com a thread, por isso desligam-se
 * nos overrides do thread/start. Verificado no codex 0.163 (ver o relatório da fase 0 do M6):
 *  - `mcp_servers.<nome>.enabled = false` desliga os do config.toml e dos projetos, que o
 *    config/read lista;
 *  - os de plugins e de apps (codex_apps, cua_repl, plugins remotos) não aparecem no config/read
 *    e só caem com `features.plugins = false` e `features.apps = false`;
 *  - `-c mcp_servers={}` no arranque não desliga nada, e o app-server sem thread não lança MCP.
 */
const LIST_TIMEOUT_MS = 30_000;

export const MCP_ACTIVE_MESSAGE =
  'O Codex ia arrancar servidores MCP do utilizador, por isso a segunda opinião foi cancelada: um revisor nunca corre com ferramentas externas.';

const UNCONFIRMED_MESSAGE =
  'Não consegui confirmar que o Codex está sem servidores MCP, por isso a segunda opinião foi cancelada';

interface McpConfigShape {
  mcp_servers?: unknown;
}

/** Os nomes dos servidores MCP que a config do Codex vê a partir desta pasta. */
export async function configuredMcpServers(
  peer: JsonRpcPeer,
  cwd: string,
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<string[]> {
  const params: ConfigReadParams = { cwd };
  const response = await peer.request<ConfigReadResponse>('config/read', params, timeoutMs);
  const servers = (response.config as unknown as McpConfigShape).mcp_servers;
  return servers && typeof servers === 'object' && !Array.isArray(servers)
    ? Object.keys(servers)
    : [];
}

/**
 * Os overrides de config para um thread/start sem MCP. Os servidores vão num objeto (não em
 * chaves com pontos) para um nome com "." não partir o caminho.
 */
export function mcpOffConfig(servers: readonly string[]): Record<string, JsonValue> {
  const disabled: Record<string, JsonValue> = {};
  for (const name of servers) disabled[name] = { enabled: false };
  return {
    'features.plugins': false,
    'features.apps': false,
    ...(servers.length > 0 ? { mcp_servers: disabled } : {}),
  };
}

/** Os overrides, lendo antes a config da pasta. Falha (nunca "adivinha") se a config não abrir. */
export async function noMcpConfig(
  peer: JsonRpcPeer,
  cwd: string,
): Promise<Record<string, JsonValue>> {
  return mcpOffConfig(await configuredMcpServers(peer, cwd));
}

/** Só estes estados garantem que o servidor não está (nem esteve a ficar) a correr. */
const INERT = new Set(['disabled', 'cancelled']);

/**
 * Depois do thread/start: se algum servidor MCP não estiver desligado, a revisão aborta.
 * O estado desconhecido conta como ativo (falha fechada).
 */
export async function assertNoMcp(
  peer: JsonRpcPeer,
  threadId: string,
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<void> {
  const active: string[] = [];
  let cursor: string | null = null;
  do {
    const params: ListMcpServerStatusParams = {
      threadId,
      detail: 'toolsAndAuthOnly',
      ...(cursor ? { cursor } : {}),
    };
    const page: ListMcpServerStatusResponse = await peer
      .request<ListMcpServerStatusResponse>('mcpServerStatus/list', params, timeoutMs)
      .catch((error: unknown) => {
        throw new Error(`${UNCONFIRMED_MESSAGE}: ${String(error)}`, { cause: error });
      });
    for (const server of page.data) {
      if (!server.runtimeStatus || !INERT.has(server.runtimeStatus)) active.push(server.name);
    }
    cursor = page.nextCursor;
  } while (cursor);
  if (active.length > 0) throw new Error(`${MCP_ACTIVE_MESSAGE} (${active.join(', ')})`);
}
