import type {
  BudgetLimits,
  LedgerExecution,
  LedgerView,
  TokenSnapshot,
  Usage,
} from '@solline/protocol';

/** A tabela que sai com o produto. Não há tarifa verificada: a estimativa fica desconhecida. */
export const PRICE_VERSION = 'unpriced-2026-11-10';

export const QUOTA_REASON = 'Nenhum agente reporta a quota oficial.';

export interface PriceRow {
  /** Dólares de tabela por token, não a fatura da subscrição. */
  fresh: number;
  cached: number;
  output: number;
}

export interface UsageReport {
  freshInput?: number | null;
  cachedInput?: number | null;
  output?: number | null;
  costUsd?: number | null;
  model?: string | null;
  /** Outra execução, que não se soma ao total da sessão. */
  subagentId?: string | null;
}

const FIELDS = ['freshInput', 'cachedInput', 'output', 'costUsd'] as const;

const EMPTY: TokenSnapshot = {
  freshInput: null,
  cachedInput: null,
  output: null,
  costUsd: null,
};

function finite(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error('Valor de consumo inválido.');
  return value;
}

function clone(snapshot: TokenSnapshot): TokenSnapshot {
  return { ...snapshot };
}

interface Execution extends LedgerExecution {
  seen: boolean;
}

function blank(id: string, kind: LedgerExecution['kind']): Execution {
  return { id, kind, model: null, last: { ...EMPTY }, spent: { ...EMPTY }, seen: false };
}

/**
 * Livro de uma sessão. Os totais do agente são acumulados: só a diferença conta.
 * Um campo que não veio fica null. Não se preenche com zero.
 */
