import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AcpAdapter } from '../adapters/acp/adapter.ts';
import type { EnvPolicy } from '../env.ts';
import type { AgentDefinition } from './registry.ts';

/**
 * Agentes ACP conhecidos, cada um revisto antes de entrar (versão exata, ficheiros, scripts
 * de instalação). Só entram por commit: não há UI para juntar executáveis.
 */
export interface CatalogEntry {
  id: string;
  label: string;
  /** Pacote npm instalado com npm -g e o binário dentro dele. */
  npm: { package: string; bin: string; binary: string };
  args: readonly string[];
  reviewedVersion: string;
  envPolicy: EnvPolicy;
  untrustedProjects: 'allowed' | 'refused';
  loginHint?: string;
  install: string;
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    // MIT; o postinstall só copia o binário da plataforma (ou instala-o com npm se faltar).
    // Sem proveniência no npm. Lê opencode.json e plugins do projeto: só com confiança.
    id: 'opencode',
    label: 'OpenCode',
    npm: { package: 'opencode-ai', bin: 'opencode', binary: 'bin/opencode.exe' },
    args: ['acp'],
    reviewedVersion: '1.19.3',
    envPolicy: {
      base: 'no-secrets',
      // Edições, comandos e pedidos à web passam pelo cartão de autorização da Solline.
      overlay: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
        }),
      },
    },
    untrustedProjects: 'refused',
    loginHint: 'opencode auth login (ou /connect no OpenCode)',
    install: 'npm install -g opencode-ai@1.19.3',
  },
];

export interface InstalledAgent {
  binary: string;
  version: string | null;
}

/**
 * Procura um pacote instalado com npm -g: a pasta do PATH que tem o <bin>.cmd é o prefixo e o
 * pacote está em <prefixo>\node_modules. Só pastas absolutas do PATH, nunca a pasta atual.
 */
export function findNpmAgent(
  entry: Pick<CatalogEntry, 'npm'>,
  pathEnv: string = process.env.PATH ?? '',
): InstalledAgent | null {
  const dirs = pathEnv.split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  for (const dir of dirs) {
    if (!existsSync(path.join(dir, `${entry.npm.bin}.cmd`))) continue;
    const root = path.join(dir, 'node_modules', ...entry.npm.package.split('/'));
    const binary = path.join(root, ...entry.npm.binary.split('/'));
    if (!existsSync(binary)) continue;
    let version: string | null = null;
    try {
      version =
        (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string })
          .version ?? null;
    } catch {
      // sem package.json: não está revisto
    }
    return { binary, version };
  }
  return null;
}

export function catalogDefinition(
  entry: CatalogEntry,
  find: () => InstalledAgent | null = () => findNpmAgent(entry),
): AgentDefinition {
  const check = (): InstalledAgent => {
    const found = find();
    if (!found) throw new Error(`Não encontrei o ${entry.label} nesta máquina`);
    if (found.version !== entry.reviewedVersion) {
      throw new Error(
        `O ${entry.label} instalado (${found.version ?? '?'}) não é a versão revista`,
      );
    }
    return found;
  };
  return {
    id: entry.id,
    label: entry.label,
    transport: 'acp',
    envPolicy: entry.envPolicy,
    // Os modos de um agente ACP só se sabem no arranque.
    defaultMode: null,
    staticModes: [],
    untrustedProjects: entry.untrustedProjects,
    // O ACP obriga os agentes a aceitar servidores MCP por stdio.
    mcp: true,
    detect: async () => {
      const found = find();
      if (!found)
        return { status: 'not-found', detail: `Instala o ${entry.label}: ${entry.install}` };
      if (found.version !== entry.reviewedVersion) {
        return {
          status: 'unreviewed',
          detail: `Versão não revista (instalada ${found.version ?? '?'}, revista ${entry.reviewedVersion})`,
        };
      }
      return { status: 'ready' };
    },
    create: (start, sink) =>
      new AcpAdapter(
        {
          ...start,
          label: entry.label,
          command: check().binary,
          args: entry.args,
          ...(entry.loginHint ? { loginHint: entry.loginHint } : {}),
        },
        sink,
      ),
  };
}
