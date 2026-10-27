import type {
  Block,
  ConversationDelta,
  ThinkingBlock,
  TodoBlock,
  ToolBlock,
  ToolCategory,
} from '@solline/protocol';
import { BRAIN_SERVER_NAME, brainToolLabel } from '../../brain/tool.ts';
import { baseName, clip } from '../claude/tools.ts';
import { errorNotice, interruptedNotice, userTurnDelta } from '../shared/turns.ts';
import type { CommandAction } from './protocol/v2/CommandAction';
import type { ThreadItem } from './protocol/v2/ThreadItem';
import type { ThreadTokenUsage } from './protocol/v2/ThreadTokenUsage';
import type { Turn } from './protocol/v2/Turn';
import type { TurnPlanStep } from './protocol/v2/TurnPlanStep';

type Item<T extends ThreadItem['type']> = Extract<ThreadItem, { type: T }>;

/** O Codex embrulha os comandos num powershell.exe -Command '…': mostra-se o que está dentro. */
export function displayCommand(command: string, actions: readonly CommandAction[] = []): string {
  const inner = actions.length === 1 ? actions[0]?.command : undefined;
  if (inner) return inner;
  const wrapped = /^"?[^"]*powershell(?:\.exe)?"?\s+-Command\s+'([\s\S]*)'$/i.exec(command);
  return wrapped?.[1] ?? command;
}

function commandShape(item: Item<'commandExecution'>): {
  summary: string;
  category: ToolCategory;
  display: string;
} {
  const display = displayCommand(item.command, item.commandActions);
  const [action] = item.commandActions;
  if (item.commandActions.length === 1 && action) {
    if (action.type === 'read') return { summary: `Ler ${action.name}`, category: 'read', display };
    if (action.type === 'listFiles') {
      return { summary: `Ver ficheiros ${action.path ?? ''}`.trim(), category: 'search', display };
    }
    if (action.type === 'search') {
      return {
        summary: action.query ? `Procurar "${clip(action.query, 60)}"` : 'Procurar no código',
        category: 'search',
        display,
      };
    }
  }
  return { summary: `Correr ${clip(display, 70)}`, category: 'execute', display };
}

function fileChangeSummary(item: Item<'fileChange'>): string {
  const [first] = item.changes;
  if (item.changes.length !== 1 || !first) return `Editar ${item.changes.length} ficheiros`;
  const name = baseName(first.path);
  if (first.kind.type === 'add') return `Criar ${name}`;
  if (first.kind.type === 'delete') return `Apagar ${name}`;
  return `Editar ${name}`;
}

function planStatus(step: TurnPlanStep): TodoBlock['entries'][number]['status'] {
  return step.status === 'inProgress'
    ? 'in_progress'
    : step.status === 'completed'
      ? 'completed'
      : 'pending';
}

