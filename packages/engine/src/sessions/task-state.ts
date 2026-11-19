import type {
  AgentId,
  CanonicalTaskState,
  Checks,
  HandoffDraftedBy,
  TaskFileRef,
  TaskVerificationState,
  TodoEntry,
  Turn,
} from '@solline/protocol';
import { textOf } from '../review.ts';

const MAX_DECISIONS = 20;

export function createTaskState(options: {
  sessionId: string;
  originalIntent?: string | undefined;
  handoffSummary?: CanonicalTaskState['handoffSummary'] | undefined;
  handoffTurnId?: string | undefined;
  activeRuleIds?: readonly string[] | undefined;
  now?: number | undefined;
}): CanonicalTaskState {
  return {
    version: 1,
    sessionId: options.sessionId,
    originalIntent: options.originalIntent ?? '',
    ...(options.handoffSummary ? { handoffSummary: options.handoffSummary } : {}),
    ...(options.handoffTurnId ? { handoffTurnId: options.handoffTurnId } : {}),
    plan: [],
    files: [],
    checkpointTurnIds: [],
    decisions: [],
    activeRuleIds: options.activeRuleIds ? [...new Set(options.activeRuleIds)] : [],
    usedMemoryIds: [],
    verification: { state: 'unknown', failedIds: [], repairFixes: 0 },
    updatedAt: options.now ?? Date.now(),
  };
}

function extractPlan(turns: readonly Turn[]): TodoEntry[] {
  for (let t = turns.length - 1; t >= 0; t -= 1) {
    const turn = turns[t];
    if (!turn) continue;
    for (let b = turn.blocks.length - 1; b >= 0; b -= 1) {
      const block = turn.blocks[b];
      if (block?.kind === 'todo') return structuredClone(block.entries);
    }
  }
  return [];
}

function extractDecisions(turns: readonly Turn[]): string[] {
  const decisions: string[] = [];
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (
        block.kind === 'plan' &&
        (block.status === 'allowed' || block.status === 'allowed-always')
      ) {
        const line = block.plan.replace(/\s+/g, ' ').trim().slice(0, 240);
        if (line && !decisions.includes(line)) decisions.push(line);
      } else if (block.kind === 'question' && block.status === 'allowed' && block.answers) {
        const summary = Object.entries(block.answers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ')
          .slice(0, 240);
        if (summary && !decisions.includes(summary)) decisions.push(summary);
      }
    }
  }
  return decisions.slice(-MAX_DECISIONS);
}

export function verificationFromChecks(
  checks: Checks | null | undefined,
  repairFixes = 0,
): TaskVerificationState {
  if (!checks || checks.results.length === 0) {
    return { state: 'unknown', failedIds: [], repairFixes };
  }
  const failedIds = checks.results
    .filter((r) => r.state === 'failed' || r.state === 'timeout')
    .map((r) => r.id);
  if (failedIds.length > 0) return { state: 'failing', failedIds, repairFixes };
  const allPassed = checks.results.every((r) => r.state === 'passed');
  return { state: allPassed ? 'passing' : 'unknown', failedIds: [], repairFixes };
}

export interface SyncTaskStateInput {
  turns?: readonly Turn[] | undefined;
  files?: readonly TaskFileRef[] | undefined;
  checkpointTurnIds?: readonly string[] | undefined;
  activeRuleIds?: readonly string[] | undefined;
  usedMemoryIds?: readonly string[] | undefined;
  checks?: Checks | null | undefined;
  repairFixes?: number | undefined;
  now?: number | undefined;
}

export function syncTaskState(
  current: CanonicalTaskState,
  input: SyncTaskStateInput,
): CanonicalTaskState {
  let originalIntent = current.originalIntent;
  if (!originalIntent && input.turns) {
    const firstHuman = input.turns.find(
      (t) => t.role === 'user' && t.id !== current.handoffTurnId,
    );
    if (firstHuman) {
      const text = textOf(firstHuman).trim();
      if (text) originalIntent = text;
    }
  }
  const plan = input.turns ? extractPlan(input.turns) : current.plan;
  const decisions = input.turns ? extractDecisions(input.turns) : current.decisions;
  const activeRuleIds = input.activeRuleIds
    ? [...new Set(input.activeRuleIds)]
    : current.activeRuleIds;
  const usedMemoryIds = input.usedMemoryIds
    ? [...new Set(input.usedMemoryIds)]
    : current.usedMemoryIds;
  const checkpointTurnIds = input.checkpointTurnIds
    ? [...input.checkpointTurnIds]
    : current.checkpointTurnIds;
  const files = input.files ? structuredClone([...input.files]) : current.files;
  const verification =
    input.checks !== undefined
      ? verificationFromChecks(input.checks, input.repairFixes ?? current.verification.repairFixes)
      : input.repairFixes !== undefined
        ? { ...current.verification, repairFixes: input.repairFixes }
        : current.verification;
  return {
    ...current,
    originalIntent,
    plan,
    files,
    checkpointTurnIds,
    decisions,
    activeRuleIds,
    usedMemoryIds,
    verification,
    updatedAt: input.now ?? Date.now(),
  };
}

