import { z } from 'zod';
import { EnvKeyName } from './conversation.ts';
import { SECRET_MAX_LENGTH } from './secrets.ts';

/**
 * O catálogo global de servidores MCP: o utilizador acrescenta um servidor uma vez (do registo
 * oficial ou à mão), o main pede a aprovação exata, o motor guarda a impressão das ferramentas e
 * cada projeto escolhe quais usa. Nada aqui leva valores de segredos: esses vivem no cofre do
 * sistema (ver secrets.ts) e só passam pelo main.
 */

const Empty = z.object({}).strict();

export const MCP_MAX_ENV = 16;
export const MCP_MAX_ARGS = 24;
export const MCP_PROJECT_MAX = 8;

export const McpServerId = z.string().regex(/^[a-z0-9-]{1,32}$/);
export type McpServerId = z.infer<typeof McpServerId>;

const ProjectRef = z.string().min(1).max(128);

/**
 * Controlo (Cc, inclui as quebras de linha), formatação invisível (Cf: zero-width, marcas e
 * isolamentos bidi U+202A–202E e U+2066–2069, U+061C, hífen suave, etiquetas U+E0000–E007F) e
 * separadores de linha e parágrafo: nada disto entra em comandos nem em nomes, porque podia
 * reordenar ou esconder o que a confirmação mostra.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function hasHiddenChars(text: string): boolean {
  return HIDDEN.test(text);
}

/** Texto de uma linha, sem invisíveis, até `max` caracteres. */
const Line = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => !hasHiddenChars(text), 'Sem caracteres de controlo nem invisíveis');

/**
 * Variáveis que mudariam o que o servidor corre ou de onde se descarrega (o PATH, o NODE_OPTIONS,
 * o registo do npm, os índices do uv): nunca se declaram num servidor do catálogo.
 */
const RESERVED_ENV = new Set([
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'WINDIR',
  // As pastas do utilizador mudam de onde vêm o ~/.npmrc, o uv.toml e as caches.
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  // Certificados: um CA à escolha abre o descarregamento a quem estiver no meio.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
]);

/** Famílias inteiras: Node e npm, uv, pip e Python, git, o carregador dinâmico e as pastas XDG. */
const RESERVED_ENV_PREFIXES = ['NODE_', 'NPM_', 'UV_', 'PIP_', 'PYTHON', 'GIT_', 'LD_', 'DYLD_', 'XDG_'];

export function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_ENV.has(upper) || RESERVED_ENV_PREFIXES.some((p) => upper.startsWith(p));
}

export const McpEnvName = EnvKeyName.refine((name) => !isReservedEnvName(name), {
  message: 'Esta variável muda o que corre ou de onde se descarrega: não se declara',
});

/**
 * Uma variável de ambiente do servidor. Só as não secretas guardam o valor no catálogo; as
 * secretas guardam só o nome e o valor vai para o cofre do sistema.
 */
export const McpEnvDecl = z
  .object({
    name: McpEnvName,
    secret: z.boolean(),
    required: z.boolean(),
    value: Line(1000).optional(),
    description: Line(300).optional(),
  })
  .strict()
  .refine((env) => !(env.secret && env.value !== undefined), {
    message: 'Os segredos não levam valor no catálogo',
  });
export type McpEnvDecl = z.infer<typeof McpEnvDecl>;

const uniqueNames = (env: readonly { name: string }[]) =>
  new Set(env.map((e) => e.name)).size === env.length;

/**
 * De onde veio o servidor. registry: do registo oficial, com o espaço de nomes e quem o verificou
 * (o registo só aceita publicar com prova do dono: GitHub ou DNS).
 */
export const McpSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }).strict(),
  z
    .object({
      kind: z.literal('registry'),
      name: Line(200),
      version: Line(64),
      registryType: z.enum(['npm', 'pypi']),
      identifier: Line(200),
      verified: z.enum(['github', 'dns']).nullable(),
    })
    .strict(),
]);
export type McpSource = z.infer<typeof McpSource>;

/** O que a Solline arranca: comando, argumentos e variáveis. É isto que se aprova. */
export const McpServerSpec = z
  .object({
    label: Line(80).min(1),
    command: Line(300)
      .min(1)
      .refine((c) => !c.startsWith('-'), 'O comando não pode começar por -'),
    args: z.array(Line(300).min(1)).max(MCP_MAX_ARGS),
    env: z.array(McpEnvDecl).max(MCP_MAX_ENV).refine(uniqueNames, 'Variáveis repetidas'),
    source: McpSource,
  })
  .strict();
