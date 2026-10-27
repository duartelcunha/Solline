import { z } from 'zod';

/**
 * Modelo de conversa normalizado. Fala de agentes, não de Claude: cada provider tem um
 * adaptador no motor que traduz as mensagens dele para estes blocos. A interface só
 * conhece isto.
 */

/** Id de um agente no registo do motor: claude, codex, opencode… */
export const AgentId = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/);
export type AgentId = z.infer<typeof AgentId>;

/** starting: a arrancar o agente · error: o processo do agente caiu (dá para retomar). */
export const SessionState = z.enum(['starting', 'idle', 'running', 'needs-you', 'error']);
export type SessionState = z.infer<typeof SessionState>;

export const ToolState = z.enum(['running', 'ok', 'error']);
export type ToolState = z.infer<typeof ToolState>;

/** Estado de qualquer pedido que espera por ti (permissão, plano ou pergunta). */
export const AskStatus = z.enum([
  'pending',
  'allowed',
  'allowed-always',
  'denied',
  'denied-always',
  'cancelled',
]);
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

/** O que a ferramenta faz, igual ao ToolKind do ACP. A interface desenha por aqui, não pelo nome. */
export const ToolCategory = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);
export type ToolCategory = z.infer<typeof ToolCategory>;

/** Conteúdo estruturado de uma ferramenta: diffs, patches e comandos sem depender do agente. */
export const ToolContent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  /** oldText null: ficheiro novo. */
  z.object({
    type: z.literal('diff'),
    path: z.string(),
    oldText: z.string().nullable(),
    newText: z.string(),
  }),
  z.object({ type: z.literal('patch'), path: z.string(), unified: z.string() }),
  z.object({ type: z.literal('command'), command: z.string(), cwd: z.string().optional() }),
]);
export type ToolContent = z.infer<typeof ToolContent>;

export const ToolLocation = z.object({ path: z.string(), line: z.number().optional() });

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
  state: ToolState,
  parentToolId: z.string().nullable(),
  category: ToolCategory.optional(),
  /** Ficheiros em que a ferramenta mexe (para seguir na interface). */
  locations: z.array(ToolLocation).optional(),
  content: z.array(ToolContent).optional(),
  /** Já aparece de outra forma (cartão, lista de tarefas): não se desenha como ferramenta. */
  hidden: z.boolean().optional(),
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
  /** Onde fica o "sempre": só nesta sessão ou gravado. Sem valor, é o que o agente sugerir. */
  alwaysScope: z.enum(['session', 'persistent']).optional(),
  /** O cartão abre no "Negar" e não aceita aprovação com uma tecla. */
  defaultToNo: z.boolean(),
  /** O agente aceita recusar para sempre (regra gravada do lado dele). */
  canAlwaysDeny: z.boolean().optional(),
  /** Os nomes que o agente dá às opções "sempre" (o âmbito é dele). */
  allowAlwaysLabel: z.string().optional(),
  denyAlwaysLabel: z.string().optional(),
  category: ToolCategory.optional(),
  content: z.array(ToolContent).optional(),
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

/** A lista de tarefas do agente; cada atualização substitui a lista toda. */
export const TodoBlock = z.object({
  kind: z.literal('todo'),
  id: z.string(),
  entries: z.array(
    z.object({
      id: z.string().optional(),
      content: z.string(),
      status: z.enum(['pending', 'in_progress', 'completed']),
      priority: z.enum(['high', 'medium', 'low']).optional(),
    }),
  ),
});

export const NoticeBlock = z.object({
  kind: z.literal('notice'),
  id: z.string(),
  tone: z.enum(['info', 'error']),
  text: z.string(),
});

/**
 * Uma mensagem tua que guiou o agente a meio do turno: fica no sítio onde a mandaste, "à espera"
 * até o agente a ler na próxima pausa (o fim de uma ferramenta), e depois "lida".
 */
export const SteerBlock = z.object({
  kind: z.literal('steer'),
  id: z.string(),
  text: z.string(),
  status: z.enum(['waiting', 'absorbed']),
});

export const Block = z.discriminatedUnion('kind', [
  TextBlock,
  ThinkingBlock,
  SteerBlock,
  ToolBlock,
  PermissionBlock,
  PlanBlock,
  QuestionBlock,
  TodoBlock,
  NoticeBlock,
]);
export type Block = z.infer<typeof Block>;
export type TodoBlock = z.infer<typeof TodoBlock>;
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
});
export type Turn = z.infer<typeof Turn>;

