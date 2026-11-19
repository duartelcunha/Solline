import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpAdapter } from '../adapters/acp/adapter.ts';
import type { EnvPolicy } from '../env.ts';
import type { AgentDefinition } from './registry.ts';

export interface NpmBinarySpec {
  package: string;
  bin: string;
  binary: string;
}

export interface NativeBinarySpec {
  /** Executáveis candidatos em pastas absolutas do PATH (ex.: omp.exe no Windows). */
  executables: readonly string[] | ((platform: NodeJS.Platform) => readonly string[]);
  /** Caminhos absolutos conhecidos fora do PATH (ex.: %LOCALAPPDATA%\omp\omp.exe). */
  fallbackPaths?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => readonly string[];
  versionArgs: readonly string[];
  parseVersion: (stdout: string) => string | null;
}

export interface ConfigOverlaySpec {
  filename: string;
  flag: string;
  content: string;
}

/**
 * Agentes ACP conhecidos, cada um revisto antes de entrar (versão exata, ficheiros, scripts
 * de instalação). Só entram por commit: não há UI para juntar executáveis.
 */
export interface CatalogEntry {
  id: string;
  label: string;
  /** Pacote npm instalado com npm -g e o binário dentro dele. */
  npm?: NpmBinarySpec;
  /** Binário nativo instalado localmente (PATH absoluto ou caminho conhecido). */
  binary?: NativeBinarySpec;
  /** Ficheiro de configuração gerido pela Solline e passado no arranque do agente. */
  configOverlay?: ConfigOverlaySpec;
  args: readonly string[];
  reviewedVersion: string;
  envPolicy: EnvPolicy;
  untrustedProjects: 'allowed' | 'refused';
  loginHint?: string;
  install: string;
}

const OMP_OVERLAY_CONTENT = [
  '# Gerido pela Solline — força aprovações ask e desliga subsistemas que colidem com o motor.',
  'tools:',
  '  approvalMode: always-ask',
  'memory:',
  '  backend: off',
  'memories:',
  '  enabled: false',
  'autolearn:',
  '  enabled: false',
  '  autoContinue: false',
  'checkpoint:',
  '  enabled: false',
  'advisor:',
  '  enabled: false',
  'startup:',
  '  checkUpdate: false',
  'update:',
  '  auto: false',
  'collab:',
  '  autoStart: off',
  'contextFiles:',
  '  extra: []',
  '',
].join('\n');

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
  {
    // Binário nativo omp.exe com servidor ACP por stdio (`omp acp`).
    // Lê AGENTS.md/CLAUDE.md do projeto e config local: só corre em projetos de confiança.
    id: 'omp',
    label: 'OMP',
    binary: {
      executables: (platform) => (platform === 'win32' ? ['omp.exe'] : ['omp']),
      fallbackPaths: (env, platform) =>
        platform === 'win32' && env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA)
          ? [path.join(env.LOCALAPPDATA, 'omp', 'omp.exe')]
          : [],
      versionArgs: ['--version'],
      parseVersion: (stdout) => stdout.match(/\bomp\/([0-9]+\.[0-9]+\.[0-9]+)\b/i)?.[1] ?? null,
    },
    configOverlay: {
      filename: 'omp-solline-overlay.yml',
      flag: '--config',
      content: OMP_OVERLAY_CONTENT,
    },
    args: ['acp'],
    reviewedVersion: '18.22.2',
    envPolicy: {
      base: 'no-secrets',
    },
    untrustedProjects: 'refused',
    loginHint: 'omp login',
    install: 'Instala o OMP 18.22.2 e entra com: omp login',
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
  if (!entry.npm) return null;
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

export interface BinaryVersionCacheEntry {
  mtimeMs: number;
  version: string | null;
}

const binaryVersionCache = new Map<string, BinaryVersionCacheEntry>();

export interface FindBinaryOptions {
  pathEnv?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  refresh?: boolean | undefined;
  exec?: ((binary: string, args: readonly string[]) => string) | undefined;
  cache?: Map<string, BinaryVersionCacheEntry> | undefined;
}

/**
 * Procura um binário nativo em pastas absolutas do PATH e caminhos conhecidos.
 * No Windows recusa .cmd/.bat (nunca arranca por shell). Guarda a versão por mtimeMs.
 */
