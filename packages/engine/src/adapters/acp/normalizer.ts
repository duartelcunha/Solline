import type {
  ContentBlock,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
} from '@agentclientprotocol/sdk';
import type {
  Block,
  ConversationDelta,
  ThinkingBlock,
  ToolBlock,
  ToolContent,
  ToolState,
} from '@solline/protocol';
import { errorNotice, interruptedNotice, userTurnDelta } from '../shared/turns.ts';

function text(block: ContentBlock | undefined): string {
  return block && block.type === 'text' ? block.text : '';
}

function toolState(status: ToolCallStatus | null | undefined, previous?: ToolState): ToolState {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'error';
  if (status === 'pending' || status === 'in_progress') return 'running';
  return previous ?? 'running';
}

function contentOf(
  items: readonly ToolCallContent[] | null | undefined,
): ToolContent[] | undefined {
  if (!items) return undefined;
  const out: ToolContent[] = items.flatMap((c): ToolContent[] => {
    if (c.type === 'diff')
      return [{ type: 'diff', path: c.path, oldText: c.oldText ?? null, newText: c.newText }];
    if (c.type === 'content' && c.content.type === 'text')
      return [{ type: 'text', text: c.content.text }];
    return [];
  });
  return out.length ? out : undefined;
}

function outputOf(
  items: readonly ToolCallContent[] | null | undefined,
  raw: unknown,
): string | undefined {
  const fromContent = (items ?? [])
    .flatMap((c) => (c.type === 'content' && c.content.type === 'text' ? [c.content.text] : []))
    .join('\n');
  if (fromContent) return fromContent;
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
}

/**
 * Traduz os session/update de um agente ACP para deltas do modelo de conversa. Não faz I/O.
 * O texto sem messageId junta-se ao último bloco de texto até aparecer outra coisa.
 */
export class AcpNormalizer {
  readonly #newId: () => string;
  #turnId: string | null = null;
  #interrupted = false;
  /** Durante um session/load o agente repete o histórico: não se mostra outra vez. */
  replaying = false;
  readonly #blocks = new Map<string, Block>();
  #textId: string | null = null;
  #thoughtId: string | null = null;

