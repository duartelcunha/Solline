import { z } from 'zod';
import {
  AgentCapabilities,
  AgentDescriptor,
  AgentId,
  EnvKeyName,
  McpServerDescriptor,
  PermissionAnswer,
  Orphan,
  SessionInfo,
  WorktreeStats,
} from './conversation.ts';
import { qualityCommandSchemas } from './quality.ts';
import { CheckList, CheckSpec, SetupSpec, checksCommandSchemas } from './checks.ts';
import { reviewCommandSchemas } from './review.ts';

/**
 * Contrato dos comandos da Ponte: interface -> main -> motor.
 * Cada comando tem um payload e um resultado validados com zod nos dois lados.
 * Os comandos projects.* ficam no main (pasta de dados, seletor de pastas); os outros vão
 * para o motor.
 */

export const PingPayload = z.object({}).strict();
export const PingResult = z.object({
  pong: z.literal(true),
  engineVersion: z.string(),
  pid: z.number().int(),
  receivedAt: z.number(),
});

const Empty = z.object({}).strict();
const SessionRef = z.object({ sessionId: z.string().min(1) }).strict();
const AgentRef = z.object({ agent: AgentId }).strict();
/** As variáveis que um agente recebe: só nomes, sem repetidos. */
const EnvKeys = z
  .array(EnvKeyName)
  .max(32)
  .refine((keys) => new Set(keys.map((k) => k.toUpperCase())).size === keys.length, {
    message: 'Nomes repetidos',
  });

export const Project = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  addedAt: z.number(),
  /**
   * Sem confiança, os agentes não leem as definições, hooks, MCP nem instruções do projeto
   * (no Claude, o .claude/ e o CLAUDE.md da pasta) e "Permitir sempre" só vale na sessão.
   */
  trusted: z.boolean(),
  /** As verificações guardadas; sem elas, valem as que a Solline encontra no package.json. */
  checks: CheckList.nullable().optional(),
  /** Como preparar uma worktree nova; sem isto, vale a sugestão da Solline. */
  setup: SetupSpec.nullable().optional(),
});
export type Project = z.infer<typeof Project>;

/** Texto de uma mensagem: limite largo, só para a interface não conseguir encher o motor. */
const MessageText = z.string().min(1).max(200_000);

/**
 * Pedido da interface para abrir uma sessão. A interface só manda ids: a pasta vem do
 * projeto, resolvida no main (session-policy.ts). Sem modo, vale o modo por omissão do agente.
 */
export const SessionCreatePayload = z
  .object({
    projectId: z.string().min(1).max(64),
    agent: AgentId,
    mode: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(200).optional(),
    effort: z.string().min(1).max(32).optional(),
    /** Servidores MCP do catálogo a ligar só a esta sessão. */
    mcpServerIds: z.array(z.string().min(1).max(32)).max(8).optional(),
  })
  .strict();

/** main -> motor: o mesmo pedido já com a pasta e a confiança do projeto. A interface nunca o manda. */
export const SessionStartPayload = SessionCreatePayload.extend({
  cwd: z.string().min(1),
  trusted: z.boolean(),
  checks: CheckList.nullable().optional(),
  setup: SetupSpec.nullable().optional(),
}).strict();
export type SessionStartPayload = z.infer<typeof SessionStartPayload>;

export const SessionCreateResult = z.object({
  session: SessionInfo,
  capabilities: AgentCapabilities,
});

