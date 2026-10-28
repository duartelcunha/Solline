import { z } from 'zod';
import {
  McpServerSpec,
  isReservedEnvName,
  type McpRegistryResult,
  type McpSearchResult,
} from '@solline/protocol';
import { cleanText, commandLine } from './spec.ts';

/**
 * O registo oficial de servidores MCP (API v0). Só se pergunta o texto pesquisado; o que volta é
 * dado não confiável: valida-se com zod, limita-se o tamanho e nunca se corre nem se interpreta.
 * Só entram pacotes npm (npx) e PyPI (uvx), com a versão fixada; os remotos (HTTP) ficam de fora
 * porque os adaptadores ainda só arrancam servidores por stdio.
 */
export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io';
const MAX_BODY = 2 * 1024 * 1024;
const PAGE = 30;

const Argument = z
  .object({
    type: z.string().max(32).optional(),
    name: z.string().max(100).optional(),
    value: z.string().max(500).optional(),
    isRequired: z.boolean().optional(),
  })
  .passthrough();

const RegistryPackage = z
  .object({
    registryType: z.string().max(32),
    identifier: z.string().max(200),
    version: z.string().max(64).optional(),
    transport: z
      .object({ type: z.string().max(32) })
      .passthrough()
      .optional(),
    packageArguments: z.array(Argument).max(64).optional(),
    environmentVariables: z
      .array(
        z
          .object({
            name: z.string().max(100),
            description: z.string().max(2000).optional(),
            isRequired: z.boolean().optional(),
            isSecret: z.boolean().optional(),
          })
          .passthrough(),
      )
      .max(64)
      .optional(),
  })
  .passthrough();

const RegistryServer = z
  .object({
    name: z.string().max(200),
    title: z.string().max(200).optional(),
    description: z.string().max(5000).optional(),
    version: z.string().max(64),
    repository: z
      .object({ url: z.string().max(500).optional() })
      .passthrough()
      .optional(),
    packages: z.array(RegistryPackage).max(32).optional(),
    remotes: z
      .array(z.object({ type: z.string().max(32) }).passthrough())
      .max(32)
      .optional(),
  })
  .passthrough();

const RegistryEntry = z
  .object({ server: RegistryServer, _meta: z.record(z.string(), z.unknown()).optional() })
  .passthrough();