export const ModelUsageRow = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
});

/** Tokens da sessão: o último total que o agente reportou, como o custo. */
export const TokenUsage = z.object({
  input: z.number(),
  output: z.number(),
  cachedInput: z.number().optional(),
  reasoning: z.number().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

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
  tokens: TokenUsage.nullable(),
});
export type Usage = z.infer<typeof Usage>;

/** Modelo, effort e modo em uso. A verdade vem do agente, não do pedido. */
export const SessionSettings = z.object({
  model: z.string().nullable(),
  effort: z.string().nullable(),
  /** null nos agentes sem modos. */
  mode: z.string().nullable(),
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

/**
 * Quanto um modo deixa o agente fazer sem perguntar, do mais fechado ao mais aberto.
 * A interface escolhe o ícone por aqui e nunca pelo id, que é de cada agente.
 */
export const ModeRisk = z.enum(['read-only', 'plan', 'ask', 'edits', 'auto', 'full']);
export type ModeRisk = z.infer<typeof ModeRisk>;

export const ModeOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  risk: ModeRisk,
});
export type ModeOption = z.infer<typeof ModeOption>;

/** O que o agente reporta: a interface só mostra custo, contexto e "Retomar" quando existem. */
export const AgentFeatures = z.object({
  cost: z.boolean(),
  context: z.boolean(),
  resume: z.boolean(),
  /** Rebobina a conversa no próprio agente; sem isto, rebobinar abre uma sessão nova com resumo. */
  rewind: z.boolean(),
  /** Aceita uma mensagem a meio do turno ("Agora"); sem isto, só há fila. */
  steer: z.boolean().optional(),
  /** A sessão tem as ferramentas da Solline (o servidor MCP "solline"); a interface só as mostra se existirem. */
  brain: z.boolean().optional(),
});
export type AgentFeatures = z.infer<typeof AgentFeatures>;

/** O que este agente sabe fazer. A interface mostra só o que existe aqui. */
export const AgentCapabilities = z.object({
  models: z.array(ModelOption),
  modes: z.array(ModeOption),
  effort: z.boolean(),
  /** Ordem dos níveis de effort deste agente, do mais leve ao mais pesado. */
  effortOrder: z.array(z.string()),
  features: AgentFeatures,
});
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;

/** Nome de uma variável de ambiente (só o nome; o valor nunca sai do motor). */
export const EnvKeyName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
export type EnvKeyName = z.infer<typeof EnvKeyName>;

/** Como o motor fala com o agente. */
export const AgentTransport = z.enum(['claude-sdk', 'codex-app-server', 'acp']);

/**
 * Um agente que a Solline conhece, com o estado nesta máquina. Vem do registo do motor
 * (agents.list); a interface usa-o para o seletor e para o nome do agente.
 */
export const AgentDescriptor = z.object({
  id: AgentId,
  label: z.string(),
  transport: AgentTransport,
  status: z.enum(['ready', 'not-found', 'needs-login', 'needs-key', 'unreviewed', 'error']),
  /** Porque não está pronto, numa frase. */
  detail: z.string().optional(),
  experimental: z.boolean(),
  untrustedProjects: z.enum(['allowed', 'refused']),
  /** Aceita servidores MCP por sessão. */
  mcp: z.boolean().optional(),
  /** Versão instalada e a que foi revista, nos agentes que se instalam à parte. */
  version: z.object({ installed: z.string().nullable(), reviewed: z.string() }).optional(),
  /** O agente sabe entrar dentro da app (por exemplo "Entrar com ChatGPT"). */
  login: z.object({ label: z.string(), pending: z.boolean() }).optional(),
  /**
   * Agentes que só recebem as variáveis que escolhes: os nomes escolhidos (nunca os valores).
   * Sem o campo, o agente não deixa escolher.
   */
  keys: z.array(EnvKeyName).optional(),
});
export type AgentDescriptor = z.infer<typeof AgentDescriptor>;

/** Um servidor MCP que se pode ligar a uma sessão nova (catálogo revisto no motor). */
export const McpServerDescriptor = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['ready', 'not-found', 'unreviewed']),
  detail: z.string().optional(),
  /** Corre programas ou alvos: sem Auto e sem "Permitir sempre" nas ferramentas dele. */
  executesCode: z.boolean(),
});
export type McpServerDescriptor = z.infer<typeof McpServerDescriptor>;

