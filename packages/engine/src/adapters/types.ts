import type {
  AgentCapabilities,
  AskBlock,
  ConversationDelta,
  PermissionAnswer,
  SessionSettings,
  SessionState,
} from '@solline/protocol';

/**
 * Para onde um adaptador manda o que acontece na conversa. O SessionManager liga isto
 * aos eventos da Ponte; nos testes é um array.
 */
export interface AdapterSink {
  delta(delta: ConversationDelta): void;
  state(state: SessionState, error?: string): void;
  ask(turnId: string, request: AskBlock): void;
}

export interface AgentStartOptions {
  cwd: string;
  model?: string | undefined;
  effort?: string | undefined;
  /** null nos agentes sem modos. */
  mode: string | null;
  /** Id da sessão no agente, para retomar o histórico. */
  resume?: string | undefined;
  /** Projeto de confiança: o agente pode ler as definições e instruções da pasta. */
  projectTrusted?: boolean | undefined;
  /** Ambiente do processo do agente, já com a política do registo aplicada. */
  env?: Record<string, string | undefined> | undefined;
  /** Servidores MCP só desta sessão (stdio). */
  mcpServers?: readonly McpServerLaunch[] | undefined;
  /**
   * Começa de um ponto de rebobinar que este mesmo adaptador deu (rewindPoint): a conversa
   * fica como estava nesse momento, numa sessão nova do agente.
   */
  fork?: string | undefined;
}

export interface SendOptions {
  /** Id do turno do utilizador; o motor escolhe-o para ligar o checkpoint ao turno. */
  turnId?: string | undefined;
  /** Texto que segue para o agente antes da mensagem, sem aparecer na conversa (um resumo). */
  context?: string | undefined;
}

export interface McpServerLaunch {
  name: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** Corre programas: as ferramentas dele nunca ficam com "Permitir sempre". */
  executesCode: boolean;
}

export interface AgentStartResult {
  settings: SessionSettings;
  capabilities: AgentCapabilities;
}

/**
 * Um agente numa sessão. Cada transporte (Claude pelo SDK, Codex pelo app-server, os outros
 * por ACP) implementa isto e traduz para o mesmo modelo de conversa.
 */
export interface AgentAdapter {
  start(): Promise<AgentStartResult>;
  /** Envia uma mensagem; devolve o id do turno do utilizador. */
  send(text: string, options?: SendOptions): Promise<string>;
  interrupt(): Promise<void>;
  setMode(mode: string): Promise<void>;
  setModel(model: string): Promise<void>;
  /** Só existe nos agentes com níveis de esforço (ver capabilities().effort). */
  setEffort?(effort: string): Promise<void>;
  answerPermission(requestId: string, answer: PermissionAnswer): boolean;
  capabilities(): AgentCapabilities;
  /** Id da sessão no agente, quando já o conhece. */
  agentSessionId(): string | null;
  /**
   * Onde a conversa está agora, num texto opaco que só este adaptador lê (em fork). null:
   * ainda não há nada para guardar. Sem o método, o agente não rebobina a conversa.
   */
  rewindPoint?(): string | null;
  close(): Promise<void>;
}

export type AgentAdapterFactory = (options: AgentStartOptions, sink: AdapterSink) => AgentAdapter;