const SearchResponse = z
  .object({
    servers: z.array(RegistryEntry).max(200),
    metadata: z
      .object({ nextCursor: z.string().max(300).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NPM = /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PYPI = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * Versão fixada, exata: semver completo no npm e PEP 440 no PyPI. Nada de latest, intervalos,
 * etiquetas nem curingas (`1.x`, `^1.0.0`, `>=1`).
 */
const PINNED = {
  npm: /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/,
  pypi: /^\d+(\.\d+)*((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?(\+[A-Za-z0-9.]+)?$/,
} as const;
const FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]*$/;

export type RegistryFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RegistryOptions {
  baseUrl?: string;
  fetch?: RegistryFetch;
  timeoutMs?: number;
}

/** O dono verificado: o registo só publica com prova do espaço de nomes (GitHub ou DNS). */
export function namespaceOf(name: string): {
  namespace: string;
  verified: 'github' | 'dns' | null;
} {
  const namespace = name.split('/')[0] ?? '';
  if (!NAME.test(name)) return { namespace, verified: null };
  return { namespace, verified: namespace.startsWith('io.github.') ? 'github' : 'dns' };
}

interface Built {
  spec: McpServerSpec;
  result: McpRegistryResult;
}

type Package = z.infer<typeof RegistryPackage>;

/** Os argumentos fixos do pacote; null se precisa de um valor que o utilizador teria de dar. */
function packageArgs(pkg: Package): string[] | null {
  const args: string[] = [];
  for (const arg of pkg.packageArguments ?? []) {
    const value = arg.value;
    if (value === undefined || value === '') {
      if (arg.isRequired) return null;
      continue;
    }
    if (/[{}]/.test(value) || cleanText(value, 300) !== value) return null;
    if (arg.type === 'named') {
      if (!arg.name || !FLAG.test(arg.name)) return null;
      args.push(arg.name, value);
    } else args.push(value);
  }
  return args.length <= 16 ? args : null;
}

function build(
  server: z.infer<typeof RegistryServer>,
  active: boolean,
): Built | 'remote' | 'other' {
  if (!NAME.test(server.name) || !active) return 'other';
  for (const pkg of server.packages ?? []) {
    const type = pkg.registryType;
    if (type !== 'npm' && type !== 'pypi') continue;
    if (pkg.transport && pkg.transport.type !== 'stdio') continue;
    const version = pkg.version;
    if (!version || version.length > 64 || !PINNED[type].test(version)) continue;
    if (!(type === 'npm' ? NPM : PYPI).test(pkg.identifier)) continue;
    const extra = packageArgs(pkg);
    if (!extra) continue;
    const env: McpServerSpec['env'] = [];
    let unusable = false;
    for (const variable of pkg.environmentVariables ?? []) {
      const name = variable.name;
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || isReservedEnvName(name)) {
        // Uma variável que mudaria o que corre: este pacote fica de fora.
        unusable = true;
        break;
      }
      if (env.some((e) => e.name === name)) continue;
      const description = cleanText(variable.description, 300);
      env.push({
        name,
        // Secreta, a menos que o registo diga o contrário: o pior que acontece a uma variável
        // não secreta marcada como secreta é ir para o cofre em vez de para o catálogo.
        secret: variable.isSecret !== false,
        required: variable.isRequired === true,
        ...(description ? { description } : {}),
      });
    }
    if (unusable || env.length > 16) continue;
    const { namespace, verified } = namespaceOf(server.name);
    const spec: McpServerSpec = {
      label: cleanText(server.title || server.name.split('/')[1], 80) || server.name,
      ...(type === 'npm'
        ? { command: 'npx', args: ['-y', `${pkg.identifier}@${version}`, ...extra] }
        : { command: 'uvx', args: [`${pkg.identifier}==${version}`, ...extra] }),
      env,
      source: {
        kind: 'registry',
        name: server.name,
        version: server.version,
        registryType: type,
        identifier: pkg.identifier,
        verified,
      },
    };
    const checked = McpServerSpec.safeParse(spec);
    if (!checked.success) continue;
    const repository = cleanText(server.repository?.url, 300);
    return {
      spec: checked.data,
      result: {
        name: server.name,
        title: spec.label,
        description: cleanText(server.description, 500),
        version: server.version,
        namespace,
        verified,
        repository: /^https:\/\//.test(repository) ? repository : null,
        registryType: type,
        identifier: pkg.identifier,
        packageVersion: version,
        commandLine: commandLine(spec),
        env: env.map((e) => ({
          name: e.name,
          secret: e.secret,
          required: e.required,
          ...(e.description ? { description: e.description } : {}),
        })),
      },
    };
  }
  return (server.remotes?.length ?? 0) > 0 && !(server.packages?.length ?? 0) ? 'remote' : 'other';
}

function isActive(meta: Record<string, unknown> | undefined): boolean {
  const official = meta?.['io.modelcontextprotocol.registry/official'];
  const status =
    official && typeof official === 'object'
      ? (official as { status?: unknown }).status
      : undefined;
  return status === undefined || status === 'active';
}

export class McpRegistry {
  readonly #base: string;
  readonly #fetch: RegistryFetch;
  readonly #timeout: number;

  constructor(options: RegistryOptions = {}) {
    this.#base = options.baseUrl ?? REGISTRY_URL;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeout = options.timeoutMs ?? 15_000;
  }

  async #get(url: URL): Promise<unknown> {
    const response = await this.#fetch(url.href, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'Solline' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.#timeout),
    });
    if (!response.ok) throw new Error(`O registo respondeu ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_BODY) throw new Error('A resposta do registo é grande demais');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('A resposta do registo não é JSON');
    }
  }

  /** Pesquisa (só o texto pesquisado sai da máquina); devolve o que a Solline sabe arrancar. */
  async search(query: string, cursor?: string): Promise<McpSearchResult> {
    const url = new URL('/v0/servers', this.#base);
    url.searchParams.set('search', query.trim().slice(0, 100));
    url.searchParams.set('limit', String(PAGE));
    url.searchParams.set('version', 'latest');
    if (cursor) url.searchParams.set('cursor', cursor.slice(0, 300));
    const parsed = SearchResponse.safeParse(await this.#get(url));
    if (!parsed.success) throw new Error('A resposta do registo não tem o formato esperado');
    const results: McpRegistryResult[] = [];
    const skipped = { remote: 0, other: 0 };
    const seen = new Set<string>();
    for (const entry of parsed.data.servers) {
      const built = build(entry.server, isActive(entry._meta));
      if (built === 'remote') skipped.remote += 1;
      else if (built === 'other') skipped.other += 1;
      else if (!seen.has(built.result.name)) {
        seen.add(built.result.name);
        results.push(built.result);
      }
    }
    return {
      results,
      nextCursor: parsed.data.metadata?.nextCursor ?? null,
      skipped,
    };
  }

  /** O servidor tal como ficaria no catálogo, refeito a partir do registo (nunca de dados da interface). */
  async resolve(name: string, version: string): Promise<McpServerSpec> {
    if (!NAME.test(name)) throw new Error('Nome de servidor inválido para o registo');
    const url = new URL(
      `/v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
      this.#base,
    );
    const parsed = RegistryEntry.safeParse(await this.#get(url));
    if (!parsed.success) throw new Error('A resposta do registo não tem o formato esperado');
    if (parsed.data.server.name !== name) throw new Error('O registo devolveu outro servidor');
    const built = build(parsed.data.server, isActive(parsed.data._meta));
    if (built === 'remote')
      throw new Error(
        'Este servidor é remoto (HTTP): a Solline ainda só arranca servidores locais',
      );
    if (built === 'other')
      throw new Error(
        'Este servidor não tem um pacote npm ou PyPI com versão fixada que a Solline saiba arrancar',
      );
    return built.spec;
  }
}