export const commandSchemas = {
  'engine.ping': { payload: PingPayload, result: PingResult },
  /**
   * Os agentes que o motor conhece e o estado de cada um nesta máquina. refresh volta a
   * verificar o que o motor guardou (por exemplo se o Codex tem sessão iniciada).
   */
  'agents.list': {
    payload: z.object({ refresh: z.boolean().optional() }).strict(),
    result: z.object({ agents: z.array(AgentDescriptor) }),
  },
  /**
   * Entrar no agente dentro da app (main): o motor arranca o login e o main abre o endereço
   * no browser se for de confiança. Acaba com um agents.changed.
   */
  'agents.login': { payload: AgentRef, result: Empty },
  /** Desiste de um login a meio. */
  'agents.loginCancel': { payload: AgentRef, result: Empty },
  /**
   * Escolher as variáveis de ambiente que um agente recebe (main): pede confirmação nativa e
   * só guarda se aceitares. saved é false se recusares.
   */
  'agents.setKeys': {
    payload: AgentRef.extend({ keys: EnvKeys }).strict(),
    result: z.object({ saved: z.boolean() }),
  },
  /** Nomes de variáveis do ambiente da Solline que parecem segredos (só nomes, para escolher). */
  'agents.keyCandidates': { payload: Empty, result: z.object({ names: z.array(EnvKeyName) }) },
  /** Os servidores MCP do catálogo e o estado de cada um. */
  'mcp.list': { payload: Empty, result: z.object({ servers: z.array(McpServerDescriptor) }) },
  'session.create': { payload: SessionCreatePayload, result: SessionCreateResult },
  /**
   * Manda uma mensagem. Com o agente parado segue logo; ocupado, vai para a fila (how: queue,
   * por omissão) ou guia o turno que corre (how: now, só onde features.steer). turnId é o turno
   * novo, o item da fila ou o turno guiado, conforme `how` devolvido.
   */
  'session.send': {
    payload: SessionRef.extend({
      text: MessageText,
      how: z.enum(['queue', 'now']).optional(),
    }).strict(),
    result: z.object({ turnId: z.string(), how: z.enum(['sent', 'queued', 'steered']) }),
  },
  /** Tira uma mensagem da fila. */
  'session.unqueue': {
    payload: SessionRef.extend({ id: z.string().min(1).max(64) }).strict(),
    /** removed: false se a mensagem já tinha seguido. */
    result: z.object({ removed: z.boolean() }),
  },
  /** Muda a ordem da fila (todos os ids, pela ordem nova). */
  'session.reorder': {
    payload: SessionRef.extend({ ids: z.array(z.string().min(1).max(64)).max(50) }).strict(),
    result: Empty,
  },
  /** Retoma a fila depois de interromper. */
  'session.resumeQueue': { payload: SessionRef, result: Empty },
  'session.interrupt': { payload: SessionRef, result: Empty },
  /** Volta a abrir uma sessão que caiu, com o mesmo histórico (resume do agente). */
  'session.resume': { payload: SessionRef, result: SessionCreateResult },
  'session.setMode': {
    payload: SessionRef.extend({ mode: z.string().min(1) }).strict(),
    result: Empty,
  },
  'session.setModel': {
    payload: SessionRef.extend({ model: z.string().min(1) }).strict(),
    result: Empty,
  },
  'session.setEffort': {
    payload: SessionRef.extend({ effort: z.string().min(1) }).strict(),
    result: Empty,
  },
  /**
   * Traz o trabalho da worktree da sessão para o branch atual do projeto (merge). Com
   * conflitos, nada muda no projeto e vem a lista dos ficheiros.
   */
  'session.bring': {
    payload: SessionRef,
    result: z.object({ merged: z.boolean(), conflicts: z.array(z.string()), into: z.string() }),
  },
  /**
   * Fecha a sessão. Numa worktree com mudanças por trazer, sem escolha não fecha e devolve os
   * +/−: bring traz primeiro, keep guarda o branch, discard deita tudo fora.
   */
  'session.close': {
    payload: SessionRef.extend({
      worktree: z.enum(['bring', 'keep', 'discard']).optional(),
      /** Fecha mesmo com mensagens na fila (deitam-se fora). */
      dropQueue: z.boolean().optional(),
    }).strict(),
    result: z.object({
      closed: z.boolean(),
      /** Não fechou: há estas mensagens na fila. */
      queued: z.number().int().optional(),
      stats: WorktreeStats.optional(),
      conflicts: z.array(z.string()).optional(),
      into: z.string().optional(),
    }),
  },
  /** As worktrees no disco que nenhuma sessão aberta usa. */
  'worktrees.list': { payload: Empty, result: z.object({ orphans: z.array(Orphan) }) },
  /** Traz uma worktree órfã para o projeto (merge); com conflitos, nada muda. */
  'worktrees.bring': {
    payload: z.object({ id: z.string().min(1).max(128) }).strict(),
    result: z.object({ merged: z.boolean(), conflicts: z.array(z.string()), into: z.string() }),
  },
  /** Deita fora uma worktree órfã e o seu branch. */
  'worktrees.discard': {
    payload: z.object({ id: z.string().min(1).max(128) }).strict(),
    result: Empty,
  },
  'permission.answer': {
    payload: SessionRef.extend({ requestId: z.string().min(1), answer: PermissionAnswer }).strict(),
    result: Empty,
  },
  'projects.list': { payload: Empty, result: z.object({ projects: z.array(Project) }) },
  /** Abre o seletor de pastas nativo; project é null se cancelares. */
  'projects.add': { payload: Empty, result: z.object({ project: Project.nullable() }) },
  /** Ligar a confiança pede confirmação nativa; project volta igual se a recusares. */
  'projects.setTrusted': {
    payload: z.object({ projectId: z.string().min(1).max(64), trusted: z.boolean() }).strict(),
    result: z.object({ project: Project }),
  },
  /**
   * Guarda as verificações de um projeto (null: volta às do package.json). Um comando novo ou
   * mudado pede confirmação nativa; project volta igual se a recusares.
   */
  'projects.setChecks': {
    payload: z
      .object({ projectId: z.string().min(1).max(64), checks: CheckList.nullable() })
      .strict(),
    result: z.object({ project: Project }),
  },
  /**
   * Guarda como se preparam as worktrees do projeto (null: volta à sugestão). Um comando novo
   * pede confirmação nativa; project volta igual se a recusares.
   */
  'projects.setSetup': {
    payload: z
      .object({ projectId: z.string().min(1).max(64), setup: SetupSpec.nullable() })
      .strict(),
    result: z.object({ project: Project }),
  },
  /** Volta a preparar a worktree da sessão (depois de uma falha). */
  'setup.retry': { payload: SessionRef, result: Empty },
  ...reviewCommandSchemas,
  ...qualityCommandSchemas,
  ...checksCommandSchemas,
} as const;

