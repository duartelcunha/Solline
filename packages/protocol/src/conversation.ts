import { z } from 'zod';

/**
 * Modelo de conversa normalizado. Fala de agentes, não de Claude: cada provider tem um
 * adaptador no motor que traduz as mensagens dele para estes blocos. A interface só
 * conhece isto.
 */

export const AgentKind = z.enum(['claude']);
export type AgentKind = z.infer<typeof AgentKind>;

/** starting: a arrancar o agente · error: o processo do agente caiu (dá para retomar). */
export const SessionState = z.enum(['starting', 'idle', 'running', 'needs-you', 'error']);
export type SessionState = z.infer<typeof SessionState>;

export const ToolState = z.enum(['running', 'ok', 'error']);
export type ToolState = z.infer<typeof ToolState>;

/** Estado de qualquer pedido que espera por ti (permissão, plano ou pergunta). */
export const AskStatus = z.enum(['pending', 'allowed', 'allowed-always', 'denied', 'cancelled']);
export type AskStatus = z.infer<typeof AskStatus>;

export const TextBlock = z.object({
  kind: z.literal('text'),
  id: z.string(),
  text: z.string(),
  parentToolId: z.string().nullable(),
});

export const ThinkingBlock = z.object({
  kind: z.literal('thinking'),
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
  parentToolId: z.string().nullable(),
});

export const ToolBlock = z.object({
  kind: z.literal('tool'),
  /** O id da chamada no agente (tool_use_id no Claude). */
  id: z.string(),
  name: z.string(),
  /** Uma linha legível: "Ler notes.txt", "Correr npm test". */
  summary: z.string(),
  input: z.unknown(),
  /** Texto devolvido ao modelo. */
  output: z.string().optional(),
  /** Resultado estruturado da ferramenta, quando o agente o dá (diffs, ficheiros). */
  result: z.unknown().optional(),
  state: ToolState,
  parentToolId: z.string().nullable(),
});

export const PermissionBlock = z.object({
  kind: z.literal('permission'),
  /** Id do pedido; é o que volta em permission.answer. */
  id: z.string(),
  toolName: z.string(),
  toolUseId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  input: z.unknown(),
  /** false quando o agente não deixa gravar uma regra ("sempre") para este pedido. */
  canAlwaysAllow: z.boolean(),
  /** O cartão abre no "Negar" e não aceita aprovação com uma tecla. */
  defaultToNo: z.boolean(),
  status: AskStatus,
});

export const PlanBlock = z.object({
  kind: z.literal('plan'),
  id: z.string(),
  plan: z.string(),
  status: AskStatus,
});

export const QuestionOption = z.object({ label: z.string(), description: z.string() });
export const Question = z.object({
  question: z.string(),
  header: z.string(),
  multiSelect: z.boolean(),
  options: z.array(QuestionOption),
});
export type Question = z.infer<typeof Question>;

export const QuestionBlock = z.object({
  kind: z.literal('question'),
  id: z.string(),
  questions: z.array(Question),
  answers: z.record(z.string(), z.string()).optional(),
  status: AskStatus,
});

export const NoticeBlock = z.object({
  kind: z.literal('notice'),
  id: z.string(),
  tone: z.enum(['info', 'error']),
  text: z.string(),
});

export const Block = z.discriminatedUnion('kind', [
  TextBlock,
  ThinkingBlock,
  ToolBlock,
  PermissionBlock,
  PlanBlock,
  QuestionBlock,
  NoticeBlock,
]);
export type Block = z.infer<typeof Block>;
export type TextBlock = z.infer<typeof TextBlock>;
export type ThinkingBlock = z.infer<typeof ThinkingBlock>;
export type ToolBlock = z.infer<typeof ToolBlock>;
export type PermissionBlock = z.infer<typeof PermissionBlock>;
export type PlanBlock = z.infer<typeof PlanBlock>;
export type QuestionBlock = z.infer<typeof QuestionBlock>;
export type NoticeBlock = z.infer<typeof NoticeBlock>;

/** Pedidos que param o agente até haver resposta. */
export const AskBlock = z.discriminatedUnion('kind', [PermissionBlock, PlanBlock, QuestionBlock]);
export type AskBlock = z.infer<typeof AskBlock>;

export const Turn = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  blocks: z.array(Block),
  startedAt: z.number(),
});
export type Turn = z.infer<typeof Turn>;

export const ModelUsageRow = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
});

export const ContextUsage = z.object({
  usedTokens: z.number(),
  maxTokens: z.number(),
  percent: z.number(),
});
export type ContextUsage = z.infer<typeof ContextUsage>;

/**
 * Custo e contexto. O custo é o último total que o agente reportou (já acumulado);
 * nunca se soma na interface.
 */
export const Usage = z.object({
  costUsd: z.number().nullable(),
  models: z.array(ModelUsageRow),
  context: ContextUsage.nullable(),
});
export type Usage = z.infer<typeof Usage>;

/** Modelo, effort e modo em uso. A verdade vem do agente, não do pedido. */
export const SessionSettings = z.object({
  model: z.string().nullable(),
  effort: z.string().nullable(),
  mode: z.string(),
});
export type SessionSettings = z.infer<typeof SessionSettings>;

export const ModelOption = z.object({
  id: z.string(),
  /** Id canónico a que o alias resolve (por exemplo haiku -> claude-haiku-5-5). */
  resolved: z.string().nullable(),
  label: z.string(),
  description: z.string(),
  efforts: z.array(z.string()),
});
export type ModelOption = z.infer<typeof ModelOption>;

export const ModeOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
});
export type ModeOption = z.infer<typeof ModeOption>;

/** O que este agente sabe fazer. A interface mostra só o que existe aqui. */
export const AgentCapabilities = z.object({
  models: z.array(ModelOption),
  modes: z.array(ModeOption),
  effort: z.boolean(),
  interrupt: z.boolean(),
  resume: z.boolean(),
  cost: z.boolean(),
  context: z.boolean(),
  thinking: z.boolean(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;

export const SessionInfo = z.object({
  id: z.string(),
  agent: AgentKind,
  cwd: z.string(),
  title: z.string(),
  createdAt: z.number(),
  state: SessionState,
  settings: SessionSettings,
  /** Id da sessão no agente (serve para retomar). */
  agentSessionId: z.string().nullable(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

/**
 * Deltas da conversa. Cada um é pequeno e idempotente: block.upsert substitui o bloco
 * inteiro; block.append só acrescenta texto a um bloco de texto ou thinking.
 */
export const ConversationDelta = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn.start'), turn: Turn }),
  z.object({ type: z.literal('block.upsert'), turnId: z.string(), block: Block }),
  z.object({
    type: z.literal('block.append'),
    turnId: z.string(),
    blockId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('turn.end'),
    turnId: z.string(),
    outcome: z.enum(['done', 'interrupted', 'error']),
  }),
  z.object({ type: z.literal('usage'), usage: Usage.partial() }),
  z.object({ type: z.literal('settings'), settings: SessionSettings.partial() }),
  z.object({ type: z.literal('meta'), agentSessionId: z.string() }),
]);
export type ConversationDelta = z.infer<typeof ConversationDelta>;

/** Resposta da interface a um pedido. */
export const PermissionAnswer = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow-once') }),
  z.object({ decision: z.literal('allow-always') }),
  z.object({ decision: z.literal('deny'), message: z.string().optional() }),
  z.object({ decision: z.literal('answer'), answers: z.record(z.string(), z.string()) }),
]);
export type PermissionAnswer = z.infer<typeof PermissionAnswer>;
