import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAUDE_MD_EXCLUDES, READ_ONLY_DISALLOWED } from '../src/adapters/claude/sdk.ts';
import { CORPUS, FROZEN_SEAL, corpusSeal } from '../src/pilot/corpus.ts';
import {
  ATTENTION_PROXY,
  baselineRun,
  focusedMinutesPerAccepted,
  measured,
  notMeasured,
  numberReading,
  runBaseline,
  sumMeasured,
  withLever,
  type Slot,
} from '../src/pilot/harness.ts';
import { MATRIX } from '../src/pilot/matrix.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function slot(partial: Partial<Slot> & Pick<Slot, 'accepted' | 'focusedMinutes'>): Slot {
  const absent = notMeasured('fora deste caso');
  return {
    taskId: 't01',
    arm: 'solline-reference',
    order: 0,
    freshInputTokens: absent,
    cachedInputTokens: absent,
    outputTokens: absent,
    ...partial,
  };
}

describe('linha de base do M8', () => {
  it('congela 10 tarefas reais, sem divisão de afinação', () => {
    expect(CORPUS).toHaveLength(10);
    expect(new Set(CORPUS.map((task) => task.id)).size).toBe(CORPUS.length);
    expect(new Set(CORPUS.map((task) => task.source)).size).toBe(CORPUS.length);
    for (const [index, task] of CORPUS.entries()) {
      expect(task.id).toBe(`t${String(index + 1).padStart(2, '0')}`);
      expect(task.source).toMatch(/^[0-9a-f]{7}$/);
      expect(task.acceptance.length).toBeGreaterThan(0);
      expect(task.prompt.trim().length).toBeGreaterThan(0);
      execFileSync('git', ['cat-file', '-e', `${task.source}^{commit}`], { cwd: root });
    }
    expect(corpusSeal()).toBe(FROZEN_SEAL);
  });

  it('a matriz aponta para ficheiros que existem e vive só no código', () => {
    expect(new Set(MATRIX.map((row) => row.id)).size).toBe(MATRIX.length);
    for (const row of MATRIX) readFileSync(join(root, row.evidence));
    const byId = new Map(MATRIX.map((row) => [row.id, row.status]));
    expect(byId.get('linear')).toBe('partial');
    expect(byId.get('check-fix-loop')).toBe('absent');
    expect(byId.get('usage-ledger')).toBe('absent');
    expect(byId.get('approval-judge')).toBe('absent');
    expect(byId.get('model-routing')).toBe('absent');
    expect(byId.get('consult-no-bash')).toBe('present');
    expect(byId.get('no-md-autoload')).toBe('present');
  });

  it('o smoke de código confirma as proteções que a matriz diz presentes', () => {
    expect(CLAUDE_MD_EXCLUDES).toEqual([
      '**/CLAUDE.md',
      '**/CLAUDE.local.md',
      '**/AGENTS.md',
      '**/.claude/rules/**',
    ]);
    expect(READ_ONLY_DISALLOWED).toContain('Bash');
    const session = readFileSync(join(root, 'packages/engine/src/session-manager.ts'), 'utf8');
    expect(session).toContain('Uma consulta não passa o testemunho.');
    const codexDoc = readFileSync(
      join(root, 'packages/engine/src/adapters/codex/project-doc.ts'),
      'utf8',
    );
    expect(codexDoc).toContain('project_doc_max_bytes: 0');
    const report = runBaseline({
      clients: { native: false, solline: false },
      recordedAt: '2026-11-06T14:40:00Z',
    });
    expect(report.smoke.map((row) => [row.id, row.code])).toEqual([
      ['rules', 'present'],
      ['consult-no-bash', 'present'],
      ['commit-no-push', 'present'],
      ['push-confirmed', 'present'],
      ['ci-and-archive', 'present'],
    ]);
    expect(report.smoke.every((row) => row.agents.status === 'not-measured')).toBe(true);
  });

  it('sem cliente, a corrida é repetível e não transforma ausência em zero', () => {
    const input = {
      clients: { native: false, solline: false },
      recordedAt: '2026-11-06T14:40:00Z',
    };
    const first = runBaseline(input);
    const second = runBaseline(input);
    expect(second).toEqual(first);
    expect(first.tasks).toBe(10);
    expect(first.slots).toHaveLength(20);
    expect(first.acceptedTasks.status).toBe('not-measured');
    expect(first.acceptedTasksPerWeek.status).toBe('not-measured');
    if (first.acceptedTasksPerWeek.status === 'not-measured') {
      expect(first.acceptedTasksPerWeek.reason).toContain('semana');
    }
    expect(first.attentionProxy).toBe(ATTENTION_PROXY);
    expect(JSON.stringify(first)).not.toContain('"value":0');
  });

  it('zero reportado fica medido, e um campo em falta não entra na soma', () => {
    expect(numberReading(0, 'ausente')).toEqual({ status: 'measured', value: 0 });
    expect(numberReading(null, 'ausente').status).toBe('not-measured');
    expect(sumMeasured([measured(5), notMeasured('sem cache')]).status).toBe('not-measured');
    expect(sumMeasured([measured(0), measured(2)])).toEqual({ status: 'measured', value: 2 });
  });

  it('dois braços, o foco só conta na Solline, e os tokens só quando vêm', () => {
    const seen: string[] = [];
    const report = runBaseline({
      tasks: CORPUS.slice(0, 2),
      clients: { native: true, solline: true },
      recordedAt: '2026-11-06',
      observe: ({ task, arm }) => {
        seen.push(`${task.id}:${arm}`);
        return {
          accepted: true,
          focusedMinutes: arm === 'solline-reference' ? 12 : 99,
          freshInputTokens: arm === 'native-reference' ? 4 : null,
          outputTokens: 1,
        };
      },
    });
    expect(seen).toEqual([
      't01:native-reference',
      't01:solline-reference',
      't02:native-reference',
      't02:solline-reference',
    ]);
    const native = report.slots.find((item) => item.taskId === 't01' && item.arm === 'native-reference');
    const solline = report.slots.find(
      (item) => item.taskId === 't01' && item.arm === 'solline-reference',
    );
    expect(native?.order).toBe(0);
    expect(solline?.order).toBe(1);
    expect(report.slots.find((item) => item.taskId === 't02' && item.arm === 'native-reference')?.order).toBe(1);
    expect(native?.accepted).toEqual({ status: 'measured', value: true });
    expect(native?.focusedMinutes.status).toBe('not-measured');
    if (native?.focusedMinutes.status === 'not-measured') {
      expect(native.focusedMinutes.reason).toContain('janela da Solline');
    }
    expect(solline?.focusedMinutes).toEqual({ status: 'measured', value: 12 });
    expect(solline?.freshInputTokens.status).toBe('not-measured');
    expect(solline?.outputTokens).toEqual({ status: 'measured', value: 1 });
    expect(report.acceptedTasks).toEqual({ status: 'measured', value: 4 });
    expect(report.focusedMinutesPerAccepted).toEqual({ status: 'measured', value: 12 });
    expect(new Set(report.slots.map((item) => item.arm))).toEqual(
      new Set(['native-reference', 'solline-reference']),
    );
  });

  it('minutos em falta numa tarefa aceite não viram zero', () => {
    expect(
      focusedMinutesPerAccepted([
        slot({
          accepted: measured(true),
          focusedMinutes: measured(10),
        }),
        slot({
          taskId: 't02',
          accepted: measured(true),
          focusedMinutes: notMeasured('sem foco'),
        }),
      ]).status,
    ).toBe('not-measured');
  });

  it('uma alavanca é outra corrida, com o mesmo corpus', () => {
    const report = runBaseline({
      clients: { native: false, solline: false },
      recordedAt: '2026-11-06',
    });
    const base = baselineRun(report);
    const next = withLever(base, 'contexto', report);
    expect(base.lever).toBeNull();
    expect(next).toEqual({ id: 'baseline+contexto', lever: 'contexto', report });
    expect(() => withLever(next, 'outra', report)).toThrow(/uma alavanca/);
  });
});
