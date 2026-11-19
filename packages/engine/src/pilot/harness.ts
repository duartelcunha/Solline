import { CORPUS, FROZEN_SEAL, corpusSeal, type Task } from './corpus.ts';
import { MATRIX, type CapabilityStatus, type MatrixRow } from './matrix.ts';

/**
 * Ensaio de duas pontas, o mesmo modelo: cliente nativo e Solline.
 * O que ninguém mediu fica not-measured. Nunca se preenche com zero.
 * Os tokens só entram quando o cliente os reportou.
 */

export const ARMS = ['native-reference', 'solline-reference'] as const;
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
export const NO_OBSERVATION = 'O cliente estava disponível e não devolveu observação.';
export const UNKNOWN_VALUE = 'O cliente não reportou este valor.';
export const NATIVE_FOCUS = 'O cliente nativo não tem a janela da Solline.';
export const NOT_A_WEEK = 'Esta corrida não cobre uma semana. Os aceites não se promovem a taxa semanal.';

/** O que estes minutos medem: a janela da Solline em foco, um proxy da atenção, não a atenção em si. */
export const ATTENTION_PROXY = 'minutos com a janela da Solline em foco';

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
  /** Minutos com a janela da Solline em foco. Ignorado no braço nativo. */
  focusedMinutes?: number | null;
  /** Minutos ativos da tarefa, medidos de forma simétrica nos dois braços. */
  wallMinutes?: number | null;
  /** Número de intervenções manuais de recuperação durante a tarefa. */
  manualRecoveries?: number | null;
  /** RAM de pico da árvore de processos (MB). */
  peakRssMb?: number | null;
  /** Tempo de arranque a frio do cliente (ms). */
  coldStartMs?: number | null;
  freshInputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
}

export interface ClientReach {
  native: boolean;
  solline: boolean;
}

export interface Slot {
  taskId: string;
  arm: Arm;
  /** 0 corre primeiro neste par. */
  order: 0 | 1;
  accepted: Reading<boolean>;
  focusedMinutes: Reading<number>;
  wallMinutes: Reading<number>;
  manualRecoveries: Reading<number>;
  peakRssMb: Reading<number>;
  coldStartMs: Reading<number>;
  freshInputTokens: Reading<number>;
  cachedInputTokens: Reading<number>;
  outputTokens: Reading<number>;
}

export interface SmokeRow {
  id: string;
  code: CapabilityStatus;
  agents: Absent;
}

export interface BaselineReport {
  recordedAt: string;
  corpusSeal: string;
  tasks: number;
  clients: ClientReach;
  slots: readonly Slot[];
  /** Aceites nesta corrida, só quando todas as células foram julgadas. */
  acceptedTasks: Reading<number>;
  nativeAcceptedTasks: Reading<number>;
  sollineAcceptedTasks: Reading<number>;
  /** Não se calcula a partir de uma corrida só. */
  acceptedTasksPerWeek: Reading<number>;
  /** Proxy: minutos de foco da janela Solline a dividir pelas tarefas aceites nesse braço. */
  focusedMinutesPerAccepted: Reading<number>;
  nativeWallMinutesPerAccepted: Reading<number>;
  sollineWallMinutesPerAccepted: Reading<number>;
  nativeManualRecoveriesTotal: Reading<number>;
  sollineManualRecoveriesTotal: Reading<number>;
  sollinePeakRssMbMax: Reading<number>;
  sollineColdStartMsMedian: Reading<number>;
  attentionProxy: typeof ATTENTION_PROXY;
  smoke: readonly SmokeRow[];
}

export interface PilotGateThresholds {
  minWallReductionRatio: number;
  maxPeakRssMbTrigger: number;
  maxColdStartMsTrigger: number;
}

export const DEFAULT_PILOT_GATE_THRESHOLDS: PilotGateThresholds = {
  minWallReductionRatio: 0.15,
  maxPeakRssMbTrigger: 1500,
  maxColdStartMsTrigger: 5000,
};