export class SessionLedger {
  #executions: Execution[] = [];
  #seq = 0;
  #budget: LedgerView['budget'] = {
    maxTurns: null,
    maxAttempts: null,
    maxMinutes: null,
    turns: 0,
    attempts: 0,
    startedAt: null,
    stop: null,
  };
  #table: Readonly<Record<string, PriceRow>>;

  constructor(table: Readonly<Record<string, PriceRow>> = {}) {
    this.#table = table;
  }

  observe(report: UsageReport): void {
    const snapshot = this.#snapshot(report);
    if (report.subagentId) {
      const id = `sub:${report.subagentId}`;
      const existing = this.#executions.find((item) => item.id === id);
      const execution = existing ?? this.#open(id, 'subagent');
      this.#apply(execution, snapshot, report.model ?? null);
      return;
    }
    const open = this.#parent();
    if (this.#dropped(open, snapshot)) {
      const next = this.#open(this.#id('resume'), 'resume');
      this.#apply(next, snapshot, report.model ?? null);
      return;
    }
    this.#apply(open, snapshot, report.model ?? null);
  }

  setBudget(limits: BudgetLimits): void {
    this.#budget = {
      ...this.#budget,
      maxTurns: limits.maxTurns,
      maxAttempts: limits.maxAttempts,
      maxMinutes: limits.maxMinutes,
      stop: null,
    };
    const gate = this.gate(this.#budget.startedAt ?? 0);
    if (!gate.ok && this.#budget.startedAt !== null)
      this.#budget.stop = { reason: gate.reason, text: gate.text };
  }

  /** Antes de abrir outro turno. O turno que já vai a meio não é cortado aqui. */
  gate(
    now: number,
  ): { ok: true } | { ok: false; reason: 'turns' | 'attempts' | 'time'; text: string } {
    const budget = this.#budget;
    if (budget.maxTurns !== null && budget.turns >= budget.maxTurns) {
      return {
        ok: false,
        reason: 'turns',
        text: 'Chegaste ao limite de turnos. O próximo não começa.',
      };
    }
    if (budget.maxAttempts !== null && budget.attempts >= budget.maxAttempts) {
      return {
        ok: false,
        reason: 'attempts',
        text: 'Chegaste ao limite de tentativas. O próximo envio não começa.',
      };
    }
    if (
      budget.maxMinutes !== null &&
      budget.startedAt !== null &&
      now - budget.startedAt >= budget.maxMinutes * 60_000
    ) {
      return {
        ok: false,
        reason: 'time',
        text: 'Chegaste ao limite de tempo. O turno que já vai a meio pode ter passado. O próximo não começa.',
      };
    }
    return { ok: true };
  }

  noteTurn(now: number): void {
    if (this.#budget.startedAt === null) this.#budget.startedAt = now;
    this.#budget.turns += 1;
    this.#budget.attempts += 1;
    const gate = this.gate(now);
    this.#budget.stop = gate.ok ? null : { reason: gate.reason, text: gate.text };
  }

  view(): LedgerView {
    const parents = this.#executions.filter((item) => item.kind !== 'subagent');
    const total = this.#sum(parents);
    const model = parents.length === 1 ? (parents[0]?.model ?? null) : null;
    return {
      executions: this.#executions.map((item) => ({
        id: item.id,
        kind: item.kind,
        model: item.model,
        last: clone(item.last),
        spent: clone(item.spent),
      })),
      total,
      estimateUsd: estimateUsd(total, model, this.#table),
      priceVersion: PRICE_VERSION,
      quota: { status: 'unknown', reason: QUOTA_REASON },
      budget: { ...this.#budget, stop: this.#budget.stop ? { ...this.#budget.stop } : null },
    };
  }

  static fromView(view: LedgerView, table?: Readonly<Record<string, PriceRow>>): SessionLedger {
    const ledger = new SessionLedger(table);
    ledger.#executions = view.executions.map((item) => ({
      ...item,
      seen: true,
      last: clone(item.last),
      spent: clone(item.spent),
    }));
    ledger.#budget = { ...view.budget, stop: view.budget.stop ? { ...view.budget.stop } : null };
    ledger.#seq = view.executions.length;
    return ledger;
  }

  #parent(): Execution {
    for (let index = this.#executions.length - 1; index >= 0; index -= 1) {
      const item = this.#executions[index];
      if (item && item.kind !== 'subagent') return item;
    }
    return this.#open(this.#id('session'), 'session');
  }

  #open(id: string, kind: LedgerExecution['kind']): Execution {
    const execution = blank(id, kind);
    this.#executions.push(execution);
    return execution;
  }

  #id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}-${this.#seq}`;
  }

  #snapshot(report: UsageReport): TokenSnapshot {
    return {
      freshInput: finite(report.freshInput),
      cachedInput: finite(report.cachedInput),
      output: finite(report.output),
      costUsd: finite(report.costUsd),
    };
  }

  #dropped(execution: Execution, next: TokenSnapshot): boolean {
    if (!execution.seen) return false;
    return FIELDS.some((field) => {
      const value = next[field];
      const previous = execution.last[field];
      return value !== null && previous !== null && value < previous;
    });
  }

  #apply(execution: Execution, next: TokenSnapshot, model: string | null): void {
    const seen = execution.seen;
    for (const field of FIELDS) {
      const value = next[field];
      if (value === null) continue;
      const previous = execution.last[field];
      execution.last[field] = value;
      if (previous === null) {
        execution.spent[field] = seen ? null : value;
      } else if (execution.spent[field] !== null) {
        execution.spent[field] = (execution.spent[field] ?? 0) + (value - previous);
      }
    }
    if (model) execution.model = model;
    execution.seen = true;
  }

  #sum(executions: readonly Execution[]): TokenSnapshot {
    const total = { ...EMPTY };
    for (const field of FIELDS) {
      let sum = 0;
      for (const execution of executions) {
        const value = execution.spent[field];
        if (value === null) {
          sum = -1;
          break;
        }
        sum += value;
      }
      total[field] = executions.length === 0 || sum < 0 ? null : sum;
    }
    return total;
  }
}

/** O que o normalizador já pôs no contrato: totais da sessão, não um delta. */
export function reportFromUsage(usage: Partial<Usage>): UsageReport {
  const tokens = usage.tokens ?? null;
  const cached = tokens && tokens.cachedInput !== undefined ? tokens.cachedInput : null;
  const input = tokens ? tokens.input : null;
  const models = usage.models ?? [];
  return {
    freshInput: input !== null && cached !== null && input >= cached ? input - cached : null,
    cachedInput: cached,
    output: tokens ? tokens.output : null,
    costUsd: usage.costUsd === undefined ? null : usage.costUsd,
    model: models.length === 1 ? (models[0]?.model ?? null) : null,
  };
}

/** Estimativa de tabela. Sem linha de preço, ou sem tokens, fica null. */
export function estimateUsd(
  spent: TokenSnapshot,
  model: string | null,
  table: Readonly<Record<string, PriceRow>>,
): number | null {
  if (!model) return null;
  const row = table[model];
  if (!row) return null;
  if (spent.freshInput === null || spent.cachedInput === null || spent.output === null) return null;
  return spent.freshInput * row.fresh + spent.cachedInput * row.cached + spent.output * row.output;
}
