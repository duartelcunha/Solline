import { CORPUS, corpusSeal, type Split, type Task } from './corpus.ts';
import { MATRIX, type CapabilityStatus, type MatrixRow } from './matrix.ts';

/**
 * Ensaio emparelhado. Três braços, a mesma tarefa, a mesma ordem alternada.
 * O que ninguém mediu fica not-measured. Nunca se preenche com zero.
 */

export const ARMS = ['native-reference', 'solline-reference', 'solline-economy'] as const;
export type Arm = (typeof ARMS)[number];

export interface Absent {
  status: 'not-measured';
  reason: string;
}

export interface Present<T> {
  status: 'measured';
  value: T;
}

export type Reading<T> = Absent | Present<T>;

export const NO_CLIENT = 'Sem cliente de modelo nesta máquina.';
export const ECONOMY_OPT_IN =
  'O percurso económico fica opt-in até passar o piloto, e não há cliente.';
export const NO_OBSERVATION = 'O cliente estava disponível e não devolveu observação.';
export const BLIND_REQUIRED = 'A aceitação só conta com revisão que não viu a configuração.';
export const UNKNOWN_VALUE = 'O cliente não reportou este valor.';

export function measured<T>(value: T): Present<T> {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Um valor medido tem de ser finito.');
  }
  return { status: 'measured', value };
}

export function notMeasured(reason: string): Absent {
  const text = reason.trim();
  if (!text) throw new Error('Uma ausência precisa de motivo.');
  return { status: 'not-measured', reason: text };
}

/** null e undefined são ausência. Zero só passa quando foi mesmo reportado. */
export function numberReading(value: number | null | undefined, reason: string): Reading<number> {
  if (value === null || value === undefined) return notMeasured(reason);
  return measured(value);
}

export function booleanReading(
  value: boolean | null | undefined,
  reason: string,
): Reading<boolean> {
  if (value === null || value === undefined) return notMeasured(reason);
  return measured(value);
}

export interface RawObservation {
  accepted?: boolean | null;
  blind?: boolean | null;
  regressionWithin7Days?: boolean | null;
  attentionMinutes?: number | null;
  durationMs?: number | null;
  freshInputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
}

export interface ClientReach {
  native: boolean;
  solline: boolean;
  economy: boolean;
}

export interface Slot {
  taskId: string;
  split: Split;
  arm: Arm;
  /** 0 corre primeiro no par. O braço económico fica de fora do par e leva 2. */
  order: 0 | 1 | 2;
  accepted: Reading<boolean>;
  blind: Reading<boolean>;
  regressionWithin7Days: Reading<boolean>;
  attentionMinutes: Reading<number>;
  durationMs: Reading<number>;
  freshInputTokens: Reading<number>;
  cachedInputTokens: Reading<number>;
  outputTokens: Reading<number>;
}

export interface SmokeRow {
  id: string;
  code: CapabilityStatus;
  /** Correr isto contra um agente real é outra prova. Aqui fica explícito quando não correu. */
  agents: Absent;
}

export interface BaselineReport {
  recordedAt: string;
  corpusSeal: string;
  tasks: number;
  tuning: number;
  eval: number;
  clients: ClientReach;
  slots: readonly Slot[];
  acceptanceRate: Reading<number>;
  attentionMinutes: Reading<number>;
  tokensPerAccepted: Reading<number>;
  smoke: readonly SmokeRow[];
}

export interface RunRecord {
  id: string;
  lever: string | null;
  report: BaselineReport;
}

const SMOKE: readonly { id: string; rows: readonly string[] }[] = [
  { id: 'rules', rows: ['native-rules', 'no-md-autoload'] },
  { id: 'consult-no-bash', rows: ['consult-no-bash', 'consult-no-handoff'] },
  { id: 'commit-no-push', rows: ['commit-no-push'] },
  { id: 'push-confirmed', rows: ['push-confirmed'] },
  { id: 'ci-and-archive', rows: ['ci-and-archive', 'check-once'] },
];

const RANK: Record<CapabilityStatus, number> = { absent: 0, partial: 1, present: 2 };

export function orderOf(index: number, arm: Arm): 0 | 1 | 2 {
  if (arm === 'solline-economy') return 2;
  const nativeFirst = index % 2 === 0;
  if (arm === 'native-reference') return nativeFirst ? 0 : 1;
  return nativeFirst ? 1 : 0;
}

function reachable(arm: Arm, clients: ClientReach): string | null {
  if (arm === 'native-reference') return clients.native ? null : NO_CLIENT;
  if (arm === 'solline-reference') return clients.solline ? null : NO_CLIENT;
  return clients.economy ? null : ECONOMY_OPT_IN;
}

function blank(task: Task, arm: Arm, index: number, reason: string): Slot {
  const absent = notMeasured(reason);
  return {
    taskId: task.id,
    split: task.split,
    arm,
    order: orderOf(index, arm),
    accepted: absent,
    blind: absent,
    regressionWithin7Days: absent,
    attentionMinutes: absent,
    durationMs: absent,
    freshInputTokens: absent,
    cachedInputTokens: absent,
    outputTokens: absent,
  };
}

function fromObservation(task: Task, arm: Arm, index: number, raw: RawObservation): Slot {
  const blind = booleanReading(raw.blind, UNKNOWN_VALUE);
  const acceptedRaw = booleanReading(raw.accepted, UNKNOWN_VALUE);
  const accepted =
    blind.status === 'measured' && blind.value ? acceptedRaw : notMeasured(BLIND_REQUIRED);
  return {
    taskId: task.id,
    split: task.split,
    arm,
    order: orderOf(index, arm),
    accepted,
    blind,
    regressionWithin7Days: booleanReading(raw.regressionWithin7Days, UNKNOWN_VALUE),
    attentionMinutes: numberReading(raw.attentionMinutes, UNKNOWN_VALUE),
    durationMs: numberReading(raw.durationMs, UNKNOWN_VALUE),
    freshInputTokens: numberReading(raw.freshInputTokens, UNKNOWN_VALUE),
    cachedInputTokens: numberReading(raw.cachedInputTokens, UNKNOWN_VALUE),
    outputTokens: numberReading(raw.outputTokens, UNKNOWN_VALUE),
  };
}