/**
 * Comandos que o main trata. O session.create passa por aqui para o main trocar o projeto
 * pela pasta e só depois chamar o motor com session.start.
 */
export const MAIN_COMMANDS = [
  'agents.login',
  'agents.setKeys',
  'projects.list',
  'projects.add',
  'projects.setTrusted',
  'projects.setChecks',
  'projects.setSetup',
  'session.create',
] as const satisfies CommandName[];
export type MainCommandName = (typeof MAIN_COMMANDS)[number];
export function isMainCommand(command: CommandName): command is MainCommandName {
  return (MAIN_COMMANDS as readonly string[]).includes(command);
}

export type CommandName = keyof typeof commandSchemas;
export const commandNames = Object.keys(commandSchemas) as CommandName[];

export type CommandPayload<C extends CommandName> = z.infer<(typeof commandSchemas)[C]['payload']>;
export type CommandResult<C extends CommandName> = z.infer<(typeof commandSchemas)[C]['result']>;

export const CommandNameSchema = z.enum(commandNames as [CommandName, ...CommandName[]]);

/**
 * Comandos que só o main manda ao motor. Não estão no CommandNameSchema, por isso nenhum
 * pedido da interface os consegue nomear.
 */
export const internalCommandSchemas = {
  'session.start': { payload: SessionStartPayload, result: SessionCreateResult },
  /** Arranca o login de um agente e devolve o endereço que o main vai abrir no browser. */
  'agents.loginStart': {
    payload: AgentRef,
    result: z.object({ url: z.url({ protocol: /^https$/ }) }),
  },
  /** O nome e as variáveis guardadas de um agente que deixa escolher (para a confirmação). */
  'agents.keys': {
    payload: AgentRef,
    result: z.object({ label: z.string(), keys: z.array(EnvKeyName) }),
  },
  /** Guarda as variáveis escolhidas para um agente (o main já pediu confirmação). */
  'agents.saveKeys': { payload: AgentRef.extend({ keys: EnvKeys }).strict(), result: Empty },
  /** A confiança de um projeto mudou: as próximas retomas das suas sessões usam a nova. */
  'projects.trustChanged': {
    payload: z.object({ projectId: z.string().min(1).max(64), trusted: z.boolean() }).strict(),
    result: Empty,
  },
  /** As verificações que a Solline encontra no package.json de uma pasta (para comparar). */
  'projects.detectChecks': {
    payload: z.object({ cwd: z.string().min(1) }).strict(),
    result: z.object({ checks: z.array(CheckSpec) }),
  },
  /** A sugestão de preparação para uma pasta (para comparar e para mostrar). */
  'projects.detectSetup': {
    payload: z.object({ cwd: z.string().min(1) }).strict(),
    result: z.object({ setup: SetupSpec }),
  },
  /** A preparação de um projeto mudou (o main já pediu confirmação). */
  'projects.setupChanged': {
    payload: z
      .object({ projectId: z.string().min(1).max(64), setup: SetupSpec.nullable() })
      .strict(),
    result: Empty,
  },
  /** As verificações de um projeto mudaram (o main já pediu confirmação). */
  'projects.checksChanged': {
    payload: z
      .object({ projectId: z.string().min(1).max(64), checks: CheckList.nullable() })
      .strict(),
    result: Empty,
  },
} as const;

type EngineSchemas = Omit<typeof commandSchemas, MainCommandName> & typeof internalCommandSchemas;
export type EngineCommandName = keyof EngineSchemas;

/** Os comandos que o motor aceita: os da interface que não são do main, mais os internos. */
export const engineCommandSchemas: EngineSchemas = {
  ...(Object.fromEntries(
    Object.entries(commandSchemas).filter(([name]) => !isMainCommand(name as CommandName)),
  ) as Omit<typeof commandSchemas, MainCommandName>),
  ...internalCommandSchemas,
};
export const engineCommandNames = Object.keys(engineCommandSchemas) as EngineCommandName[];

export type EngineCommandPayload<C extends EngineCommandName> = z.infer<
  EngineSchemas[C]['payload']
>;
export type EngineCommandResult<C extends EngineCommandName> = z.infer<EngineSchemas[C]['result']>;

/** Pedido que viaja pela MessagePort entre main e motor. */
export const RequestEnvelope = z.object({
  kind: z.literal('request'),
  id: z.string().min(1),
  command: z.enum(engineCommandNames as [EngineCommandName, ...EngineCommandName[]]),
  payload: z.unknown(),
});
export type RequestEnvelope = z.infer<typeof RequestEnvelope>;

export const ResponseEnvelope = z.discriminatedUnion('ok', [
  z.object({
    kind: z.literal('response'),
    id: z.string(),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal('response'),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ message: z.string() }),
  }),
]);
export type ResponseEnvelope = z.infer<typeof ResponseEnvelope>;
