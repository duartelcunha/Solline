import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAUDE_MD_EXCLUDES, READ_ONLY_DISALLOWED } from '../src/adapters/claude/sdk.ts';
import { CORPUS, FROZEN_SEAL, corpusSeal, splitFor } from '../src/pilot/corpus.ts';
import {
  acceptanceRate,
  baselineRun,
  measured,
  notMeasured,
  numberReading,
  runBaseline,
  sumMeasured,
  tokensPerAccepted,
  withLever,
  type Slot,
} from '../src/pilot/harness.ts';
import { MATRIX, matrixMarkdown } from '../src/pilot/matrix.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function slot(
  partial: Pick<Slot, 'accepted' | 'freshInputTokens' | 'cachedInputTokens' | 'outputTokens'> &
    Partial<Slot>,
): Slot {
  const absent = notMeasured('fora deste caso');
  return {
    taskId: 't01',
    split: 'tuning',
    arm: 'solline-reference',
    order: 0,
    blind: measured(true),
    regressionWithin7Days: absent,
    attentionMinutes: absent,
    durationMs: absent,
    ...partial,
  };
}

describe('linha de base do M8', () => {
  it('congela 42 tarefas reais, com afinação e avaliação separadas', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(30);
    expect(CORPUS.length).toBeLessThanOrEqual(50);
    expect(CORPUS.length).toBe(42);
    expect(new Set(CORPUS.map((task) => task.id)).size).toBe(CORPUS.length);
    expect(new Set(CORPUS.map((task) => task.source)).size).toBe(CORPUS.length);
    for (const [index, task] of CORPUS.entries()) {
      expect(task.id).toBe(`t${String(index + 1).padStart(2, '0')}`);
      expect(task.split).toBe(splitFor(index));
      expect(task.source).toMatch(/^[0-9a-f]{7}$/);
      expect(task.acceptance.length).toBeGreaterThan(0);
      expect(task.prompt.trim().length).toBeGreaterThan(0);
      execFileSync('git', ['cat-file', '-e', `${task.source}^{commit}`], { cwd: root });
    }
    expect(CORPUS.filter((task) => task.split === 'eval')).toHaveLength(14);
    expect(CORPUS.filter((task) => task.split === 'tuning')).toHaveLength(28);
    expect(corpusSeal()).toBe(FROZEN_SEAL);
  });

  it('a matriz aponta para ficheiros que existem e a página diz o mesmo', () => {
    expect(new Set(MATRIX.map((row) => row.id)).size).toBe(MATRIX.length);
    for (const row of MATRIX) {
      readFileSync(join(root, row.evidence));
    }
    expect(readFileSync(join(root, 'docs/M8-matriz.md'), 'utf8')).toBe(matrixMarkdown());
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
      clients: { native: false, solline: false, economy: false },
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
      clients: { native: false, solline: false, economy: false },
      recordedAt: '2026-11-06T14:40:00Z',
    };
    const first = runBaseline(input);
    const second = runBaseline(input);
    expect(second).toEqual(first);
    expect(first.tasks).toBe(42);
    expect(first.slots).toHaveLength(42 * 3);
    expect(first.acceptanceRate.status).toBe('not-measured');
    expect(first.attentionMinutes.status).toBe('not-measured');
    expect(first.tokensPerAccepted.status).toBe('not-measured');
    expect(JSON.stringify(first)).not.toContain('"value":0');
    for (const reading of first.slots.flatMap((item) => [
      item.freshInputTokens,
      item.cachedInputTokens,
      item.outputTokens,
      item.attentionMinutes,
    ])) {
      expect(reading).toEqual({ status: 'not-measured', reason: expect.any(String) });
    }
  });

  it('zero reportado fica medido, e um campo em falta não entra na soma', () => {
    expect(numberReading(0, 'ausente')).toEqual({ status: 'measured', value: 0 });
    expect(numberReading(null, 'ausente').status).toBe('not-measured');
    expect(numberReading(undefined, 'ausente').status).toBe('not-measured');
    const mixed = sumMeasured([measured(5), notMeasured('sem cache')]);
    expect(mixed.status).toBe('not-measured');
    if (mixed.status === 'not-measured') expect(mixed.reason).not.toBe('');
    expect(sumMeasured([measured(0), measured(2)])).toEqual({ status: 'measured', value: 2 });
    const rate = acceptanceRate([measured(true), notMeasured('sem revisão')]);
    expect(rate.status).toBe('not-measured');
  });

  it('não chama o observador num braço sem cliente e exige revisão cega', () => {
    const seen: string[] = [];
    const report = runBaseline({
      tasks: CORPUS.slice(0, 2),
      clients: { native: true, solline: true, economy: false },
      recordedAt: '2026-11-06',
      observe: ({ task, arm }) => {
        seen.push(`${task.id}:${arm}`);
        return {
          accepted: true,
          blind: arm === 'native-reference',
          attentionMinutes: 10,
          freshInputTokens: arm === 'native-reference' ? 4 : null,
          cachedInputTokens: 0,
          outputTokens: 1,
          durationMs: 1000,
          regressionWithin7Days: false,
        };
      },
    });
    expect(seen.some((name) => name.endsWith(':solline-economy'))).toBe(false);
    expect(seen).toContain('t01:native-reference');
    expect(seen).toContain('t02:solline-reference');
    const native = report.slots.find(
      (item) => item.taskId === 't01' && item.arm === 'native-reference',
    );
    const solline = report.slots.find(
      (item) => item.taskId === 't01' && item.arm === 'solline-reference',
    );
    const economy = report.slots.find((item) => item.arm === 'solline-economy');
    expect(native?.order).toBe(0);
    expect(solline?.order).toBe(1);
    expect(
      report.slots.find((item) => item.taskId === 't02' && item.arm === 'native-reference')?.order,
    ).toBe(1);
    expect(native?.accepted).toEqual({ status: 'measured', value: true });
    expect(solline?.accepted.status).toBe('not-measured');
    expect(solline?.freshInputTokens.status).toBe('not-measured');
    expect(solline?.cachedInputTokens).toEqual({ status: 'measured', value: 0 });
    expect(economy?.accepted.status).toBe('not-measured');
    expect(economy?.accepted).toMatchObject({
      reason: expect.stringContaining('opt-in'),
    });
    expect(report.acceptanceRate.status).toBe('not-measured');
    expect(report.tokensPerAccepted.status).toBe('not-measured');
  });

  it('o consumo por aceite inclui as falhas e não divide por zero', () => {
    const absent = notMeasured('fora deste caso');
    const used = (value: number) => measured(value);
    const accepted = slot({
      accepted: measured(true),
      freshInputTokens: used(2),
      cachedInputTokens: used(1),
      outputTokens: used(1),
    });
    const failed = slot({
      taskId: 't02',
      accepted: measured(false),
      freshInputTokens: used(4),
      cachedInputTokens: used(0),
      outputTokens: used(2),
    });
    expect(tokensPerAccepted([accepted, failed])).toEqual({ status: 'measured', value: 10 });
    expect(tokensPerAccepted([failed]).status).toBe('not-measured');
    expect(
      tokensPerAccepted([
        slot({
          accepted: measured(true),
          freshInputTokens: used(1),
          cachedInputTokens: absent,
          outputTokens: used(1),
        }),
      ]).status,
    ).toBe('not-measured');
  });

  it('uma alavanca é outra corrida, com o mesmo corpus', () => {
    const report = runBaseline({
      clients: { native: false, solline: false, economy: false },
      recordedAt: '2026-11-06',
    });
    const base = baselineRun(report);
    const next = withLever(base, 'contexto', report);
    expect(base.lever).toBeNull();
    expect(next).toEqual({ id: 'baseline+contexto', lever: 'contexto', report });
    expect(() => withLever(next, 'outra', report)).toThrow(/uma alavanca/);
    const other = runBaseline({
      tasks: CORPUS.slice(0, 1),
      clients: { native: false, solline: false, economy: false },
      recordedAt: '2026-11-06',
    });
    expect(() => withLever(base, 'contexto', other)).toThrow(/mesmo corpus/);
  });
});