export function findBinaryAgent(
  entry: Pick<CatalogEntry, 'binary'>,
  options: FindBinaryOptions = {},
): InstalledAgent | null {
  const spec = entry.binary;
  if (!spec) return null;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? env.PATH ?? '';
  const names =
    typeof spec.executables === 'function' ? spec.executables(platform) : spec.executables;
  const dirs = pathEnv.split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  const candidates: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      candidates.push(path.join(dir, name));
    }
  }
  for (const fallback of spec.fallbackPaths?.(env, platform) ?? []) {
    if (fallback && path.isAbsolute(fallback)) candidates.push(fallback);
  }
  const seen = new Set<string>();
  const cache = options.cache ?? (options.exec ? undefined : binaryVersionCache);
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) continue;
    let mtimeMs: number;
    try {
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    const cached = !options.refresh && cache ? cache.get(candidate) : undefined;
    if (cached && cached.mtimeMs === mtimeMs) {
      return { binary: candidate, version: cached.version };
    }
    let version: string | null = null;
    try {
      const stdout = options.exec
        ? options.exec(candidate, spec.versionArgs)
        : execFileSync(candidate, [...spec.versionArgs], {
            encoding: 'utf8',
            timeout: 5_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
          });
      version = spec.parseVersion(stdout);
      cache?.set(candidate, { mtimeMs, version });
    } catch {
      // Erro ou tempo esgotado ao ler versão: fica sem versão (unreviewed), sem pôr em cache.
    }
    return { binary: candidate, version };
  }
  return null;
}

function ensureConfigOverlay(spec: ConfigOverlaySpec, dataDir?: string): string {
  const dir = path.join(dataDir ?? path.join(os.tmpdir(), 'solline-agents'), 'agents');
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, spec.filename);
  try {
    if (readFileSync(target, 'utf8') === spec.content) return target;
  } catch {
    // Ainda não existe ou não deu para ler: escreve de forma atómica.
  }
  const temp = path.join(dir, `${spec.filename}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, spec.content, 'utf8');
  renameSync(temp, target);
  return target;
}

/** Argumentos de arranque da entrada do catálogo, materializando o overlay se existir. */
export function catalogArgs(entry: Pick<CatalogEntry, 'args' | 'configOverlay'>, dataDir?: string): readonly string[] {
  if (!entry.configOverlay) return entry.args;
  const overlayPath = ensureConfigOverlay(entry.configOverlay, dataDir);
  return [entry.configOverlay.flag, overlayPath, ...entry.args];
}

export type CatalogFinder = (options?: { refresh?: boolean }) => InstalledAgent | null;

export interface CatalogDefinitionOptions {
  find?: CatalogFinder | undefined;
  dataDir?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export function catalogDefinition(
  entry: CatalogEntry,
  findOrOptions?: CatalogFinder | CatalogDefinitionOptions,
): AgentDefinition {
  const opts: CatalogDefinitionOptions =
    typeof findOrOptions === 'function' ? { find: findOrOptions } : (findOrOptions ?? {});
  const find: CatalogFinder =
    opts.find ??
    ((detectOpts) =>
      entry.npm
        ? findNpmAgent(entry)
        : entry.binary
          ? findBinaryAgent(entry, { refresh: detectOpts?.refresh, env: opts.env })
          : null);
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
    brain: 'stdio',
    // Os agentes ACP só têm mensagens: as regras seguem com a primeira.
    rules: { via: 'context' },
    // Corre sem segredos do anfitrião: as chaves que precisar escolhes tu no painel.
    configurableKeys: true,
    detect: async (detectOpts) => {
      const found = find(detectOpts);
      if (!found)
        return { status: 'not-found', detail: `Instala o ${entry.label}: ${entry.install}` };
      const version = { installed: found.version, reviewed: entry.reviewedVersion };
      if (found.version !== entry.reviewedVersion) {
        return {
          status: 'unreviewed',
          detail: `Versão não revista (instalada ${found.version ?? '?'}, revista ${entry.reviewedVersion})`,
          version,
        };
      }
      return { status: 'ready', version };
    },
    create: (start, sink) => {
      const binary = check().binary;
      return new AcpAdapter(
        {
          ...start,
          label: entry.label,
          command: binary,
          args: catalogArgs(entry, opts.dataDir),
          ...(entry.loginHint ? { loginHint: entry.loginHint } : {}),
        },
        sink,
      );
    },
  };
}
