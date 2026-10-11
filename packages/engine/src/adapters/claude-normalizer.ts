import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Block, ConversationDelta, ToolBlock, Usage } from '@solline/protocol';
import { toolResultText, toolSummary } from './claude-tools.ts';

type StreamKind = 'text' | 'thinking' | 'tool';

interface OpenBlock {
  blockId: string;
  kind: StreamKind;
}

const TOOL_USE_TYPES = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use']);

const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: 'O agente parou: chegou ao limite de voltas.',
  error_max_budget_usd: 'O agente parou: chegou ao limite de custo.',
  error_during_execution: 'O agente parou com um erro durante a execução.',
  error_max_structured_output_retries: 'O agente parou: não conseguiu produzir a resposta pedida.',
};

/**
 * Traduz o fluxo de SDKMessage do Claude para deltas do modelo de conversa.
 * Não faz I/O: recebe mensagens, devolve deltas. Testa-se com fixtures reais.
 */
export class ClaudeNormalizer {
  readonly #newId: () => string;
  #assistantTurnId: string | null = null;
  /** message.id corrente por contexto (principal ou subagente). */
  readonly #messageIds = new Map<string, string>();
  /** Blocos em streaming, por `${message.id}:${index}`. */
  readonly #open = new Map<string, OpenBlock>();
  /** Último bloco aberto por message.id, para casar com a mensagem completa. */
  readonly #lastOpen = new Map<string, OpenBlock>();
  readonly #blocks = new Map<string, Block>();
  #interrupted = false;

  constructor(options: { newId?: () => string } = {}) {
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** O turno de quem escreve. Fecha a ligação ao turno anterior do agente. */
  userTurn(turnId: string, text: string): ConversationDelta[] {
    this.#assistantTurnId = null;
    this.#interrupted = false;
    return [
      {
        type: 'turn.start',
        turn: {
          id: turnId,
          role: 'user',
          blocks: [{ kind: 'text', id: `${turnId}:text`, text, parentToolId: null }],
        },
      },
    ];
  }

  markInterrupted(): void {
    this.#interrupted = true;
  }

  /** Garante um turno do agente aberto (para pôr lá um pedido de permissão, por exemplo). */
  ensureAssistantTurn(): { turnId: string; deltas: ConversationDelta[] } {
    if (this.#assistantTurnId) return { turnId: this.#assistantTurnId, deltas: [] };
    const turnId = this.#newId();
    this.#assistantTurnId = turnId;
    return {
      turnId,
      deltas: [
        {
          type: 'turn.start',
          turn: { id: turnId, role: 'assistant', blocks: [] },
        },
      ],
    };
  }

  push(message: SDKMessage): ConversationDelta[] {
    switch (message.type) {
      case 'system':
        return this.#system(message);
      case 'stream_event':
        return this.#stream(message);
      case 'assistant':
        return this.#assistant(message);
      case 'user':
        return this.#user(message);
      case 'result':
        return this.#result(message);
      default:
        return [];
    }
  }

  #system(message: Extract<SDKMessage, { type: 'system' }>): ConversationDelta[] {
    if (message.subtype === 'init') {
      const effort = 'effort' in message ? message.effort : undefined;
      return [
        {
          type: 'settings',
          settings: {
            model: message.model,
            mode: message.permissionMode,
            ...(effort !== undefined ? { effort } : {}),
          },
        },
        { type: 'meta', agentSessionId: message.session_id },
      ];
    }
    if (message.subtype === 'status' && message.permissionMode) {
      return [{ type: 'settings', settings: { mode: message.permissionMode } }];
    }
    return [];
  }

  #stream(message: Extract<SDKMessage, { type: 'stream_event' }>): ConversationDelta[] {
    const context = message.parent_tool_use_id ?? 'main';
    const parentToolId = message.parent_tool_use_id;
    const event = message.event;
    const out: ConversationDelta[] = [];

    if (event.type === 'message_start') {
      const { turnId, deltas } = this.ensureAssistantTurn();
      void turnId;
      out.push(...deltas);
      this.#messageIds.set(context, event.message.id);
      return out;
    }

    const messageId = this.#messageIds.get(context);
    if (!messageId) return out;
    const key = `${messageId}:${event.type === 'message_delta' || event.type === 'message_stop' ? '' : event.index}`;

    if (event.type === 'content_block_start') {
      const block = event.content_block;
      const { turnId, deltas } = this.ensureAssistantTurn();
      out.push(...deltas);
      if (block.type === 'text' || block.type === 'thinking') {
        const kind: StreamKind = block.type;
        const blockId = `${messageId}:${event.index}`;
        const open = { blockId, kind };
        this.#open.set(key, open);
        this.#lastOpen.set(messageId, open);
        const initial: Block =
          kind === 'text'
            ? { kind: 'text', id: blockId, text: '', parentToolId }
            : { kind: 'thinking', id: blockId, text: '', done: false, parentToolId };
        this.#blocks.set(blockId, initial);
        out.push({ type: 'block.upsert', turnId, block: initial });
      } else if (TOOL_USE_TYPES.has(block.type) && 'id' in block && 'name' in block) {
        const open = { blockId: block.id, kind: 'tool' as const };
        this.#open.set(key, open);
        this.#lastOpen.set(messageId, open);
        out.push(...this.#upsertTool(turnId, block.id, block.name, {}, parentToolId));
      }
      return out;
    }

    if (event.type === 'content_block_delta') {
      const open = this.#open.get(key);
      const turnId = this.#assistantTurnId;
      if (!open || !turnId) return out;
      const delta = event.delta;
      let text: string | undefined;
      if (delta.type === 'text_delta' && open.kind === 'text') text = delta.text;
      if (delta.type === 'thinking_delta' && open.kind === 'thinking') text = delta.thinking;
      if (text) {
        const current = this.#blocks.get(open.blockId);
        if (current && (current.kind === 'text' || current.kind === 'thinking')) {
          this.#blocks.set(open.blockId, { ...current, text: current.text + text });
        }
        out.push({ type: 'block.append', turnId, blockId: open.blockId, text });
      }
      return out;
    }

    if (event.type === 'content_block_stop') {
      this.#open.delete(key);
    }
    return out;
  }

  #assistant(message: Extract<SDKMessage, { type: 'assistant' }>): ConversationDelta[] {
    const { turnId, deltas } = this.ensureAssistantTurn();
    const out: ConversationDelta[] = [...deltas];
    const parentToolId = message.parent_tool_use_id;
    const messageId = message.message.id;
    const content = Array.isArray(message.message.content) ? message.message.content : [];
    content.forEach((block, index) => {
      const last = this.#lastOpen.get(messageId);
      if (block.type === 'text' || block.type === 'thinking') {
        const kind: StreamKind = block.type;
        const blockId =
          last && last.kind === kind && content.length === 1
            ? last.blockId
            : `${message.uuid}:${index}`;
        const previous = this.#blocks.get(blockId);
        const previousText =
          previous && (previous.kind === 'text' || previous.kind === 'thinking')
            ? previous.text
            : '';
        const next: Block =
          kind === 'text'
            ? {
                kind: 'text',
                id: blockId,
                text: block.type === 'text' ? block.text : '',
                parentToolId,
              }
            : {
                kind: 'thinking',
                id: blockId,
                // Com display "omitted" o texto vem vazio: fica o que chegou em streaming.
                text: (block.type === 'thinking' ? block.thinking : '') || previousText,
                done: true,
                parentToolId,
              };
        this.#blocks.set(blockId, next);
        out.push({ type: 'block.upsert', turnId, block: next });
      } else if (TOOL_USE_TYPES.has(block.type) && 'id' in block && 'name' in block) {
        const input = 'input' in block ? block.input : {};
        out.push(...this.#upsertTool(turnId, block.id, block.name, input, parentToolId));
      }
    });
    return out;
  }

  #user(message: Extract<SDKMessage, { type: 'user' }>): ConversationDelta[] {
    const content = message.message.content;
    if (!Array.isArray(content)) return [];
    const out: ConversationDelta[] = [];
    for (const part of content) {
      if (part.type !== 'tool_result') continue;
      const { turnId, deltas } = this.ensureAssistantTurn();
      out.push(...deltas);
      const previous = this.#blocks.get(part.tool_use_id);
      const base: ToolBlock =
        previous?.kind === 'tool'
          ? previous
          : {
              kind: 'tool',
              id: part.tool_use_id,
              name: 'Ferramenta',
              summary: 'Ferramenta',
              input: {},
              state: 'running',
              parentToolId: message.parent_tool_use_id,
            };
      const next: ToolBlock = {
        ...base,
        state: part.is_error ? 'error' : 'ok',
        output: toolResultText(part.content),
      };
      this.#blocks.set(next.id, next);
      out.push({ type: 'block.upsert', turnId, block: next });
    }
    return out;
  }

