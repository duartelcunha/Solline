import {
  McpManualSpec,
  McpServerSpec,
  MCP_PROJECT_MAX,
  type McpCatalogServer,
  type McpCatalogState,
  type McpAddSource,
  type McpSearchResult,
  type McpServerDescriptor,
} from '@solline/protocol';
import type { McpCatalog, McpLaunch } from './catalog.ts';
import { McpLaunchError, resolveCommand, type Resolved } from './launch.ts';
import { PROBE_TIMEOUT_MS, probeMcpServer, type ProbeFn } from './probe.ts';
import { McpRegistry } from './registry.ts';
import type { McpSecretReader } from './secrets.ts';
import { cleanText, commandLine, diffTools, fingerprint, redact } from './spec.ts';
import { CatalogFile, type StoredCatalog, type StoredServer } from './store.ts';

const MAX_SERVERS = 50;

export interface UserCatalogOptions {
  /** Onde se guarda o catálogo (mcp-catalog.json); sem pasta, só em memória. */
  dataDir?: string | undefined;
  registry?: McpRegistry;
  /** Os segredos, pedidos só no momento de arrancar a sonda ou de entregar o servidor. */
  secrets?: McpSecretReader | undefined;
  probe?: ProbeFn;
  probeTimeoutMs?: number;
  node?: () => string | null;
  pathEnv?: () => string | undefined;
  /** Nomes que o catálogo fixo já usa. */
  reserved?: () => readonly string[];
  /** Os ids do catálogo fixo (um projeto também os pode escolher). */
  builtinIds?: () => Promise<readonly string[]>;
  onChange?: (state: McpCatalogState) => void;
  now?: () => number;
}

function invalid(error: { issues?: { path: PropertyKey[]; message: string }[] }): Error {
  const first = error.issues?.[0];
  return new Error(
    first
      ? `Dados do servidor inválidos (${first.path.map(String).join('.') || 'servidor'}): ${first.message}`
      : 'Dados do servidor inválidos',
  );
}

/** O nome do servidor para o agente: minúsculas, números e hífens, a começar por letra. */
function slug(label: string): string {
  const base = label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  return /^[a-z]/.test(base) ? base : `mcp-${base}`.replace(/-+$/, '') || 'mcp';
}

/**
 * Os servidores MCP que o utilizador acrescenta (do registo oficial ou à mão). Cada um só arranca
 * depois de aprovado no main, com a impressão exata do que corre; o motor guarda a impressão das
 * ferramentas e volta a sondar na primeira entrega de cada execução, e se mudou pede nova
 * aprovação. Os valores secretos nunca ficam aqui: pedem-se ao cofre do main na hora de usar.
 */
export class UserMcpCatalog {
  readonly #file: CatalogFile;
  readonly #registry: McpRegistry;
  readonly #secrets: McpSecretReader | undefined;
  readonly #probe: ProbeFn;
  readonly #probeTimeout: number;
  readonly #node: () => string | null;
  readonly #pathEnv: () => string | undefined;
  readonly #reserved: () => readonly string[];
  readonly #builtinIds: () => Promise<readonly string[]>;
  readonly #onChange: ((state: McpCatalogState) => void) | undefined;
  readonly #now: () => number;
  readonly #data: StoredCatalog;
  /** Servidores já verificados nesta execução (a sonda corre na primeira entrega). */
  readonly #verified = new Set<string>();
  readonly #errors = new Map<string, string>();
  readonly #probing = new Map<string, Promise<'ok' | 'changed'>>();

  constructor(options: UserCatalogOptions = {}) {
    this.#file = new CatalogFile(options.dataDir);
    this.#registry = options.registry ?? new McpRegistry();
    this.#secrets = options.secrets;
    this.#probe = options.probe ?? probeMcpServer;
    this.#probeTimeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.#node = options.node ?? (() => null);
    this.#pathEnv = options.pathEnv ?? (() => undefined);
    this.#reserved = options.reserved ?? (() => []);
    this.#builtinIds = options.builtinIds ?? (async () => []);
    this.#onChange = options.onChange;
    this.#now = options.now ?? Date.now;
    this.#data = this.#file.load();
  }

  // --- vista ---