/** O que uma sessão mudou na sua worktree, face à base. */
export const WorktreeStats = z.object({
  files: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type WorktreeStats = z.infer<typeof WorktreeStats>;

/**
 * Onde a sessão trabalha. project: na pasta do projeto · shared: na pasta do projeto, ao mesmo
 * tempo que outra (projeto sem git) · worktree: numa worktree com branch próprio.
 */
export const Workspace = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }),
  z.object({ kind: z.literal('shared') }),
  z.object({ kind: z.literal('worktree'), branch: z.string(), stats: WorktreeStats }),
]);
export type Workspace = z.infer<typeof Workspace>;

/** Uma worktree que ficou no disco sem sessão aberta (a app fechou antes de a trazer). */
export const Orphan = z.object({
  /** projectId/sufixo: o motor resolve-o contra a lista, a interface nunca nomeia pastas. */
  id: z.string(),
  projectId: z.string(),
  branch: z.string(),
  stats: WorktreeStats,
});
export type Orphan = z.infer<typeof Orphan>;

/**
 * De onde veio a sessão. Só ids, nunca conteúdo: handoff e fork partem de outra sessão (e de um
 * turno), lane e part de uma corrida (a parte, da sessão que lhe entregou o resultado), task de
 * uma tarefa dos Espaços. ask e delegate partem da sessão de um agente que perguntou a outro
 * (a consulta, só de leitura) ou lhe entregou uma tarefa (uma sessão nova numa worktree).
 */
export const SessionOrigin = z
  .object({
    kind: z.enum(['handoff', 'fork', 'lane', 'part', 'task', 'ask', 'delegate']),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
    raceId: z.string().optional(),
    taskId: z.string().optional(),
  })
  .strict();
export type SessionOrigin = z.infer<typeof SessionOrigin>;

export const SessionInfo = z.object({
  id: z.string(),
  projectId: z.string(),
  agent: AgentId,
  cwd: z.string(),
  title: z.string(),
  state: SessionState,
  settings: SessionSettings,
  /** Id da sessão no agente (serve para retomar). */
  agentSessionId: z.string().nullable(),
  /** Servidores MCP ligados a esta sessão. */
  mcpServers: z.array(z.string()).optional(),
  workspace: Workspace.optional(),
  /** A corrida a que esta sessão pertence (uma pista). */
  raceId: z.string().optional(),
  /** De onde veio esta sessão (passagem, bifurcação, pista, parte, tarefa, consulta ou delegação). */
  origin: SessionOrigin.optional(),
  /** A sessão a quem esta passou o testemunho; esta deixa de aceitar mensagens. */
  handedTo: z.string().optional(),
  /** A primeira das 10 portas da sessão (SOLLINE_PORT). */
  port: z.number().int().optional(),
  /** A preparação da worktree (só nas sessões em worktree de projetos de confiança). */
  setup: z
    .object({
      state: z.enum(['approval', 'running', 'done', 'failed']),
      command: z.string().optional(),
      tail: z.string().nullable(),
      durationMs: z.number().nullable(),
    })
    .optional(),
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
  /** O agente mudou o que sabe fazer (por exemplo outros modelos ou modos). Substitui tudo. */
  z.object({ type: z.literal('capabilities'), capabilities: AgentCapabilities }),
  /** A conversa voltou a antes deste turno do utilizador: ele e os seguintes saem. */
  z.object({ type: z.literal('rewind'), turnId: z.string() }),
]);
export type ConversationDelta = z.infer<typeof ConversationDelta>;

/** Resposta da interface a um pedido. */
export const PermissionAnswer = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow-once') }),
  z.object({ decision: z.literal('allow-always') }),
  z.object({ decision: z.literal('deny'), message: z.string().max(10_000).optional() }),
  z.object({ decision: z.literal('deny-always') }),
  z.object({
    decision: z.literal('answer'),
    answers: z
      .record(z.string().max(500), z.string().max(10_000))
      .refine((answers) => Object.keys(answers).length <= 8, 'Respostas a mais'),
  }),
]);
export type PermissionAnswer = z.infer<typeof PermissionAnswer>;
