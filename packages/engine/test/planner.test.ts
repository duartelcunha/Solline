import { describe, expect, it } from 'vitest';
import type { SplitPart } from '@solline/protocol';
import { claudePlanner, parsePlan, plannerPrompt } from '../src/races/planner.ts';
import { Engine } from '../src/index.ts';

const checks = [
  { id: 'test', label: 'Testes' },
  { id: 'lint', label: 'Lint' },
];

const part = (title: string, over: Partial<SplitPart> = {}): SplitPart => ({
  title,
  goal: `fazer ${title}`,
  allowed: [`src/${title}/**`],
  forbidden: [],
  interfaces: '',
  expected: 'feito',
  check: 'test',
  zero: false,
  ...over,
});

/** Um queryFn falso que devolve um resultado e guarda o que o planeador lhe pediu. */
function fake(result: Record<string, unknown>) {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  const queryFn = ((args: { prompt: string; options: Record<string, unknown> }) => {
    calls.push(args);
    return (async function* () {
      yield { type: 'result', subtype: 'success', ...result };
    })();
  }) as never;
  return { queryFn, calls };
}

const input = { cwd: '.', request: 'faz', checks };

describe('o planeador Claude', () => {
  it('devolve o plano e o custo quando propõe partir', async () => {
    const { queryFn } = fake({
      total_cost_usd: 0.12,
      structured_output: {
        decision: 'split',
        reason: 'Duas zonas separadas.',
        parts: [part('api'), part('ui', { check: null })],
      },
    });
    const { plan, cost } = await claudePlanner({ queryFn })(input);
    expect(cost).toBe(0.12);
    expect(plan.decision).toBe('split');
    if (plan.decision !== 'split') throw new Error('esperava split');
    expect(plan.parts.map((p) => p.title)).toEqual(['api', 'ui']);
    expect(plan.parts[1]?.check).toBeNull();
  });

  it('"não partir" traz a razão; sem custo no resultado fica null', async () => {
    const { queryFn } = fake({
      structured_output: { decision: 'keep', reason: 'É pequeno.', parts: [] },
    });
    const out = await claudePlanner({ queryFn })(input);
    expect(out).toEqual({ plan: { decision: 'keep', reason: 'É pequeno.' }, cost: null });
  });

  it('só lê: ferramentas de leitura, sem sessão gravada, sem definições', async () => {
    const { queryFn, calls } = fake({
      structured_output: { decision: 'keep', reason: 'x', parts: [] },
    });
    await claudePlanner({ queryFn })({ ...input, cwd: 'C:/proj' });
    const options = calls[0]?.options as Record<string, unknown>;
    expect(options.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(options.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(options.permissionMode).toBe('default');
    expect(options.persistSession).toBe(false);
    expect(options.settingSources).toEqual([]);
    expect(options.cwd).toBe('C:/proj');
    const canUse = options.canUseTool as (
      name: string,
      input: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;
    expect((await canUse('Read', {})).behavior).toBe('allow');
    expect((await canUse('Bash', {})).behavior).toBe('deny');
    expect((await canUse('Edit', {})).behavior).toBe('deny');
  });

  it('o pedido e as verificações vão no prompt', () => {
    const prompt = plannerPrompt('faz a coisa', checks);
    expect(prompt).toContain('faz a coisa');
    expect(prompt).toContain('- test: Testes');
    expect(plannerPrompt('x', [])).toContain('none');
  });

  it('formato errado é um erro claro, não um "não partir" calado', async () => {
    const bad = fake({ structured_output: { decision: 'talvez' } });
    await expect(claudePlanner({ queryFn: bad.queryFn })(input)).rejects.toThrow(
      'formato inesperado',
    );
    const none = fake({});
    await expect(claudePlanner({ queryFn: none.queryFn })(input)).rejects.toThrow(
      'formato inesperado',
    );
  });

  it('um split que não cumpre o contrato é um erro com o sítio do problema', () => {
    expect(() => parsePlan({ decision: 'split', reason: 'r', parts: [part('só-uma')] })).toThrow(
      /não é válido \(parts\)/,
    );
    expect(() =>
      parsePlan({ decision: 'split', reason: 'r', parts: [part('a'), part('z', { zero: true })] }),
    ).toThrow(/zero|primeira/i);
  });

  it('falhas do SDK são erros', async () => {
    const failed = (() =>
      (async function* () {
        yield { type: 'result', subtype: 'error_max_turns' };
      })()) as never;
    await expect(claudePlanner({ queryFn: failed })(input)).rejects.toThrow('não conseguiu acabar');
    const silent = (() => (async function* () {})()) as never;
    await expect(claudePlanner({ queryFn: silent })(input)).rejects.toThrow('sem resposta');
  });
});

describe('os comandos split no motor', () => {
  it('split.planNow junta a revisão ao plano e split.review confere à mão', async () => {
    const engine = new Engine({
      isolated: true,
      planner: async () => ({
        plan: {
          decision: 'split',
          reason: 'Duas zonas.',
          parts: [part('a'), part('b', { check: null })],
        },
        cost: 0.5,
      }),
    });
    try {
      const planned = await engine.handle({
        kind: 'request',
        id: '1',
        command: 'split.planNow',
        payload: { text: 'faz', cwd: '.', checks },
      });
      expect(planned).toMatchObject({
        ok: true,
        result: {
          cost: 0.5,
          plan: { decision: 'split' },
          review: { sequential: [[0]], costMultiplier: 1 },
        },
      });
      const reviewed = await engine.handle({
        kind: 'request',
        id: '2',
        command: 'split.review',
        payload: { parts: [part('a'), part('b')], checkIds: ['test'] },
      });
      expect(reviewed).toMatchObject({
        ok: true,
        result: { sequential: [[0], [1]], costMultiplier: 2 },
      });
    } finally {
      await engine.dispose();
    }
  });

  it('"não partir" custa um agente e nada para lançar; sem planeador é erro', async () => {
    const keep = new Engine({
      isolated: true,
      planner: async () => ({ plan: { decision: 'keep', reason: 'Pequeno.' }, cost: null }),
    });
    const none = new Engine({ isolated: true });
    try {
      const request = {
        kind: 'request' as const,
        id: '1',
        command: 'split.planNow',
        payload: { text: 'faz', cwd: '.', checks },
      };
      expect(await keep.handle(request)).toMatchObject({
        ok: true,
        result: { review: { costMultiplier: 1, sequential: [] } },
      });
      expect(await none.handle(request)).toMatchObject({ ok: false });
    } finally {
      await keep.dispose();
      await none.dispose();
    }
  });
});