  #result(message: Extract<SDKMessage, { type: 'result' }>): ConversationDelta[] {
    const { turnId, deltas } = this.ensureAssistantTurn();
    const out: ConversationDelta[] = [...deltas];
    const usage: Partial<Usage> = {
      costUsd: message.total_cost_usd,
      models: Object.entries(message.modelUsage ?? {}).map(([model, row]) => ({
        model,
        inputTokens: row.inputTokens + row.cacheReadInputTokens + row.cacheCreationInputTokens,
        outputTokens: row.outputTokens,
        costUsd: row.costUSD,
      })),
    };
    out.push({ type: 'usage', usage });

    const failed = message.subtype !== 'success' || message.is_error;
    let outcome: 'done' | 'interrupted' | 'error' = 'done';
    if (this.#interrupted) {
      outcome = 'interrupted';
      out.push({
        type: 'block.upsert',
        turnId,
        block: {
          kind: 'notice',
          id: `${turnId}:interrupted`,
          tone: 'info',
          text: 'Interrompeste aqui.',
        },
      });
    } else if (failed) {
      outcome = 'error';
      const text =
        message.subtype === 'success'
          ? message.result || 'O agente respondeu com um erro.'
          : message.errors.join('\n') ||
            (RESULT_ERRORS[message.subtype] ?? 'O agente parou com um erro.');
      out.push({
        type: 'block.upsert',
        turnId,
        block: { kind: 'notice', id: `${turnId}:error`, tone: 'error', text },
      });
    }
    out.push({ type: 'turn.end', turnId, outcome });
    this.#assistantTurnId = null;
    this.#interrupted = false;
    this.#open.clear();
    this.#lastOpen.clear();
    return out;
  }

  #upsertTool(
    turnId: string,
    id: string,
    name: string,
    input: unknown,
    parentToolId: string | null,
  ): ConversationDelta[] {
    const previous = this.#blocks.get(id);
    const next: ToolBlock = {
      ...(previous?.kind === 'tool' ? previous : {}),
      kind: 'tool',
      id,
      name,
      summary: toolSummary(name, input),
      input,
      state: previous?.kind === 'tool' ? previous.state : 'running',
      parentToolId,
    };
    this.#blocks.set(id, next);
    return [{ type: 'block.upsert', turnId, block: next }];
  }
}