  #view(s: StoredServer): McpCatalogServer {
    const print = fingerprint(s.spec);
    const approved = s.approvedFingerprint === print;
    const changed =
      approved && s.pending
        ? { ...diffTools(s.tools ?? [], s.pending.tools), hash: s.pending.hash }
        : null;
    const error = this.#errors.get(s.id) ?? null;
    return {
      id: s.id,
      name: s.name,
      spec: s.spec,
      commandLine: commandLine(s.spec),
      fingerprint: print,
      status: !approved ? 'needs-approval' : changed ? 'changed' : error ? 'error' : 'ready',
      approved,
      tools: s.tools?.map(({ name, description }) => ({ name, description })) ?? null,
      toolsHash: s.toolsHash,
      probedAt: s.probedAt,
      changed,
      error,
      createdAt: s.createdAt,
    };
  }

  state(): McpCatalogState {
    return {
      servers: this.#data.servers.map((s) => this.#view(s)),
      projects: structuredClone(this.#data.projects),
    };
  }

  has(id: string): boolean {
    return this.#data.servers.some((s) => s.id === id);
  }

  get(id: string): McpCatalogServer {
    return this.#view(this.#find(id));
  }

  #find(id: string): StoredServer {
    const found = this.#data.servers.find((s) => s.id === id);
    if (!found) throw new Error(`Servidor MCP desconhecido: ${id}`);
    return found;
  }

  #changed(): void {
    this.#file.save(this.#data);
    this.#onChange?.(this.state());
  }

  /** Para a lista de servidores que se ligam à mão a uma sessão: só os prontos. */
  descriptors(): McpServerDescriptor[] {
    return this.#data.servers.flatMap((s) => {
      const view = this.#view(s);
      return view.status === 'ready'
        ? [{ id: s.id, label: s.spec.label, status: 'ready' as const, executesCode: true }]
        : [];
    });
  }

  // --- registo e dados ---

  search(query: string, cursor?: string): Promise<McpSearchResult> {
    return this.#registry.search(query, cursor);
  }

  /** Os dados como ficariam, sem guardar nada. O registo é refeito a partir do próprio registo. */
  async draft(source: McpAddSource): Promise<McpServerSpec> {
    if (source.kind === 'registry') return this.#registry.resolve(source.name, source.version);
    const manual = McpManualSpec.safeParse(source.spec);
    if (!manual.success) throw invalid(manual.error);
    const spec = McpServerSpec.safeParse({ ...manual.data, source: { kind: 'manual' } });
    if (!spec.success) throw invalid(spec.error);
    return spec.data;
  }

  // --- escrita ---

  add(id: string, input: McpServerSpec): McpCatalogServer {
    const spec = McpServerSpec.safeParse(input);
    if (!spec.success) throw invalid(spec.error);
    if (this.has(id)) throw new Error('Já existe um servidor com este id');
    if (this.#data.servers.length >= MAX_SERVERS)
      throw new Error(`O catálogo tem no máximo ${MAX_SERVERS} servidores`);
    const stored: StoredServer = {
      id,
      name: this.#allocate(spec.data.label),
      spec: spec.data,
      approvedFingerprint: null,
      tools: null,
      toolsHash: null,
      probedAt: null,
      pending: null,
      createdAt: this.#now(),
    };
    this.#data.servers.push(stored);
    this.#changed();
    return this.#view(stored);
  }

  /**
   * Muda um servidor feito à mão. Mudar o comando, os argumentos ou as variáveis volta a pedir
   * aprovação e apaga a impressão das ferramentas (é outro programa).
   */
  update(id: string, input: McpServerSpec): McpCatalogServer {
    const stored = this.#find(id);
    if (stored.spec.source.kind !== 'manual')
      throw new Error(
        'Um servidor do registo não se edita: tira-o e acrescenta a versão que queres',
      );
    const spec = McpServerSpec.safeParse({ ...input, source: stored.spec.source });
    if (!spec.success) throw invalid(spec.error);
    const before = fingerprint(stored.spec);
    stored.spec = spec.data;
    if (fingerprint(spec.data) !== before) {
      stored.tools = null;
      stored.toolsHash = null;
      stored.probedAt = null;
      stored.pending = null;
      this.#verified.delete(id);
      this.#errors.delete(id);
    }
    this.#changed();
    return this.#view(stored);
  }

  remove(id: string): boolean {
    const at = this.#data.servers.findIndex((s) => s.id === id);
    if (at === -1) return false;
    this.#data.servers.splice(at, 1);
    this.#data.projects = Object.fromEntries(
      Object.entries(this.#data.projects)
        .map(([project, ids]) => [project, ids.filter((other) => other !== id)] as const)
        .filter(([, ids]) => ids.length > 0),
    );
    this.#verified.delete(id);
    this.#errors.delete(id);
    this.#changed();
    return true;
  }

  async setProject(projectId: string, ids: readonly string[]): Promise<McpCatalogState> {
    const unique = [...new Set(ids)];
    if (unique.length > MCP_PROJECT_MAX)
      throw new Error(`Um projeto usa no máximo ${MCP_PROJECT_MAX} servidores MCP`);
    const builtin = new Set(await this.#builtinIds());
    for (const id of unique)
      if (!this.has(id) && !builtin.has(id)) throw new Error(`Servidor MCP desconhecido: ${id}`);
    this.#data.projects = {
      ...Object.fromEntries(Object.entries(this.#data.projects).filter(([id]) => id !== projectId)),
      ...(unique.length > 0 ? { [projectId]: unique } : {}),
    };
    this.#changed();
    return this.state();
  }

  /** Os servidores que o projeto escolheu (os que ainda existem). */
  projectServers(projectId: string): string[] {
    return [...(this.#data.projects[projectId] ?? [])];
  }

  // --- aprovação e sonda ---

  /**
   * O utilizador aprovou (o main mostrou o comando, os argumentos e os nomes exatos). Só vale se a
   * impressão ainda é a que ele viu. Com as ferramentas mudadas, aprova a impressão que viu.
   * Depois da aprovação arranca-se o servidor uma vez para guardar as ferramentas.
   */
  async approve(
    id: string,
    seen: { fingerprint: string; toolsHash?: string | undefined },
  ): Promise<{ server: McpCatalogServer; approved: boolean }> {
    const stored = this.#find(id);
    const print = fingerprint(stored.spec);
    if (seen.fingerprint !== print)
      throw new Error('O servidor mudou depois de veres a confirmação. Volta a pedir a aprovação.');
    if (stored.approvedFingerprint === print && stored.pending) {
      if (seen.toolsHash !== stored.pending.hash)
        throw new Error('As ferramentas mudaram outra vez. Vê o que mudou e aprova de novo.');
      stored.tools = stored.pending.tools;
      stored.toolsHash = stored.pending.hash;
      stored.pending = null;
      this.#verified.add(id);
      this.#errors.delete(id);
      this.#changed();
      return { server: this.#view(stored), approved: true };
    }
    stored.approvedFingerprint = print;
    this.#changed();
    await this.probe(id).catch(() => undefined);
    return { server: this.#view(this.#find(id)), approved: true };
  }

  /** Arranca o servidor uma vez e guarda as ferramentas (ou o que mudou). */
  async probe(id: string): Promise<McpCatalogServer> {
    const stored = this.#find(id);
    if (stored.approvedFingerprint !== fingerprint(stored.spec))
      throw new McpLaunchError(
        'needs-approval',
        `${stored.spec.label}: precisa de aprovação antes de arrancar`,
      );
    const { env, values } = await this.#environment(stored);
    const resolved = this.#resolved(stored);
    await this.#verify(id, resolved, env, values);
    return this.#view(this.#find(id));
  }

  #resolved(stored: StoredServer): Resolved {
    try {
      return resolveCommand(stored.spec, { node: this.#node, pathEnv: this.#pathEnv() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#errors.set(stored.id, cleanText(message, 300));
      this.#onChange?.(this.state());
      throw error;
    }
  }

  /** O ambiente do servidor: os valores públicos do catálogo e os segredos que o cofre dá agora. */
  async #environment(
    stored: StoredServer,
  ): Promise<{ env: Record<string, string>; values: string[] }> {
    const label = stored.spec.label;
    const secretNames = stored.spec.env.filter((e) => e.secret).map((e) => e.name);
    let secrets: Record<string, string | null> = {};
    if (secretNames.length > 0) {
      if (!this.#secrets)
        throw new McpLaunchError('error', `${label}: o cofre de segredos não está disponível`);
      try {
        secrets = await this.#secrets.read(stored.id, secretNames);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new McpLaunchError(
          'error',
          `${label}: não consegui ler os segredos (${cleanText(message, 200)})`,
        );
      }
    }
    const env: Record<string, string> = {};
    const values: string[] = [];
    for (const decl of stored.spec.env) {
      const value = decl.secret ? (secrets[decl.name] ?? undefined) : decl.value;
      if (value === undefined || value === '') {
        if (decl.required)
          throw new McpLaunchError('error', `${label}: falta o valor de ${decl.name}`);
        continue;
      }
      env[decl.name] = value;
      if (decl.secret) values.push(value);
    }
    return { env, values };
  }

  /**
   * Arranca o servidor, lê as ferramentas e compara com as aprovadas. Uma chamada de cada vez por
   * servidor (duas sessões a arrancar juntas partilham a sonda).
   */
  #verify(
    id: string,
    resolved: Resolved,
    env: Record<string, string>,
    secrets: readonly string[],
  ): Promise<'ok' | 'changed'> {
    const running = this.#probing.get(id);
    if (running) return running;
    const run = (async (): Promise<'ok' | 'changed'> => {
      const stored = this.#find(id);
      const label = stored.spec.label;
      let result;
      try {
        result = await this.#probe(
          { command: resolved.command, args: resolved.args, env },
          { timeoutMs: this.#probeTimeout, secrets },
        );
      } catch (error) {
        const message = cleanText(
          redact(error instanceof Error ? error.message : String(error), secrets),
          300,
        );
        this.#errors.set(id, message);
        this.#onChange?.(this.state());
        throw new McpLaunchError('error', `${label}: ${message}`);
      }
      this.#errors.delete(id);
      stored.probedAt = this.#now();
      if (stored.toolsHash === null) {
        // A primeira vez que se vêem as ferramentas: é a referência.
        stored.tools = result.tools;
        stored.toolsHash = result.hash;
        stored.pending = null;
      } else if (stored.toolsHash === result.hash) {
        stored.pending = null;
      } else {
        stored.pending = { tools: result.tools, hash: result.hash };
        this.#verified.delete(id);
        this.#changed();
        return 'changed';
      }
      this.#verified.add(id);
      this.#changed();
      return 'ok';
    })().finally(() => this.#probing.delete(id));
    this.#probing.set(id, run);
    return run;
  }

  // --- entrega ---

  /**
   * O servidor pronto a entregar a uma sessão: só se foi aprovado e as ferramentas não mudaram.
   * Os segredos vêm do cofre agora e seguem só para o agente; aqui não ficam.
   */
  async launch(id: string): Promise<McpLaunch> {
    const stored = this.#find(id);
    const label = stored.spec.label;
    if (stored.approvedFingerprint !== fingerprint(stored.spec))
      throw new McpLaunchError(
        'needs-approval',
        `${label}: precisa de aprovação antes de arrancar`,
      );
    if (stored.pending)
      throw new McpLaunchError(
        'changed',
        `${label}: as ferramentas mudaram desde a aprovação. Aprova outra vez antes de o usar`,
      );
    const { env, values } = await this.#environment(stored);
    const resolved = this.#resolved(stored);
    if (!this.#verified.has(id) || stored.toolsHash === null) {
      const outcome = await this.#verify(id, resolved, env, values);
      if (outcome === 'changed')
        throw new McpLaunchError(
          'changed',
          `${label}: as ferramentas mudaram desde a aprovação. Aprova outra vez antes de o usar`,
        );
    }
    return {
      id,
      name: stored.name,
      command: resolved.command,
      args: resolved.args,
      env,
      executesCode: true,
    };
  }

  #allocate(label: string): string {
    const taken = new Set([
      'solline',
      ...this.#reserved(),
      ...this.#data.servers.map((s) => s.name),
    ]);
    const base = slug(label);
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const name = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
      if (!taken.has(name)) return name;
    }
    throw new Error('Não consegui escolher um nome para o servidor');
  }
}

/** O catálogo fixo e o do utilizador como um só, para o gestor de sessões. */
export function combinedCatalog(builtin: McpCatalog, user: UserMcpCatalog): McpCatalog {
  return {
    list: async () => [...(await builtin.list()), ...user.descriptors()],
    launch: (id) => (user.has(id) ? user.launch(id) : builtin.launch(id)),
    projectServers: (projectId) => user.projectServers(projectId),
  };
}