/** Soma só quando todas as parcelas foram medidas. Uma ausência não vira zero. */
export function sumMeasured(readings: readonly Reading<number>[]): Reading<number> {
  if (readings.length === 0) return notMeasured('Não há parcelas.');
  let total = 0;
  for (const reading of readings) {
    if (reading.status === 'not-measured') {
      return notMeasured('Há parcelas por medir. A soma não substitui ausência por zero.');
    }
    total += reading.value;
  }
  return measured(total);
}

/** Taxa só quando todas as aceitações foram medidas. Uma ausência não conta como recusa. */
export function acceptanceRate(readings: readonly Reading<boolean>[]): Reading<number> {
  if (readings.length === 0) return notMeasured('Não há tarefas.');
  let yes = 0;
  for (const reading of readings) {
    if (reading.status === 'not-measured') {
      return notMeasured('Há tarefas por medir. A taxa não trata ausência como recusa.');
    }
    if (reading.value) yes += 1;
  }
  return measured(yes / readings.length);
}

/**
 * Tokens de todas as tentativas, a dividir pelas aceites. Falhas contam no numerador.
 * Se faltar um valor, ou se não houver aceite, o quociente fica por medir.
 */
export function tokensPerAccepted(slots: readonly Slot[]): Reading<number> {
  if (slots.length === 0) return notMeasured('Não há tentativas.');
  const parts = slots.flatMap((slot) => [
    slot.freshInputTokens,
    slot.cachedInputTokens,
    slot.outputTokens,
  ]);
  const total = sumMeasured(parts);
  if (total.status === 'not-measured') return total;
  const accepted = slots.filter(
    (slot) => slot.accepted.status === 'measured' && slot.accepted.value,
  );
  if (accepted.length === 0) {
    return notMeasured('Não há tarefas aceites neste conjunto. O consumo não se divide por zero.');
  }
  const unjudged = slots.some((slot) => slot.accepted.status === 'not-measured');
  if (unjudged) {
    return notMeasured('Há tentativas por julgar. O denominador não as trata como recusa.');
  }
  return measured(total.value / accepted.length);
}

function rowById(id: string): MatrixRow {
  const row = MATRIX.find((item) => item.id === id);
  if (!row) throw new Error(`A matriz não tem ${id}.`);
  return row;
}

export function smokeOf(agentsReason: string): SmokeRow[] {
  return SMOKE.map((item) => {
    const rows = item.rows.map(rowById);
    const code = rows.reduce<CapabilityStatus>(
      (worst, row) => (RANK[row.status] < RANK[worst] ? row.status : worst),
      'present',
    );
    return { id: item.id, code, agents: notMeasured(agentsReason) };
  });
}

export interface BaselineInput {
  tasks?: readonly Task[];
  clients: ClientReach;
  recordedAt: string;
  /** Quando o braço tem cliente e esta função não devolve nada, a célula fica por medir. */
  observe?: (input: { task: Task; arm: Arm; order: 0 | 1 | 2 }) => RawObservation | undefined;
}

export function runBaseline(input: BaselineInput): BaselineReport {
  const tasks = input.tasks ?? CORPUS;
  const recordedAt = input.recordedAt.trim();
  if (!recordedAt) throw new Error('A corrida precisa de data.');
  const slots = tasks.flatMap((task, index) =>
    ARMS.map((arm) => {
      const blocked = reachable(arm, input.clients);
      if (blocked) return blank(task, arm, index, blocked);
      const raw = input.observe?.({ task, arm, order: orderOf(index, arm) });
      if (!raw) return blank(task, arm, index, NO_OBSERVATION);
      return fromObservation(task, arm, index, raw);
    }),
  );
  const agentReason = slots.every((slot) => slot.accepted.status === 'not-measured')
    ? 'Nesta corrida nenhum braço teve aceitação medida.'
    : 'O smoke de código não substitui uma execução com agentes.';
  return {
    recordedAt,
    corpusSeal: corpusSeal(tasks),
    tasks: tasks.length,
    tuning: tasks.filter((task) => task.split === 'tuning').length,
    eval: tasks.filter((task) => task.split === 'eval').length,
    clients: { ...input.clients },
    slots,
    acceptanceRate: acceptanceRate(slots.map((slot) => slot.accepted)),
    attentionMinutes: sumMeasured(slots.map((slot) => slot.attentionMinutes)),
    tokensPerAccepted: tokensPerAccepted(slots),
    smoke: smokeOf(agentReason),
  };
}

export function baselineRun(report: BaselineReport): RunRecord {
  return { id: 'baseline', lever: null, report };
}

/** Uma alavanca de cada vez, numa corrida nova. A linha de base não se reescreve. */
export function withLever(parent: RunRecord, lever: string, report: BaselineReport): RunRecord {
  const name = lever.trim();
  if (!name) throw new Error('Uma alavanca precisa de nome.');
  if (parent.lever !== null) throw new Error('Uma corrida só acrescenta uma alavanca de cada vez.');
  if (report.corpusSeal !== parent.report.corpusSeal) {
    throw new Error('A alavanca tem de usar o mesmo corpus.');
  }
  return { id: `${parent.id}+${name}`, lever: name, report };
}
