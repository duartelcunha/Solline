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
  mode: string;
  /** Id da sessão no agente, para retomar o histórico. */
  resume?: string | undefined;
}

export interface AgentStartResult {
  settings: SessionSettings;
  capabilities: AgentCapabilities;
}

/**
 * Um agente numa sessão. Cada provider (Claude pelo SDK, os outros por ACP no M1b)
 * implementa isto e traduz para o mesmo modelo de conversa.
 */
export interface AgentAdapter {
  start(): Promise<AgentStartResult>;
  /** Envia uma mensagem; devolve o id do turno do utilizador. */
  send(text: string): Promise<string>;
  interrupt(): Promise<void>;
  setMode(mode: string): Promise<void>;
  setModel(model: string): Promise<void>;
  /** Só existe nos agentes com níveis de esforço (ver capabilities().effort). */
  setEffort?(effort: string): Promise<void>;
  answerPermission(requestId: string, answer: PermissionAnswer): boolean;
  capabilities(): AgentCapabilities;
  /** Id da sessão no agente, quando já o conhece. */
  agentSessionId(): string | null;
  close(): Promise<void>;
}

export type AgentAdapterFactory = (options: AgentStartOptions, sink: AdapterSink) => AgentAdapter;