  constructor(options: { newId?: () => string } = {}) {
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  userTurn(turnId: string, message: string): ConversationDelta[] {
    this.#turnId = null;
    this.#interrupted = false;
    return [userTurnDelta(turnId, message)];
  }

  markInterrupted(): void {
    this.#interrupted = true;
  }

  ensureAssistantTurn(): { turnId: string; deltas: ConversationDelta[] } {
    if (this.#turnId) return { turnId: this.#turnId, deltas: [] };
    const turnId = this.#newId();
    this.#turnId = turnId;
    return {
      turnId,
      deltas: [{ type: 'turn.start', turn: { id: turnId, role: 'assistant', blocks: [] } }],
    };
  }

  tool(id: string): ToolBlock | undefined {
    const block = this.#blocks.get(id);
    return block?.kind === 'tool' ? block : undefined;
  }

  push(update: SessionUpdate): ConversationDelta[] {
    if (this.replaying) return [];
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.#chunk('text', update.messageId, text(update.content));
      case 'agent_thought_chunk':
        return this.#chunk('thinking', update.messageId, text(update.content));
      case 'tool_call':
      case 'tool_call_update':
        return this.#tool(update);
      case 'plan': {
        const { turnId, deltas } = this.ensureAssistantTurn();
        return [
          ...deltas,
          ...this.#upsert({
            kind: 'todo',
            id: `${turnId}:plan`,
            entries: update.entries.map((e) => ({
              content: e.content,
              status: e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending',
              ...(e.priority ? { priority: e.priority } : {}),
            })),
          }),
        ];
      }
      case 'usage_update':
        return [
          {
            type: 'usage',
            usage: {
              context: {
                usedTokens: update.used,
                maxTokens: update.size,
                percent: update.size
                  ? Math.min(100, Math.round((update.used / update.size) * 100))
                  : 0,
              },
              // O custo do ACP é o total da sessão; só em dólares.
              ...(update.cost && update.cost.currency === 'USD'
                ? { costUsd: update.cost.amount }
                : {}),
            },
          },
        ];
      case 'current_mode_update':
        return [{ type: 'settings', settings: { mode: update.currentModeId } }];
      case 'notice': {
        const { turnId, deltas } = this.ensureAssistantTurn();
        const message = update.description
          ? `${update.title}: ${update.description}`
          : update.title;
        return [
          ...deltas,
          ...this.#upsert({
            kind: 'notice',
            id: `${turnId}:${this.#newId()}`,
            tone: update.severity === 'error' ? 'error' : 'info',
            text: message,
          }),
        ];
      }
      default:
        return [];
    }
  }

  /** O fim do turno vem na resposta ao session/prompt. */
  end(stopReason: StopReason | 'error', message?: string): ConversationDelta[] {
    const { turnId, deltas } = this.ensureAssistantTurn();
    const out: ConversationDelta[] = [...deltas, ...this.#closeThought()];
    let outcome: 'done' | 'interrupted' | 'error' = 'done';
    if (stopReason === 'cancelled' || this.#interrupted) {
      outcome = 'interrupted';
      out.push(interruptedNotice(turnId));
    } else if (stopReason === 'error' || stopReason === 'refusal') {
      outcome = 'error';
      out.push(
        errorNotice(
          turnId,
          message ??
            (stopReason === 'refusal'
              ? 'O agente recusou continuar.'
              : 'O agente parou com um erro.'),
        ),
      );
    } else if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      out.push({
        type: 'block.upsert',
        turnId,
        block: {
          kind: 'notice',
          id: `${turnId}:limit`,
          tone: 'info',
          text:
            stopReason === 'max_tokens'
              ? 'O agente parou: chegou ao limite de tokens.'
              : 'O agente parou: chegou ao limite de passos.',
        },
      });
    }
    for (const block of this.#blocks.values()) {
      if (block.kind === 'tool' && block.state === 'running') {
        const closed: ToolBlock = { ...block, state: outcome === 'done' ? 'ok' : 'error' };
        out.push({ type: 'block.upsert', turnId, block: closed });
      }
    }
    out.push({ type: 'turn.end', turnId, outcome });
    this.#turnId = null;
    this.#interrupted = false;
    this.#blocks.clear();
    this.#textId = null;
    this.#thoughtId = null;
    return out;
  }

  #upsert(block: Block): ConversationDelta[] {
    const { turnId, deltas } = this.ensureAssistantTurn();
    this.#blocks.set(block.id, block);
    return [...deltas, { type: 'block.upsert', turnId, block }];
  }

  #closeThought(): ConversationDelta[] {
    const id = this.#thoughtId;
    this.#thoughtId = null;
    const block = id ? this.#blocks.get(id) : undefined;
    if (!block || block.kind !== 'thinking' || block.done) return [];
    return this.#upsert({ ...block, done: true });
  }

  #chunk(
    kind: 'text' | 'thinking',
    messageId: string | null | undefined,
    chunk: string,
  ): ConversationDelta[] {
    if (!chunk) return [];
    const out: ConversationDelta[] = kind === 'text' ? this.#closeThought() : [];
    if (kind === 'thinking') this.#textId = null;
    const current = kind === 'text' ? this.#textId : this.#thoughtId;
    const id = messageId ? `${kind}:${messageId}` : (current ?? `${kind}:${this.#newId()}`);
    if (kind === 'text') this.#textId = id;
    else this.#thoughtId = id;
    if (!this.#blocks.has(id)) {
      const empty: Block =
        kind === 'text'
          ? { kind: 'text', id, text: '', parentToolId: null }
          : ({
              kind: 'thinking',
              id,
              text: '',
              done: false,
              parentToolId: null,
            } satisfies ThinkingBlock);
      out.push(...this.#upsert(empty));
    }
    const block = this.#blocks.get(id);
    if (block && (block.kind === 'text' || block.kind === 'thinking')) {
      this.#blocks.set(id, { ...block, text: block.text + chunk });
    }
    out.push({
      type: 'block.append',
      turnId: this.ensureAssistantTurn().turnId,
      blockId: id,
      text: chunk,
    });
    return out;
  }

  #tool(
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>,
  ): ConversationDelta[] {
    // Uma ferramenta fecha o texto e o raciocínio em curso: o que vier depois é um bloco novo.
    this.#textId = null;
    const out = this.#closeThought();
    const previous = this.tool(update.toolCallId);
    const content = contentOf(update.content) ?? previous?.content;
    const state = toolState(update.status, previous?.state);
    const output =
      state === 'running'
        ? previous?.output
        : (outputOf(update.content, update.rawOutput) ?? previous?.output);
    const kind = update.kind ?? previous?.category;
    const locations = update.locations
      ? update.locations.map((l) => ({ path: l.path, ...(l.line != null ? { line: l.line } : {}) }))
      : previous?.locations;
    const block: ToolBlock = {
      kind: 'tool',
      id: update.toolCallId,
      name: update.name ?? previous?.name ?? kind ?? 'tool',
      summary: update.title ?? previous?.summary ?? 'Ferramenta',
      input: update.rawInput !== undefined ? update.rawInput : (previous?.input ?? {}),
      state,
      parentToolId: null,
      ...(kind ? { category: kind } : {}),
      ...(locations ? { locations } : {}),
      ...(content ? { content } : {}),
      ...(output !== undefined ? { output } : {}),
    };
    return [...out, ...this.#upsert(block)];
  }
}