export interface PilotGateResult {
  status: 'pass' | 'fail' | 'incomplete';
  reasons: readonly string[];
  tauriShellReviewRecommended: boolean;
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

export function orderOf(index: number, arm: Arm): 0 | 1 {
  const nativeFirst = index % 2 === 0;
  if (arm === 'native-reference') return nativeFirst ? 0 : 1;
  return nativeFirst ? 1 : 0;
}

function reachable(arm: Arm, clients: ClientReach): string | null {
  if (arm === 'native-reference') return clients.native ? null : NO_CLIENT;
  return clients.solline ? null : NO_CLIENT;
}

function blank(task: Task, arm: Arm, index: number, reason: string): Slot {
  const absent = notMeasured(reason);
  return {
    taskId: task.id,
    arm,
    order: orderOf(index, arm),
    accepted: absent,
    focusedMinutes: arm === 'native-reference' ? notMeasured(NATIVE_FOCUS) : absent,
    wallMinutes: absent,
    manualRecoveries: absent,
    peakRssMb: absent,
    coldStartMs: absent,
    freshInputTokens: absent,
    cachedInputTokens: absent,
    outputTokens: absent,
  };
}

function fromObservation(task: Task, arm: Arm, index: number, raw: RawObservation): Slot {
  return {
    taskId: task.id,
    arm,
    order: orderOf(index, arm),
    accepted: booleanReading(raw.accepted, UNKNOWN_VALUE),
    focusedMinutes:
      arm === 'native-reference'
        ? notMeasured(NATIVE_FOCUS)
        : numberReading(raw.focusedMinutes, UNKNOWN_VALUE),
    wallMinutes: numberReading(raw.wallMinutes, UNKNOWN_VALUE),
    manualRecoveries: numberReading(raw.manualRecoveries, UNKNOWN_VALUE),
    peakRssMb: numberReading(raw.peakRssMb, UNKNOWN_VALUE),
    coldStartMs: numberReading(raw.coldStartMs, UNKNOWN_VALUE),
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

function maxMeasured(readings: readonly Reading<number>[]): Reading<number> {
  if (readings.length === 0) return notMeasured('Não há leituras.');
  let best = -Infinity;
  for (const reading of readings) {
    if (reading.status === 'not-measured') {
      return notMeasured('Há leituras por medir. O máximo não ignora ausências.');
    }
    if (reading.value > best) best = reading.value;
  }
  return measured(best);
}

function medianMeasured(readings: readonly Reading<number>[]): Reading<number> {
  if (readings.length === 0) return notMeasured('Não há leituras.');
  const values: number[] = [];
  for (const reading of readings) {
    if (reading.status === 'not-measured') {
      return notMeasured('Há leituras por medir. A mediana não ignora ausências.');
    }
    values.push(reading.value);
  }
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const hi = values[mid];
  if (hi === undefined) return notMeasured('Não há leituras.');
  if (values.length % 2 === 1) return measured(hi);
  const lo = values[mid - 1];
  return lo === undefined ? measured(hi) : measured((lo + hi) / 2);
}

function acceptedCount(slots: readonly Slot[]): Reading<number> {
  if (slots.length === 0) return notMeasured('Não há tarefas.');
  let yes = 0;
  for (const slot of slots) {
    if (slot.accepted.status === 'not-measured') {
      return notMeasured('Há tarefas por medir. A contagem não trata ausência como recusa.');
    }
    if (slot.accepted.value) yes += 1;
  }
  return measured(yes);
}

function armSlots(slots: readonly Slot[], arm: Arm): Slot[] {
  return slots.filter((slot) => slot.arm === arm);
}

function wallMinutesPerAccepted(slots: readonly Slot[], arm: Arm): Reading<number> {
  const side = armSlots(slots, arm);
  if (side.length === 0) return notMeasured('Não há tarefas neste braço.');
  if (side.some((slot) => slot.accepted.status === 'not-measured')) {
    return notMeasured('Há tarefas por julgar. O denominador não as trata como recusa.');
  }
  const accepted = side.filter(
    (slot) => slot.accepted.status === 'measured' && slot.accepted.value,
  );
  if (accepted.length === 0) return notMeasured('Não há tarefa aceite neste braço.');
  const minutes = sumMeasured(accepted.map((slot) => slot.wallMinutes));
  if (minutes.status === 'not-measured') return minutes;
  return measured(minutes.value / accepted.length);
}

/** Minutos de foco da Solline por tarefa aceite nesse braço. Falta de minutos não vira zero. */
export function focusedMinutesPerAccepted(slots: readonly Slot[]): Reading<number> {
  const solline = armSlots(slots, 'solline-reference');
  const accepted = solline.filter(
    (slot) => slot.accepted.status === 'measured' && slot.accepted.value,
  );
  if (solline.some((slot) => slot.accepted.status === 'not-measured')) {
    return notMeasured('Há tarefas por julgar. O denominador não as trata como recusa.');
  }
  if (accepted.length === 0) return notMeasured('Não há tarefa aceite na Solline.');
  const minutes = sumMeasured(accepted.map((slot) => slot.focusedMinutes));
  if (minutes.status === 'not-measured') return minutes;
  return measured(minutes.value / accepted.length);
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
  observe?: (input: { task: Task; arm: Arm; order: 0 | 1 }) => RawObservation | undefined;
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
  const native = armSlots(slots, 'native-reference');
  const solline = armSlots(slots, 'solline-reference');
  const agentReason = slots.every((slot) => slot.accepted.status === 'not-measured')
    ? 'Nesta corrida nenhum braço teve aceitação medida.'
    : 'O smoke de código não substitui uma execução com agentes.';
  return {
    recordedAt,
    corpusSeal: corpusSeal(tasks),
    tasks: tasks.length,
    clients: { ...input.clients },
    slots,
    acceptedTasks: acceptedCount(slots),
    nativeAcceptedTasks: acceptedCount(native),
    sollineAcceptedTasks: acceptedCount(solline),
    acceptedTasksPerWeek: notMeasured(NOT_A_WEEK),
    focusedMinutesPerAccepted: focusedMinutesPerAccepted(slots),
    nativeWallMinutesPerAccepted: wallMinutesPerAccepted(slots, 'native-reference'),
    sollineWallMinutesPerAccepted: wallMinutesPerAccepted(slots, 'solline-reference'),
    nativeManualRecoveriesTotal: sumMeasured(native.map((slot) => slot.manualRecoveries)),
    sollineManualRecoveriesTotal: sumMeasured(solline.map((slot) => slot.manualRecoveries)),
    sollinePeakRssMbMax: maxMeasured(solline.map((slot) => slot.peakRssMb)),
    sollineColdStartMsMedian: medianMeasured(solline.map((slot) => slot.coldStartMs)),
    attentionProxy: ATTENTION_PROXY,
    smoke: smokeOf(agentReason),
  };
}

/** Avalia se o piloto M8.5 aprova o avanço para o M9 e se dispara revisão da casca Electron -> Tauri v2. */
export function evaluatePilotGate(
  report: BaselineReport,
  thresholds: Partial<PilotGateThresholds> = {},
): PilotGateResult {
  const t = { ...DEFAULT_PILOT_GATE_THRESHOLDS, ...thresholds };
  const reasons: string[] = [];
  const tauriShellReviewRecommended =
    (report.sollinePeakRssMbMax.status === 'measured' &&
      report.sollinePeakRssMbMax.value > t.maxPeakRssMbTrigger) ||
    (report.sollineColdStartMsMedian.status === 'measured' &&
      report.sollineColdStartMsMedian.value > t.maxColdStartMsTrigger);
  if (tauriShellReviewRecommended) {
    reasons.push(
      `Orçamento de recursos excedido (RAM máx. ${report.sollinePeakRssMbMax.status === 'measured' ? `${report.sollinePeakRssMbMax.value} MB` : 'n/d'}, arranque mediano ${report.sollineColdStartMsMedian.status === 'measured' ? `${report.sollineColdStartMsMedian.value} ms` : 'n/d'}): avaliar casca Tauri v2.`,
    );
  }

  if (report.corpusSeal !== FROZEN_SEAL) {
    return {
      status: 'incomplete',
      reasons: ['O corpus não corresponde ao selo congelado do M8.', ...reasons],
      tauriShellReviewRecommended,
    };
  }
  if (report.tasks !== CORPUS.length) {
    return {
      status: 'incomplete',
      reasons: [`A corrida tem ${report.tasks} tarefas; o portão exige ${CORPUS.length}.`, ...reasons],
      tauriShellReviewRecommended,
    };
  }
  if (
    report.nativeAcceptedTasks.status === 'not-measured' ||
    report.sollineAcceptedTasks.status === 'not-measured'
  ) {
    return {
      status: 'incomplete',
      reasons: ['Faltam leituras de aceitação em pelo menos um dos braços.', ...reasons],
      tauriShellReviewRecommended,
    };
  }
  const wallMeasured =
    report.nativeWallMinutesPerAccepted.status === 'measured' &&
    report.sollineWallMinutesPerAccepted.status === 'measured';
  const recoveriesMeasured =
    report.nativeManualRecoveriesTotal.status === 'measured' &&
    report.sollineManualRecoveriesTotal.status === 'measured';
  if (!wallMeasured && !recoveriesMeasured) {
    return {
      status: 'incomplete',
      reasons: [
        'Faltam medições comparáveis de tempo ativo e de recuperações manuais.',
        ...reasons,
      ],
      tauriShellReviewRecommended,
    };
  }

  if (report.sollineAcceptedTasks.value < report.nativeAcceptedTasks.value) {
    return {
      status: 'fail',
      reasons: [
        `Regressão na aceitação: Solline ${report.sollineAcceptedTasks.value} vs. nativo ${report.nativeAcceptedTasks.value}.`,
        ...reasons,
      ],
      tauriShellReviewRecommended,
    };
  }

  const wallImproved =
    report.nativeWallMinutesPerAccepted.status === 'measured' &&
    report.sollineWallMinutesPerAccepted.status === 'measured' &&
    report.nativeWallMinutesPerAccepted.value > 0 &&
    (report.nativeWallMinutesPerAccepted.value - report.sollineWallMinutesPerAccepted.value) /
      report.nativeWallMinutesPerAccepted.value +
      1e-12 >=
      t.minWallReductionRatio;

  const recoveriesImproved =
    report.nativeManualRecoveriesTotal.status === 'measured' &&
    report.sollineManualRecoveriesTotal.status === 'measured' &&
    report.sollineManualRecoveriesTotal.value < report.nativeManualRecoveriesTotal.value;

  if (!wallImproved && !recoveriesImproved) {
    return {
      status: 'fail',
      reasons: [
        'Sem ganho mínimo no tempo ativo por tarefa aceite nem redução de recuperações manuais.',
        ...reasons,
      ],
      tauriShellReviewRecommended,
    };
  }

  const passReasons: string[] = [
    `Zero regressão na aceitação (${report.sollineAcceptedTasks.value}/${report.tasks} na Solline vs. ${report.nativeAcceptedTasks.value}/${report.tasks} no nativo).`,
  ];
  if (wallImproved) passReasons.push('Redução de tempo ativo por tarefa aceite atinge o limiar.');
  if (recoveriesImproved) passReasons.push('Redução nas intervenções manuais de recuperação.');
  return {
    status: 'pass',
    reasons: [...passReasons, ...reasons],
    tauriShellReviewRecommended,
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
