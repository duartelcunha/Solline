import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServerDescriptor } from '@solline/protocol';
import { McpLaunchError } from './launch.ts';

/**
 * Servidores MCP que se podem ligar a uma sessão, revistos e escritos no código (como os
 * agentes). Nunca se escrevem nas configs globais dos agentes: vão só na sessão que os pede.
 */
export interface McpEntry {
  id: string;
  /** Nome do servidor para o agente (as ferramentas ficam mcp__<name>__…). */
  name: string;
  label: string;
  reviewedVersion: string;
  /** Pacote npm instalado numa pasta própria em <dados da app>/mcp/<id>. */
  npm: { package: string; entry: string };
  args: readonly string[];
  /** Corre programas ou alvos: sem Auto, sem acesso total e sem "Permitir sempre". */
  executesCode: boolean;
  install: (dir: string) => string;
}

export const MCP_CATALOG: readonly McpEntry[] = [
  {
    // MIT; sem scripts de instalação próprios; o Frida (opcional) descarrega um binário ao
    // instalar, por isso instala-se com --ignore-scripts. Muda de versão muito depressa:
    // rever em cada subida. Nunca "rea setup" (reescreve as configs de ~25 clientes).
    id: 'rea',
    name: 'rea',
    label: 'REA (engenharia reversa)',
    reviewedVersion: '6.7.0',
    npm: { package: 'rea-agents', entry: 'scripts/rea.mjs' },
    args: ['mcp'],
    executesCode: true,
    install: (dir) => `npm install --prefix "${dir}" --ignore-scripts rea-agents@6.7.0`,
  },
];

/** Um servidor pronto a arrancar: comando absoluto e argumentos. */
export interface McpLaunch {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  executesCode: boolean;
}

export interface McpCatalog {
  list(): Promise<McpServerDescriptor[]>;
  /** Lança se o servidor não existir ou não estiver pronto. */
  launch(id: string): Promise<McpLaunch>;
  /** Os servidores que o projeto escolheu: entram em cada sessão nova dele (só no catálogo do utilizador). */
  projectServers?(projectId: string): string[];
}

/**
 * O node.exe do PATH (só pastas absolutas). Na app instalada o próprio executável não serve
 * de Node: os fuses tiram o runAsNode.
 */
export function findNode(pathEnv: string = process.env.PATH ?? ''): string | null {
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface Resolved {
  descriptor: McpServerDescriptor;
  launch?: McpLaunch;
}

function resolve(entry: McpEntry, dataDir: string, node: string | null): Resolved {
  const dir = path.join(dataDir, 'mcp', entry.id);
  const root = path.join(dir, 'node_modules', ...entry.npm.package.split('/'));
  const base = { id: entry.id, label: entry.label, executesCode: entry.executesCode };
  let version: string | null;
  try {
    version =
      (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string })
        .version ?? null;
  } catch {
    return {
      descriptor: { ...base, status: 'not-found', detail: `Instala com: ${entry.install(dir)}` },
    };
  }
  if (version !== entry.reviewedVersion) {
    return {
      descriptor: {
        ...base,
        status: 'unreviewed',
        detail: `Versão não revista (instalada ${version ?? '?'}, revista ${entry.reviewedVersion})`,
      },
    };
  }
  if (!node) {
    return { descriptor: { ...base, status: 'not-found', detail: 'Falta o Node.js no PATH' } };
  }
  return {
    descriptor: { ...base, status: 'ready' },
    launch: {
      id: entry.id,
      name: entry.name,
      command: node,
      args: [path.join(root, ...entry.npm.entry.split('/')), ...entry.args],
      env: {},
      executesCode: entry.executesCode,
    },
  };
}

export function mcpCatalog(
  options: {
    dataDir?: string | undefined;
    entries?: readonly McpEntry[];
    node?: () => string | null;
  } = {},
): McpCatalog {
  const entries = options.entries ?? MCP_CATALOG;
  const dataDir = options.dataDir;
  const node = options.node ?? (() => findNode());
  const all = (): Resolved[] =>
    dataDir
      ? entries.map((e) => resolve(e, dataDir, node()))
      : entries.map((e) => ({
          descriptor: {
            id: e.id,
            label: e.label,
            executesCode: e.executesCode,
            status: 'not-found',
            detail: 'Sem pasta de dados',
          },
        }));
  return {
    list: async () => all().map((r) => r.descriptor),
    launch: async (id) => {
      const found = all().find((r) => r.descriptor.id === id);
      if (!found) throw new McpLaunchError('unavailable', `Servidor MCP desconhecido: ${id}`);
      if (!found.launch)
        throw new McpLaunchError(
          'unavailable',
          `${found.descriptor.label}: ${found.descriptor.detail ?? 'não está pronto'}`,
        );
      return found.launch;
    },
  };
}

/** Para testes: servidores já resolvidos, sem pasta nem versões. */
export function fixedMcpCatalog(servers: readonly McpLaunch[]): McpCatalog {
  return {
    list: async () =>
      servers.map((s) => ({
        id: s.id,
        label: s.name,
        executesCode: s.executesCode,
        status: 'ready' as const,
      })),
    launch: async (id) => {
      const found = servers.find((s) => s.id === id);
      if (!found) throw new McpLaunchError('unavailable', `Servidor MCP desconhecido: ${id}`);
      return found;
    },
  };
}