export type McpServerSpec = z.infer<typeof McpServerSpec>;

/** O que o utilizador escreve à mão: sem valores nem origem (os valores vão à parte). */
export const McpManualSpec = z
  .object({
    label: McpServerSpec.shape.label,
    command: McpServerSpec.shape.command,
    args: McpServerSpec.shape.args,
    env: z
      .array(
        z
          .object({
            name: McpEnvName,
            secret: z.boolean(),
            required: z.boolean(),
            description: Line(300).optional(),
          })
          .strict(),
      )
      .max(MCP_MAX_ENV)
      .refine(uniqueNames, 'Variáveis repetidas'),
  })
  .strict();
export type McpManualSpec = z.infer<typeof McpManualSpec>;

/** Acrescentar: do registo (só se diz qual; o motor volta a pedir os dados ao registo) ou à mão. */
export const McpAddSource = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('registry'), name: Line(200).min(1), version: Line(64).min(1) })
    .strict(),
  z.object({ kind: z.literal('manual'), spec: McpManualSpec }).strict(),
]);
export type McpAddSource = z.infer<typeof McpAddSource>;

/** Valores das variáveis, por nome. Os secretos vão para o cofre do main; os outros para o catálogo. */
export const McpValues = z.record(McpEnvName, z.string().min(1).max(SECRET_MAX_LENGTH));
export type McpValues = z.infer<typeof McpValues>;

/** Uma ferramenta como o servidor a anunciou (dado não confiável: só texto, com limite). */
export const McpToolInfo = z.object({ name: Line(128), description: Line(300) }).strict();
export type McpToolInfo = z.infer<typeof McpToolInfo>;

/**
 * needs-approval: ainda não foi aprovado, ou mudou o comando, os argumentos ou as variáveis ·
 * changed: as ferramentas mudaram desde a aprovação · error: a última sonda falhou · ready.
 */
export const McpCatalogStatus = z.enum(['needs-approval', 'ready', 'changed', 'error']);
export type McpCatalogStatus = z.infer<typeof McpCatalogStatus>;

export const McpToolChange = z
  .object({
    added: z.array(Line(128)).max(200),
    removed: z.array(Line(128)).max(200),
    /** Mesmo nome, descrição ou esquema diferentes. */
    altered: z.array(Line(128)).max(200),
    /** A impressão que o utilizador aprovaria. */
    hash: z.string().length(64),
  })
  .strict();
export type McpToolChange = z.infer<typeof McpToolChange>;

export const McpCatalogServer = z
  .object({
    id: McpServerId,
    /** O nome do servidor para o agente (as ferramentas ficam mcp__<name>__…). */
    name: z.string(),
    spec: McpServerSpec,
    /** O comando como será arrancado, para mostrar e aprovar. */
    commandLine: z.string(),
    /** Impressão do que se aprova (comando, argumentos e variáveis). */
    fingerprint: z.string().length(64),
    status: McpCatalogStatus,
    approved: z.boolean(),
    tools: z.array(McpToolInfo).nullable(),
    toolsHash: z.string().length(64).nullable(),
    probedAt: z.number().nullable(),
    changed: McpToolChange.nullable(),
    error: z.string().max(400).nullable(),
    createdAt: z.number(),
  })
  .strict();
export type McpCatalogServer = z.infer<typeof McpCatalogServer>;

export const McpCatalogState = z
  .object({
    servers: z.array(McpCatalogServer),
    /** Por projeto, os servidores (do catálogo) que entram em cada sessão nova. */
    projects: z.record(ProjectRef, z.array(McpServerId)),
  })
  .strict();
export type McpCatalogState = z.infer<typeof McpCatalogState>;

/** Um servidor do registo oficial que a Solline sabe arrancar (npm ou PyPI, com versão fixada). */
export const McpRegistryResult = z
  .object({
    name: Line(200),
    title: Line(120),
    description: Line(500),
    version: Line(64),
    /** O espaço de nomes (io.github.x, com.empresa) e como o registo verificou o dono. */
    namespace: Line(200),
    verified: z.enum(['github', 'dns']).nullable(),
    repository: Line(300).nullable(),
    registryType: z.enum(['npm', 'pypi']),
    identifier: Line(200),
    packageVersion: Line(64),
    /** Como a Solline o arrancaria (para mostrar antes de acrescentar). */
    commandLine: Line(2000),
    env: z
      .array(
        z
          .object({
            name: McpEnvName,
            secret: z.boolean(),
            required: z.boolean(),
            description: Line(300).optional(),
          })
          .strict(),
      )
      .max(MCP_MAX_ENV),
  })
  .strict();