/**
 * Constrói o estado canónico da sessão que recebe o testemunho: preserva o `originalIntent` real
 * do utilizador (ou o objetivo explícito escrito por ele no diálogo de passagem) e coloca o
 * rascunho escrito pelo modelo em quarentena (`handoffSummary`) com `handoffTurnId`, para nunca
 * ser entregue ao revisor como verdade do pedido.
 */
export function buildHandoffTaskState(options: {
  targetSessionId: string;
  sourceState: CanonicalTaskState;
  sourceSessionId: string;
  sourceAgent: AgentId;
  summaryText: string;
  draftedBy?: HandoffDraftedBy | undefined;
  goal?: string | undefined;
  handoffTurnId?: string | undefined;
  activeRuleIds?: readonly string[] | undefined;
  now?: number | undefined;
}): CanonicalTaskState {
  const goal = options.goal?.trim() ?? '';
  const sourceIntent = options.sourceState.originalIntent.trim();
  const originalIntent = goal
    ? sourceIntent && sourceIntent !== goal
      ? `${sourceIntent}\n\nObjetivo da passagem: ${goal}`
      : goal
    : sourceIntent;
  return {
    version: 1,
    sessionId: options.targetSessionId,
    originalIntent,
    handoffSummary: {
      text: options.summaryText,
      draftedBy: options.draftedBy ?? 'model',
      sourceSessionId: options.sourceSessionId,
      sourceAgent: options.sourceAgent,
    },
    ...(options.handoffTurnId ? { handoffTurnId: options.handoffTurnId } : {}),
    plan: structuredClone(options.sourceState.plan),
    files: structuredClone(options.sourceState.files),
    checkpointTurnIds: [],
    decisions: [...options.sourceState.decisions],
    activeRuleIds: options.activeRuleIds
      ? [...new Set(options.activeRuleIds)]
      : [...options.sourceState.activeRuleIds],
    usedMemoryIds: [...options.sourceState.usedMemoryIds],
    verification: { ...options.sourceState.verification, repairFixes: 0 },
    updatedAt: options.now ?? Date.now(),
  };
}

export function trimTaskStateToTurn(
  state: CanonicalTaskState,
  keptTurns: readonly Turn[],
  checkpointTurnIds: readonly string[],
  now?: number | undefined,
): CanonicalTaskState {
  const handoffStillPresent =
    state.handoffTurnId !== undefined &&
    keptTurns.some((turn) => turn.id === state.handoffTurnId);
  const { handoffTurnId: _dropped, ...withoutTurnId } = state;
  return {
    ...(handoffStillPresent && state.handoffTurnId
      ? { ...withoutTurnId, handoffTurnId: state.handoffTurnId }
      : withoutTurnId),
    plan: extractPlan(keptTurns),
    decisions: extractDecisions(keptTurns),
    checkpointTurnIds: [...checkpointTurnIds],
    updatedAt: now ?? Date.now(),
  };
}

/**
 * Pedido entregue à segunda opinião. Nunca usa o rascunho escrito pelo agente anterior como pedido
 * real: o turno de abertura da passagem (`handoffTurnId`) fica excluído e entra `originalIntent` +
 * apenas os pedidos posteriores escritos pelo utilizador.
 */
export function reviewerRequestFor(
  taskState: CanonicalTaskState,
  turns: readonly Turn[],
  turnId: string,
  whole: boolean,
): string {
  const humanTurns = turns.filter((t) => t.role === 'user' && t.id !== taskState.handoffTurnId);
  if (!whole) {
    if (taskState.handoffTurnId && turnId === taskState.handoffTurnId) {
      return taskState.originalIntent;
    }
    const turn = humanTurns.find((t) => t.id === turnId);
    return turn ? textOf(turn) : taskState.handoffSummary ? taskState.originalIntent : '';
  }
  const parts: string[] = [];
  const origin = taskState.originalIntent.trim();
  if (origin) parts.push(origin);
  for (const turn of humanTurns) {
    const text = textOf(turn).trim();
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.length <= 1
    ? (parts[0] ?? '')
    : parts
        .map((text, i) => `${i + 1}. ${text}`)
        .join('\n\n')
        .slice(0, 6_000);
}
