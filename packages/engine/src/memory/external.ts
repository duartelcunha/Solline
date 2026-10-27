import type { Block, ToolBlock, Turn } from '@solline/protocol';
import { BRAIN_SERVER_NAME } from '../brain/tool.ts';

/** Ferramentas que só mexem na pasta ou no próprio agente: não trazem texto de fora. */
const LOCAL = new Set(['read', 'edit', 'delete', 'move', 'search', 'think', 'switch_mode']);
/** Ferramentas sem categoria útil que sabemos serem locais. */
const LOCAL_NAMES = new Set([
  'TodoWrite',
  'ExitPlanMode',
  'AskUserQuestion',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'Skill',
]);
const ASK_AGENT = /(^|__|[./:])ask_agent$/;
const WEBBY = /web|fetch|browse|http|url|curl|wget/i;
const NETWORK_COMMAND =
  /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|nc|ncat)\b|https?:\/\//i;

function commandOf(tool: ToolBlock): string {
  const parts: string[] = [];
  for (const item of tool.content ?? []) if (item.type === 'command') parts.push(item.command);
  const input = tool.input;
  if (typeof input === 'string') parts.push(input);
  else if (input && typeof input === 'object') {
    for (const value of Object.values(input)) if (typeof value === 'string') parts.push(value);
  }
  return parts.join('\n');
}

/**
 * Esta ferramenta trouxe (ou pode ter trazido) texto de fora para o contexto do agente? Na dúvida,
 * sim: páginas da web, servidores MCP de terceiros, comandos que falam à rede e tudo o que não
 * sabemos classificar.
 */
export function toolIsExternal(tool: ToolBlock): boolean {
  const name = tool.name;
  // A resposta de uma consulta é texto de outro agente, que pode ter lido a web: conta como externa.
  if (ASK_AGENT.test(name)) return true;
  if (name.startsWith(`mcp__${BRAIN_SERVER_NAME}__`)) return false;
  if (name.startsWith('mcp__')) return true;
  if (tool.category === 'fetch') return true;
  if (WEBBY.test(name)) return true;
  if (tool.category === 'execute') return NETWORK_COMMAND.test(commandOf(tool));
  if (tool.category && LOCAL.has(tool.category)) return false;
  return !LOCAL_NAMES.has(name);
}

/** Algum dos blocos usou uma fonte externa. */
export function usedExternalSources(blocks: readonly Block[]): boolean {
  return blocks.some((block) => block.kind === 'tool' && toolIsExternal(block));
}

/**
 * O turno em curso: o último pedido do utilizador e tudo o que o agente fez desde então. Sem
 * nenhum pedido (não devia acontecer), `external` fica verdadeiro.
 */
export function currentTurn(turns: readonly Turn[]): { id: string | undefined; external: boolean } {
  const index = turns.findLastIndex((turn) => turn.role === 'user');
  if (index < 0) return { id: undefined, external: true };
  const user = turns[index];
  const external = turns.slice(index).some((turn) => usedExternalSources(turn.blocks));
  return { id: user?.id, external };
}
