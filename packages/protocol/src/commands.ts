import { z } from 'zod';
import { AgentCapabilities, AgentKind, PermissionAnswer, SessionInfo } from './conversation.ts';

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

export const Project = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  addedAt: z.number(),
});
export type Project = z.infer<typeof Project>;

export const SessionCreatePayload = z
  .object({
    agent: AgentKind,
    cwd: z.string().min(1),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    mode: z.string().min(1),
  })
  .strict();

export const SessionCreateResult = z.object({
  session: SessionInfo,
  capabilities: AgentCapabilities,
});

export const commandSchemas = {
  'engine.ping': { payload: PingPayload, result: PingResult },
  'session.create': { payload: SessionCreatePayload, result: SessionCreateResult },
  'session.send': {
    payload: SessionRef.extend({ text: z.string().min(1) }).strict(),
    result: z.object({ turnId: z.string() }),
  },
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
  'permission.answer': {
    payload: SessionRef.extend({ requestId: z.string().min(1), answer: PermissionAnswer }).strict(),
    result: Empty,
  },
  'projects.list': { payload: Empty, result: z.object({ projects: z.array(Project) }) },
  /** Abre o seletor de pastas nativo; project é null se cancelares. */
  'projects.add': { payload: Empty, result: z.object({ project: Project.nullable() }) },
} as const;

/** Comandos que o main trata sem passar pelo motor. */
export const MAIN_COMMANDS = ['projects.list', 'projects.add'] as const satisfies CommandName[];
export type MainCommandName = (typeof MAIN_COMMANDS)[number];
export type EngineCommandName = Exclude<CommandName, MainCommandName>;
export function isMainCommand(command: CommandName): command is MainCommandName {
  return (MAIN_COMMANDS as readonly string[]).includes(command);
}

export type CommandName = keyof typeof commandSchemas;
export const commandNames = Object.keys(commandSchemas) as CommandName[];

export type CommandPayload<C extends CommandName> = z.infer<(typeof commandSchemas)[C]['payload']>;
export type CommandResult<C extends CommandName> = z.infer<(typeof commandSchemas)[C]['result']>;

export const CommandNameSchema = z.enum(commandNames as [CommandName, ...CommandName[]]);

/** Pedido que viaja pela MessagePort entre main e motor. */
export const RequestEnvelope = z.object({
  kind: z.literal('request'),
  id: z.string().min(1),
  command: CommandNameSchema,
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