export type McpRegistryResult = z.infer<typeof McpRegistryResult>;

export const McpSearchResult = z
  .object({
    results: z.array(McpRegistryResult).max(100),
    nextCursor: z.string().max(300).nullable(),
    /** Entradas do registo que ficaram de fora porque a Solline ainda não as arranca. */
    skipped: z.object({ remote: z.number().int(), other: z.number().int() }).strict(),
  })
  .strict();
export type McpSearchResult = z.infer<typeof McpSearchResult>;

const Id = z.object({ id: McpServerId }).strict();
const ServerResult = z.object({ server: McpCatalogServer }).strict();

export const mcpCommandSchemas = {
  /** O catálogo global, com o estado de cada servidor e a escolha de cada projeto (só lê). */
  'mcp.catalog': { payload: Empty, result: McpCatalogState },
  /** Pesquisa no registo oficial (só o texto pesquisado sai da máquina). */
  'mcp.search': {
    payload: z
      .object({
        query: z.string().trim().min(1).max(100),
        cursor: z.string().min(1).max(300).optional(),
      })
      .strict(),
    result: McpSearchResult,
  },
  /**
   * Acrescenta um servidor ao catálogo (main): os valores secretos vão para o Gestor de Credenciais
   * e nunca ao motor. O servidor fica por aprovar.
   */
  'mcp.add': {
    payload: z.object({ source: McpAddSource, values: McpValues }).strict(),
    result: ServerResult,
  },
  /** Muda um servidor feito à mão (main). Mudar o comando, os argumentos ou as variáveis volta a pedir aprovação. */
  'mcp.update': {
    payload: z.object({ id: McpServerId, spec: McpManualSpec, values: McpValues }).strict(),
    result: ServerResult,
  },
  /** Muda (ou, com null, tira) o valor de uma variável secreta (main). */
  'mcp.setSecret': {
    payload: z
      .object({
        id: McpServerId,
        name: McpEnvName,
        value: z.string().min(1).max(SECRET_MAX_LENGTH).nullable(),
      })
      .strict(),
    result: Empty,
  },
  /** Tira o servidor do catálogo e dos projetos, e apaga os segredos dele (main). */
  'mcp.remove': { payload: Id, result: z.object({ removed: z.boolean() }).strict() },
  /**
   * Aprova o servidor (main): confirmação nativa com o comando, os argumentos e os nomes das
   * variáveis exatos. approved é false se recusares.
   */
  'mcp.approve': {
    payload: Id,
    result: z.object({ server: McpCatalogServer, approved: z.boolean() }).strict(),
  },
  /** Arranca o servidor uma vez e guarda as ferramentas; se mudaram, fica a pedir nova aprovação. */
  'mcp.probe': { payload: Id, result: ServerResult },
  /** Quais servidores do catálogo entram em cada sessão nova do projeto. */
  'mcp.setProject': {
    payload: z
      .object({ projectId: ProjectRef, serverIds: z.array(McpServerId).max(MCP_PROJECT_MAX) })
      .strict(),
    result: McpCatalogState,
  },
} as const;

/** Só o main os manda ao motor: a aprovação e o que escreve no catálogo. */
export const mcpInternalSchemas = {
  /** Os dados do servidor tal como ficariam (do registo ou à mão), sem os guardar. */
  'mcp.draft': {
    payload: z.object({ source: McpAddSource }).strict(),
    result: z.object({ spec: McpServerSpec }).strict(),
  },
  'mcp.get': { payload: Id, result: ServerResult },
  'mcp.addNow': {
    payload: z.object({ id: McpServerId, spec: McpServerSpec }).strict(),
    result: ServerResult,
  },
  'mcp.updateNow': {
    payload: z.object({ id: McpServerId, spec: McpServerSpec }).strict(),
    result: ServerResult,
  },
  /**
   * O utilizador aprovou (o main mostrou a confirmação): só vale se a impressão ainda é a que ele
   * viu; depois da aprovação o motor arranca o servidor uma vez.
   */
  'mcp.approveNow': {
    payload: z
      .object({
        id: McpServerId,
        fingerprint: z.string().length(64),
        /** Se as ferramentas tinham mudado: a impressão que ele viu. */
        toolsHash: z.string().length(64).optional(),
      })
      .strict(),
    result: z.object({ server: McpCatalogServer, approved: z.boolean() }).strict(),
  },
  'mcp.removeNow': { payload: Id, result: z.object({ removed: z.boolean() }).strict() },
} as const;
