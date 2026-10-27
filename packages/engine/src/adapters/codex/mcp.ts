import { BRAIN_SERVER_NAME, brainToolLabel } from '../../brain/tool.ts';
import type { BrokerOutcome } from '../../permission-broker.ts';
import type { McpServerLaunch } from '../types.ts';
import type { JsonValue } from './protocol/serde_json/JsonValue';
import type { McpServerElicitationRequestParams } from './protocol/v2/McpServerElicitationRequestParams';
import type { McpServerElicitationRequestResponse } from './protocol/v2/McpServerElicitationRequestResponse';

/** Nomes que cabem numa chave da config do Codex sem partir o caminho (mcp_servers.<nome>). */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Os servidores MCP desta sessão como overrides da config do thread (o mesmo que
 * `-c mcp_servers.<nome>=…` no CLI). Nunca se escreve no config.toml. Todas as ferramentas
 * pedem autorização (default_tools_approval_mode = prompt), que chega como elicitação.
 */
export function mcpServersConfig(
  servers: readonly McpServerLaunch[],
): Record<string, JsonValue> | undefined {
  if (servers.length === 0) return undefined;
  const config: Record<string, JsonValue> = {};
  for (const server of servers) {
    if (!SERVER_NAME.test(server.name)) {
      throw new Error(`Nome de servidor MCP inválido para o Codex: ${server.name}`);
    }
    config[`mcp_servers.${server.name}`] = {
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
      startup_timeout_sec: 30,
      ...(server.toolTimeoutSec ? { tool_timeout_sec: server.toolTimeoutSec } : {}),
      default_tools_approval_mode: 'prompt',
      // As ferramentas só de leitura da Solline correm sem pedir; as outras pedem como as de todos.
      ...(server.autoApprove?.length
        ? {
            tools: Object.fromEntries(
              server.autoApprove.map((tool) => [tool, { approval_mode: 'approve' }]),
            ),
          }
        : {}),
    };
  }
  return config;
}

/** Um pedido de autorização para correr uma ferramenta MCP, tirado de uma elicitação. */
export interface McpToolApproval {
  server: string;
  tool: string;
  title: string;
  description?: string;
  input: Record<string, unknown>;
  /** Até onde o Codex aceita lembrar a resposta ("session", "always"). */
  persist: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * O Codex pede autorização às ferramentas MCP por elicitação, com
 * `_meta.codex_approval_kind = "mcp_tool_call"` e um formulário vazio. Outras elicitações
 * (formulários a sério, URLs) devolvem null.
 */
export function mcpToolApproval(params: McpServerElicitationRequestParams): McpToolApproval | null {
  if (params.mode !== 'form') return null;
  const meta = asRecord(params._meta);
  if (!meta || meta.codex_approval_kind !== 'mcp_tool_call') return null;
  const schema = asRecord(params.requestedSchema);
  if (schema && Object.keys(asRecord(schema.properties) ?? {}).length > 0) return null;
  const tool = typeof meta.tool_name === 'string' && meta.tool_name ? meta.tool_name : null;
  const title =
    typeof meta.tool_title === 'string' && meta.tool_title ? meta.tool_title : (tool ?? null);
  const raw = meta.persist;
  const persist = (Array.isArray(raw) ? raw : [raw]).filter(
    (p): p is string => typeof p === 'string',
  );
  const description =
    typeof meta.tool_description === 'string' && meta.tool_description
      ? meta.tool_description
      : params.message || undefined;
  return {
    server: params.serverName,
    tool: tool ?? 'ferramenta',
    title:
      params.serverName === BRAIN_SERVER_NAME
        ? brainToolLabel(title ?? tool ?? 'ferramenta')
        : `${params.serverName}: ${title ?? 'ferramenta'}`,
    ...(description ? { description } : {}),
    input: asRecord(meta.tool_params) ?? {},
    persist,
  };
}

/** A resposta à elicitação; "Permitir sempre" é só nesta sessão (persist: session). */
export function mcpApprovalResponse(outcome: BrokerOutcome): McpServerElicitationRequestResponse {
  switch (outcome.decision) {
    case 'allow-once':
      return { action: 'accept', content: {}, _meta: null };
    case 'allow-always':
      return { action: 'accept', content: {}, _meta: { persist: 'session' } };
    case 'cancelled':
      return { action: 'cancel', content: null, _meta: null };
    default:
      return { action: 'decline', content: null, _meta: null };
  }
}
