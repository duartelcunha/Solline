import { create } from 'zustand';
import type {
  CommandName,
  CommandPayload,
  CommandResult,
  McpCatalogState,
} from '@solline/protocol';

/**
 * O catálogo global de servidores MCP como o motor o guarda (a vista é da fase 6). O estado inteiro
 * chega num evento (mcp.changed); aqui só há a ponte: pesquisar no registo, acrescentar, aprovar,
 * sondar, tirar e escolher por projeto. Os valores dos segredos só passam por `addMcpServer`,
 * `updateMcpServer` e `setMcpSecret`, e o main leva-os ao Gestor de Credenciais: nunca ficam aqui.
 */
export const useMcpCatalog = create<{ data: McpCatalogState; loaded: boolean }>(() => ({
  data: { servers: [], projects: {} },
  loaded: false,
}));

export function receiveMcpCatalog(data: McpCatalogState): void {
  useMcpCatalog.setState({ data, loaded: true });
}

/** Quem mostra o erro (o aviso da app); injetado para não prender este módulo ao store principal. */
type Notice = (text: string) => void;
let notice: Notice = () => undefined;
export function onMcpNotice(next: Notice): void {
  notice = next;
}

function call<C extends CommandName>(
  command: C,
  payload: CommandPayload<C>,
): Promise<CommandResult<C>> {
  return window.solline.request(command, payload);
}

function reason(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method[^:]*: /, '')
    : String(error);
}

async function attempt<T>(doing: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    notice(`Não consegui ${doing}. ${reason(error)}`);
    return null;
  }
}

export const mcpCatalogActions = {
  /** Lê o catálogo (o estado novo também chega por mcp.changed). */
  async loadMcpCatalog(): Promise<McpCatalogState | null> {
    const data = await attempt('ler o catálogo MCP', () => call('mcp.catalog', {}));
    if (data) receiveMcpCatalog(data);
    return data;
  },

  /** Pesquisa no registo oficial; só o texto pesquisado sai da máquina. */
  searchMcp(query: string, cursor?: string): Promise<CommandResult<'mcp.search'> | null> {
    return attempt('pesquisar no registo MCP', () =>
      call('mcp.search', { query, ...(cursor ? { cursor } : {}) }),
    );
  },

  /** Acrescenta um servidor (do registo ou à mão); fica por aprovar. `values` inclui os segredos. */
  addMcpServer(input: CommandPayload<'mcp.add'>): Promise<CommandResult<'mcp.add'> | null> {
    return attempt('acrescentar o servidor MCP', () => call('mcp.add', input));
  },

  updateMcpServer(
    input: CommandPayload<'mcp.update'>,
  ): Promise<CommandResult<'mcp.update'> | null> {
    return attempt('mudar o servidor MCP', () => call('mcp.update', input));
  },

  /** Muda (ou, com null, tira) o valor de uma variável secreta. */
  async setMcpSecret(id: string, name: string, value: string | null): Promise<boolean> {
    return (
      (await attempt('guardar o segredo', () => call('mcp.setSecret', { id, name, value }))) !==
      null
    );
  },

  /** O main pede a confirmação nativa; `approved` é false se recusares. */
  approveMcpServer(id: string): Promise<CommandResult<'mcp.approve'> | null> {
    return attempt('aprovar o servidor MCP', () => call('mcp.approve', { id }));
  },

  /** Arranca o servidor uma vez e guarda as ferramentas (ou o que mudou). */
  probeMcpServer(id: string): Promise<CommandResult<'mcp.probe'> | null> {
    return attempt('ver as ferramentas do servidor MCP', () => call('mcp.probe', { id }));
  },

  async removeMcpServer(id: string): Promise<boolean> {
    return (
      (await attempt('tirar o servidor MCP', () => call('mcp.remove', { id })))?.removed ?? false
    );
  },

  /** Quais servidores do catálogo entram em cada sessão nova do projeto. */
  async setProjectMcp(projectId: string, serverIds: string[]): Promise<boolean> {
    const data = await attempt('escolher os servidores MCP do projeto', () =>
      call('mcp.setProject', { projectId, serverIds }),
    );
    if (data) receiveMcpCatalog(data);
    return data !== null;
  },
};
