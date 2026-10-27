import { describe, expect, it } from 'vitest';
import { SplitReviewPayload, SplitStartPayload, type SplitPart } from '@solline/protocol';
import {
  addDraft,
  chainSentence,
  chains,
  draftsFromPlan,
  launchCount,
  letter,
  newDraft,
  patchDraft,
  removeDraft,
  templateDrafts,
  toPart,
  toReviewPayload,
  toStartParts,
  visibleWarnings,
} from './plan-model.ts';

const base = { agent: 'claude', model: 'sonnet' };
const plan: SplitPart[] = [
  {
    title: 'Base',
    goal: 'Fixar os tipos',
    allowed: ['src/types.ts'],
    forbidden: ['src/ui/**'],
    interfaces: 'Tipo X',
    expected: 'compila',
    check: 'typecheck',
    zero: true,
  },
  {
    title: 'Ecrã',
    goal: 'Desenhar',
    allowed: ['src/ui/**'],
    forbidden: [],
    interfaces: '',
    expected: '',
    check: 'typecheck',
    zero: false,
  },
];

describe('rascunhos das partes', () => {
  it('o molde de partir à mão tem duas partes vazias, no agente da sessão e na primeira verificação', () => {
    const drafts = templateDrafts(base, 'typecheck');
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.check)).toEqual(['typecheck', 'typecheck']);
    expect(drafts.every((d) => d.agent === 'claude' && d.model === 'sonnet' && !d.zero)).toBe(true);
    expect(new Set(drafts.map((d) => d.id)).size).toBe(2);
  });

  it('o plano do planeador vira texto editável, uma linha por caminho', () => {
    const [first, second] = draftsFromPlan(plan, base);
    expect(first).toMatchObject({ title: 'Base', zero: true, allowed: 'src/types.ts' });
    expect(first?.forbidden).toBe('src/ui/**');
    expect(second).toMatchObject({ title: 'Ecrã', zero: false, check: 'typecheck' });
  });

  it('só a primeira parte pode ser a zero', () => {
    let drafts = templateDrafts(base, null);
    drafts = patchDraft(drafts, 1, { zero: true });
    expect(drafts.map((d) => d.zero)).toEqual([false, false]);
    drafts = patchDraft(drafts, 0, { zero: true });
    expect(drafts.map((d) => d.zero)).toEqual([true, false]);
  });

  it('acrescenta até quatro e tira até duas; tirar a primeira leva a parte zero consigo', () => {
    let drafts = patchDraft(templateDrafts(base, 'typecheck'), 0, { zero: true });
    drafts = addDraft(drafts, base, 'typecheck');
    drafts = addDraft(drafts, base, 'typecheck');
    drafts = addDraft(drafts, base, 'typecheck');
    expect(drafts).toHaveLength(4);
    expect(removeDraft(drafts, 2).map((d) => d.zero)).toEqual([true, false, false]);
    expect(removeDraft(drafts, 0).some((d) => d.zero)).toBe(false);
    expect(removeDraft(drafts.slice(0, 2), 0)).toHaveLength(2);
  });

  it('as letras das partes', () => {
    expect([0, 1, 3].map(letter)).toEqual(['A', 'B', 'D']);
  });
});

describe('do cartão para o contrato', () => {
  it('limpa as linhas, tira repetidas e vazias, e guarda a verificação e a parte zero', () => {
    const draft = {
      ...newDraft(base, 'lint', 'x'),
      title: '  Ecrã ',
      goal: ' Desenhar ',
      allowed: ' src/ui/** \n\n src/ui/** \r\n docs/a.md ',
      zero: true,
    };
    expect(toPart(draft, 0)).toEqual({
      title: 'Ecrã',
      goal: 'Desenhar',
      allowed: ['src/ui/**', 'docs/a.md'],
      forbidden: [],
      interfaces: '',
      expected: '',
      check: 'lint',
      zero: true,
    });
    // Fora do lugar zero, a marca cai.
    expect(toPart(draft, 1).zero).toBe(false);
  });

  it('um título ou objetivo vazio não impede a revisão: usa a letra e o título', () => {
    const part = toPart(newDraft(base, null, 'x'), 1);
    expect(part.title).toBe('Parte B');
    expect(part.goal).toBe('Parte B');
  });

  it('o payload da revisão e o do arranque passam o esquema do protocolo', () => {
    const drafts = patchDraft(draftsFromPlan(plan, base), 1, {
      agent: 'codex',
      model: null,
      check: null,
    });
    const review = toReviewPayload(drafts, ['typecheck']);
    expect(SplitReviewPayload.parse(review).checkIds).toEqual(['typecheck']);
    const start = toStartParts(drafts);
    expect(start[0]).toMatchObject({ agent: 'claude', model: 'sonnet' });
    expect(start[1]).toEqual({ part: expect.objectContaining({ check: null }), agent: 'codex' });
    expect(SplitStartPayload.parse({ projectId: 'p', text: 'x', parts: start }).parts).toHaveLength(
      2,
    );
  });

  it('o molde vazio também passa o esquema (a revisão corre logo ao abrir)', () => {
    expect(() =>
      SplitReviewPayload.parse(toReviewPayload(templateDrafts(base, null), [])),
    ).not.toThrow();
  });
});

describe('o que a revisão mostra', () => {
  const review = {
    sequential: [[0], [1, 2], [3]],
    dropped: [],
    hubs: [{ path: 'package.json', parts: [1, 2] }],
    costMultiplier: 4,
    warnings: [
      'Mais de 3 partes: cada uma gasta tokens e a integração fica mais difícil.',
      '«B» e «C» podem mexer em package.json, um ficheiro partilhado: espera conflitos.',
    ],
  };

  it('só as cadeias de verdade, em palavras', () => {
    expect(chains(review)).toEqual([[1, 2]]);
    expect(chainSentence([1, 2])).toBe('C só começa quando B acaba');
    expect(chainSentence([0, 1, 2])).toBe('B só começa quando A acaba; C só começa quando B acaba');
  });

  it('os avisos não repetem os ficheiros partilhados que já se mostram à parte', () => {
    expect(visibleWarnings(review)).toEqual([review.warnings[0]]);
  });

  it('lançar custa tantas partes como as que correm; sem revisão ou sem nada a correr, desliga', () => {
    expect(launchCount(review)).toBe(4);
    expect(launchCount({ ...review, costMultiplier: 0 })).toBe(0);
    expect(launchCount(null)).toBe(0);
  });
});