function mcpOutput(item: Item<'mcpToolCall'>): string | undefined {
  if (item.error) return item.error.message;
  const content = (item.result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((c) => (typeof c === 'object' && c && 'text' in c ? String(c.text) : ''))
    .join('\n');
}

/**
 * Traduz as notificações do codex app-server para deltas do modelo de conversa. Não faz
 * I/O: recebe método e parâmetros, devolve deltas. Testa-se com gravações reais.
 */
export class CodexNormalizer {
  readonly #newId: () => string;
  #turnId: string | null = null;
  #interrupted = false;
  readonly #blocks = new Map<string, Block>();
  /** Último summaryIndex por bloco de raciocínio (cada parte nova abre um parágrafo). */
  readonly #summaryIndex = new Map<string, number>();
  /** Itens de edição por id, para o cartão de aprovação mostrar o diff. */
  readonly #fileChanges = new Map<string, Item<'fileChange'>>();
  readonly #commands = new Map<string, Item<'commandExecution'>>();

  constructor(options: { newId?: () => string } = {}) {
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  userTurn(turnId: string, text: string): ConversationDelta[] {
    this.#turnId = null;
    this.#interrupted = false;
    return [userTurnDelta(turnId, text)];
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

  fileChange(itemId: string): Item<'fileChange'> | undefined {
    return this.#fileChanges.get(itemId);
  }

  command(itemId: string): Item<'commandExecution'> | undefined {
    return this.#commands.get(itemId);
  }

  push(method: string, params: unknown): ConversationDelta[] {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'turn/started':
        return this.ensureAssistantTurn().deltas;
      case 'item/started':
        return this.#item(p.item as ThreadItem, false);
      case 'item/completed':
        return this.#item(p.item as ThreadItem, true);
      case 'item/agentMessage/delta':
        return this.#append('text', String(p.itemId), String(p.delta ?? ''));
      case 'item/reasoning/summaryTextDelta': {
        const id = String(p.itemId);
        const index = Number(p.summaryIndex ?? 0);
        const last = this.#summaryIndex.get(id);
        this.#summaryIndex.set(id, index);
        const prefix = last !== undefined && index > last ? '\n\n' : '';
        return this.#append('thinking', id, prefix + String(p.delta ?? ''));
      }
      case 'turn/plan/updated':
        return this.#plan(p.plan as TurnPlanStep[]);
      case 'thread/tokenUsage/updated':
        return this.#usage(p.tokenUsage as ThreadTokenUsage);
      case 'turn/completed':
        return this.#completed(p.turn as Turn);
      case 'error': {
        if (p.willRetry === true) return [];
        const { turnId, deltas } = this.ensureAssistantTurn();
        const message = (p.error as { message?: string } | undefined)?.message;
        return [...deltas, errorNotice(turnId, message ?? 'O Codex respondeu com um erro.')];
      }
      case 'warning': {
        if (typeof p.message !== 'string' || !this.#turnId) return [];
        return [
          {
            type: 'block.upsert',
            turnId: this.#turnId,
            block: {
              kind: 'notice',
              id: `${this.#turnId}:warning:${this.#newId()}`,
              tone: 'info',
              text: p.message,
            },
          },
        ];
      }
      default:
        return [];
    }
  }

  #upsert(block: Block): ConversationDelta[] {
    const { turnId, deltas } = this.ensureAssistantTurn();
    this.#blocks.set(block.id, block);
    return [...deltas, { type: 'block.upsert', turnId, block }];
  }

  #append(kind: 'text' | 'thinking', id: string, text: string): ConversationDelta[] {
    if (!text) return [];
    const out: ConversationDelta[] = [];
    const existing = this.#blocks.get(id);
    if (!existing) {
      out.push(
        ...this.#upsert(
          kind === 'text'
            ? { kind: 'text', id, text: '', parentToolId: null }
            : { kind: 'thinking', id, text: '', done: false, parentToolId: null },
        ),
      );
    }
    const block = this.#blocks.get(id);
    if (block && (block.kind === 'text' || block.kind === 'thinking')) {
      this.#blocks.set(id, { ...block, text: block.text + text });
    }
    const turnId = this.ensureAssistantTurn().turnId;
    out.push({ type: 'block.append', turnId, blockId: id, text });
    return out;
  }

  #item(item: ThreadItem, done: boolean): ConversationDelta[] {
    switch (item.type) {
      case 'agentMessage':
      case 'plan': {
        // No arranque o texto vem vazio e chega aos bocados; no fim vem inteiro.
        if (!done && !item.text)
          return this.#blocks.has(item.id)
            ? []
            : this.#upsert({ kind: 'text', id: item.id, text: '', parentToolId: null });
        return this.#upsert({ kind: 'text', id: item.id, text: item.text, parentToolId: null });
      }
      case 'reasoning': {
        const previous = this.#blocks.get(item.id);
        const streamed = previous?.kind === 'thinking' ? previous.text : '';
        const text = item.summary.join('\n\n') || streamed;
        const block: ThinkingBlock = {
          kind: 'thinking',
          id: item.id,
          text,
          done,
          parentToolId: null,
        };
        return this.#upsert(block);
      }
      case 'commandExecution': {
        this.#commands.set(item.id, item);
        const { summary, category, display } = commandShape(item);
        const failed =
          item.status === 'failed' ||
          item.status === 'declined' ||
          (item.exitCode !== null && item.exitCode !== 0);
        const block: ToolBlock = {
          kind: 'tool',
          id: item.id,
          name: 'shell',
          summary,
          input: { command: display, cwd: item.cwd },
          state: !done || item.status === 'inProgress' ? 'running' : failed ? 'error' : 'ok',
          parentToolId: null,
          category,
          content: [{ type: 'command', command: display, cwd: item.cwd }],
          ...(item.aggregatedOutput ? { output: item.aggregatedOutput } : {}),
        };
        return this.#upsert(block);
      }
      case 'fileChange': {
        this.#fileChanges.set(item.id, item);
        const block: ToolBlock = {
          kind: 'tool',
          id: item.id,
          name: 'apply_patch',
          summary: fileChangeSummary(item),
          input: { changes: item.changes.map((c) => ({ path: c.path, kind: c.kind.type })) },
          state:
            !done || item.status === 'inProgress'
              ? 'running'
              : item.status === 'completed'
                ? 'ok'
                : 'error',
          parentToolId: null,
          category: 'edit',
          locations: item.changes.map((c) => ({ path: c.path })),
          content: item.changes.map((c) => ({ type: 'patch', path: c.path, unified: c.diff })),
          ...(done && item.status === 'declined' ? { output: 'Recusado.' } : {}),
        };
        return this.#upsert(block);
      }
      case 'mcpToolCall': {
        const output = done ? mcpOutput(item) : undefined;
        const block: ToolBlock = {
          kind: 'tool',
          id: item.id,
          name: `mcp__${item.server}__${item.tool}`,
          summary:
            item.server === BRAIN_SERVER_NAME
              ? brainToolLabel(item.tool)
              : `${item.server}: ${item.tool}`,
          input: item.arguments,
          state:
            !done || item.status === 'inProgress'
              ? 'running'
              : item.status === 'completed'
                ? 'ok'
                : 'error',
          parentToolId: null,
          category: 'other',
          ...(output ? { output } : {}),
        };
        return this.#upsert(block);
      }
      case 'webSearch': {
        const block: ToolBlock = {
          kind: 'tool',
          id: item.id,
          name: 'web_search',
          summary: item.query ? `Pesquisar "${clip(item.query, 60)}"` : 'Pesquisar na web',
          input: { query: item.query },
          state: done ? 'ok' : 'running',
          parentToolId: null,
          category: 'fetch',
        };
        return this.#upsert(block);
      }
      case 'contextCompaction':
        return done
          ? this.#upsert({
              kind: 'notice',
              id: item.id,
              tone: 'info',
              text: 'O Codex resumiu a conversa para caber no contexto.',
            })
          : [];
      default:
        return [];
    }
  }

  #plan(plan: readonly TurnPlanStep[]): ConversationDelta[] {
    const { turnId, deltas } = this.ensureAssistantTurn();
    return [...deltas, ...this.#planUpsert(turnId, plan)];
  }

  #planUpsert(turnId: string, plan: readonly TurnPlanStep[]): ConversationDelta[] {
    return this.#upsert({
      kind: 'todo',
      id: `${turnId}:plan`,
      entries: plan.map((step) => ({ content: step.step, status: planStatus(step) })),
    });
  }

  #usage(usage: ThreadTokenUsage): ConversationDelta[] {
    const total = usage.total;
    const window = usage.modelContextWindow;
    const used = usage.last.totalTokens;
    return [
      {
        type: 'usage',
        usage: {
          // Totais da sessão (o Codex já os acumula): a interface mostra o último.
          tokens: {
            input: total.inputTokens,
            output: total.outputTokens,
            cachedInput: total.cachedInputTokens,
            reasoning: total.reasoningOutputTokens,
          },
          ...(window
            ? {
                context: {
                  usedTokens: used,
                  maxTokens: window,
                  percent: Math.min(100, Math.round((used / window) * 100)),
                },
              }
            : {}),
        },
      },
    ];
  }

  #completed(turn: Turn): ConversationDelta[] {
    const { turnId, deltas } = this.ensureAssistantTurn();
    const out: ConversationDelta[] = [...deltas];
    let outcome: 'done' | 'interrupted' | 'error' = 'done';
    if (turn.status === 'interrupted' || this.#interrupted) {
      outcome = 'interrupted';
      out.push(interruptedNotice(turnId));
    } else if (turn.status === 'failed') {
      outcome = 'error';
      out.push(errorNotice(turnId, turn.error?.message ?? 'O Codex parou com um erro.'));
    }
    // Ferramentas que ficaram a meio fecham com o turno.
    for (const block of this.#blocks.values()) {
      if (block.kind === 'tool' && block.state === 'running') {
        const closed: ToolBlock = { ...block, state: outcome === 'done' ? 'ok' : 'error' };
        this.#blocks.set(block.id, closed);
        out.push({ type: 'block.upsert', turnId, block: closed });
      }
      if (block.kind === 'thinking' && !block.done) {
        const closed: ThinkingBlock = { ...block, done: true };
        this.#blocks.set(block.id, closed);
        out.push({ type: 'block.upsert', turnId, block: closed });
      }
    }
    out.push({ type: 'turn.end', turnId, outcome });
    this.#turnId = null;
    this.#interrupted = false;
    this.#blocks.clear();
    this.#summaryIndex.clear();
    return out;
  }
}
