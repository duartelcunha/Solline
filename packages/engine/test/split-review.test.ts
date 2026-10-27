import { describe, expect, it } from 'vitest';
import { SplitPartSpec, SplitPlan, SplitReviewPayload, type SplitPart } from '@solline/protocol';
import { reviewPlan } from '../src/races/split-review.ts';
import { globToRegExp, outOfScope, zoneOf } from '../src/races/zones.ts';

const part = (title: string, allowed: string[], over: Partial<SplitPart> = {}): SplitPart => ({
  title,
  goal: `fazer ${title}`,
  allowed,
  forbidden: [],
  interfaces: '',
  expected: 'feito',
  check: 'test',
  zero: false,
  ...over,
});

const ids = ['test', 'lint'];

describe('reviewPlan: partes que se tocam', () => {
  it('zonas separadas ficam sozinhas, pela ordem original', () => {
    const review = reviewPlan([part('a', ['src/a/**']), part('b', ['src/b/**'])], ids);
    expect(review.sequential).toEqual([[0], [1]]);
    expect(review.costMultiplier).toBe(2);
    expect(review.warnings).toEqual([]);
  });

  it('pastas inteiras: src/a e src/ab não se tocam, src/a e src/a/b.ts sim', () => {
    expect(reviewPlan([part('a', ['src/a']), part('b', ['src/ab'])], ids).sequential).toEqual([
      [0],
      [1],
    ]);
    expect(reviewPlan([part('a', ['src/a']), part('b', ['src/a/b.ts'])], ids).sequential).toEqual([
      [0, 1],
    ]);
    expect(
      reviewPlan([part('a', ['src/a/**']), part('b', ['src/a/b/*.ts'])], ids).sequential,
    ).toEqual([[0, 1]]);
  });

  it('um glob que começa a meio de um nome só apanha esses nomes', () => {
    expect(reviewPlan([part('a', ['src/a*']), part('b', ['src/b.ts'])], ids).sequential).toEqual([
      [0],
      [1],
    ]);
    expect(reviewPlan([part('a', ['src/a*']), part('b', ['src/ab.ts'])], ids).sequential).toEqual([
      [0, 1],
    ]);
  });

  it('globs sem prefixo tocam em tudo (resposta segura)', () => {
    expect(reviewPlan([part('a', ['**/*.ts']), part('b', ['docs/x.md'])], ids).sequential).toEqual([
      [0, 1],
    ]);
  });

  it('as ligações são transitivas: a-b e b-c juntam as três', () => {
    const review = reviewPlan(
      [
        part('a', ['src/a/**', 'src/shared.ts']),
        part('b', ['src/b/**', 'src/shared.ts']),
        part('c', ['src/b/x.ts']),
        part('d', ['docs/**']),
      ],
      ids,
    );
    expect(review.sequential).toEqual([[0, 1, 2], [3]]);
  });

  it('ignora o prefixo ./, as barras invertidas e as maiúsculas', () => {
    expect(
      reviewPlan([part('a', ['./src\\a']), part('b', ['SRC/a/b.ts'])], ids).sequential,
    ).toEqual([[0, 1]]);
  });

  it('a parte zero é sempre o seu próprio primeiro grupo', () => {
    const review = reviewPlan(
      [
        part('contrato', ['src/types.ts'], { zero: true }),
        part('a', ['src/types.ts', 'src/a/**']),
        part('b', ['src/b/**']),
      ],
      ids,
    );
    expect(review.sequential).toEqual([[0], [1], [2]]);
  });

  it('avisa quando tudo corre em série e partir não ganha nada', () => {
    const review = reviewPlan([part('a', ['src/**']), part('b', ['src/x.ts'])], ids);
    expect(review.sequential).toEqual([[0, 1]]);
    expect(review.warnings.join(' ')).toContain('uma a seguir à outra');
  });
});

describe('reviewPlan: partes que ficam de fora', () => {
  it('sem verificação, ou com uma que não existe, a parte cai (a zero também)', () => {
    const review = reviewPlan(
      [
        part('contrato', ['src/t.ts'], { zero: true, check: null }),
        part('a', ['src/a/**'], { check: 'e2e' }),
        part('b', ['src/b/**']),
        part('c', ['src/c/**'], { check: 'lint' }),
      ],
      ids,
    );
    expect(review.dropped.map((d) => d.index)).toEqual([0, 1]);
    expect(review.dropped[1]?.reason).toContain('e2e');
    expect(review.sequential).toEqual([[2], [3]]);
    expect(review.costMultiplier).toBe(2);
  });

  it('menos de duas partes a correr: não compensa partir', () => {
    const review = reviewPlan([part('a', ['src/a']), part('b', ['src/b'], { check: null })], ids);
    expect(review.costMultiplier).toBe(1);
    expect(review.warnings.join(' ')).toContain('Menos de duas');
  });
});

describe('reviewPlan: ficheiros partilhados', () => {
  it('um ficheiro-ponto-de-encontro pedido por duas partes aparece uma vez', () => {
    const review = reviewPlan(
      [part('a', ['src/a/**', 'src/index.ts']), part('b', ['src/b/**', 'src/index.ts'])],
      ids,
    );
    expect(review.hubs).toEqual([{ path: 'src/index.ts', parts: [0, 1] }]);
    expect(review.warnings.join(' ')).toContain('src/index.ts');
  });

  it('um glob que pode cobrir o ficheiro conta', () => {
    const review = reviewPlan(
      [part('a', ['src/a/**', 'package.json']), part('b', ['package.json']), part('c', ['src/**'])],
      ids,
    );
    expect(review.hubs.find((h) => h.path === 'package.json')?.parts).toEqual([0, 1]);
    const other = reviewPlan([part('a', ['src/**']), part('b', ['src/db/schema.ts'])], ids);
    expect(other.hubs).toEqual([{ path: 'src/db/schema.ts', parts: [0, 1] }]);
  });

  it('globs de outras extensões ou pastas não apanham o ficheiro', () => {
    const review = reviewPlan(
      [part('a', ['**/*.ts']), part('b', ['package.json']), part('c', ['docs/**'])],
      ids,
    );
    expect(review.hubs).toEqual([]);
  });

  it('cobre os tipos fixos: SQL, i18n, gerados, locks, rotas', () => {
    const shared = [
      'db/001.sql',
      'src/i18n/pt.json',
      'src/api.gen.ts',
      'pnpm-lock.yaml',
      'src/routes.tsx',
      'src/generated/types.ts',
      'src/locales/en.json',
      'app/router.ts',
    ];
    const review = reviewPlan([part('a', [...shared, 'src/a/**']), part('b', shared)], ids);
    expect(review.hubs.map((h) => h.path)).toEqual(shared);
    expect(review.hubs.every((h) => h.parts.length === 2)).toBe(true);
  });

  it('uma pasta certa que contém o ficheiro também o apanha', () => {
    const review = reviewPlan([part('a', ['src/i18n']), part('b', ['src/i18n/pt.json'])], ids);
    expect(review.hubs).toEqual([{ path: 'src/i18n/pt.json', parts: [0, 1] }]);
  });
});

describe('reviewPlan: custo e avisos', () => {
  it('o custo é o número de partes que vão correr', () => {
    const parts = [part('a', ['a']), part('b', ['b']), part('c', ['c'])];
    expect(reviewPlan(parts, ids).costMultiplier).toBe(3);
  });

  it('mais de 3 partes dá aviso', () => {
    const parts = ['a', 'b', 'c', 'd'].map((n) => part(n, [n]));
    const review = reviewPlan(parts, ids);
    expect(review.costMultiplier).toBe(4);
    expect(review.warnings.join(' ')).toContain('Mais de 3');
  });
});

describe('o contrato do plano', () => {
  const ok = part('a', ['a']);

  it('aceita split com 2 a 4 partes e keep', () => {
    expect(
      SplitPlan.safeParse({ decision: 'split', parts: [ok, part('b', ['b'])], reason: 'r' })
        .success,
    ).toBe(true);
    expect(SplitPlan.safeParse({ decision: 'keep', reason: 'pequeno' }).success).toBe(true);
  });

  it('recusa menos de 2 ou mais de 4 partes', () => {
    expect(SplitPlan.safeParse({ decision: 'split', parts: [ok], reason: 'r' }).success).toBe(
      false,
    );
    const five = Array.from({ length: 5 }, (_, i) => part(`p${i}`, [`p${i}`]));
    expect(SplitPlan.safeParse({ decision: 'split', parts: five, reason: 'r' }).success).toBe(
      false,
    );
  });

  it('a parte zero é a primeira e só há uma', () => {
    const zero = part('z', ['t.ts'], { zero: true });
    expect(SplitPlan.safeParse({ decision: 'split', parts: [zero, ok], reason: 'r' }).success).toBe(
      true,
    );
    expect(SplitPlan.safeParse({ decision: 'split', parts: [ok, zero], reason: 'r' }).success).toBe(
      false,
    );
    expect(
      SplitPlan.safeParse({
        decision: 'split',
        parts: [zero, { ...zero, title: 'z2' }],
        reason: 'r',
      }).success,
    ).toBe(false);
    expect(SplitReviewPayload.safeParse({ parts: [ok, zero], checkIds: [] }).success).toBe(false);
  });
});

describe('zonas: globs malformados e a árvore toda', () => {
  it('um glob nunca faz falhar: chavetas sem par são texto e o resto segue', () => {
    for (const glob of ['src/{a', 'src/a}', '{{a,b}', '}{', 'a{,b', '**/{', 'x[', '[', '{a,b}}']) {
      expect(() => globToRegExp(glob)).not.toThrow();
      expect(() => reviewPlan([part('a', [glob]), part('b', ['b'])], ids)).not.toThrow();
      expect(() => outOfScope({ allowed: [glob], forbidden: [glob] }, ['src/a'])).not.toThrow();
    }
    // A chaveta solta conta como texto; as que têm par continuam a ser alternativas.
    expect(globToRegExp('src/{a').test('src/{a')).toBe(true);
    expect(globToRegExp('src/{a').test('src/a')).toBe(false);
    expect(globToRegExp('src/{a,b}.ts').test('src/b.ts')).toBe(true);
    expect(globToRegExp('{{a,b}').test('{a')).toBe(true);
    expect(globToRegExp('{{a,b}').test('{b')).toBe(true);
    expect(globToRegExp('a,b').test('a,b')).toBe(true);
  });

  it('"[" é só um carácter, no glob e na zona (rotas como app/[id].tsx)', () => {
    expect(globToRegExp('app/[id].tsx').test('app/[id].tsx')).toBe(true);
    expect(globToRegExp('app/[id].tsx').test('app/i.tsx')).toBe(false);
    expect(zoneOf('app/[id].tsx')).toEqual({
      segments: ['app', '[id].tsx'],
      partial: null,
      glob: false,
    });
    expect(
      reviewPlan([part('a', ['app/[id].tsx']), part('b', ['app/[slug].tsx'])], ids).sequential,
    ).toEqual([[0], [1]]);
  });

  it('".", "./", "*" e "**" querem dizer a árvore toda, para tocar e para o âmbito', () => {
    for (const whole of ['.', './', '*', '**', '/', ' ']) {
      expect(reviewPlan([part('a', [whole]), part('b', ['src/b.ts'])], ids).sequential).toEqual([
        [0, 1],
      ]);
      expect(
        outOfScope({ allowed: [whole], forbidden: [] }, ['qualquer/coisa.ts', 'a.txt']),
      ).toEqual([]);
      // Continua a valer o proibido.
      expect(
        outOfScope({ allowed: [whole], forbidden: ['src/x'] }, ['src/x/a.ts', 'b.ts']),
      ).toEqual(['src/x/a.ts']);
    }
  });

  it('uma parte sem zonas pode tocar em tudo: corre em fila com as outras (na dúvida, toca)', () => {
    const review = reviewPlan([part('a', []), part('b', ['src/b/**']), part('c', ['docs'])], ids);
    expect(review.sequential).toEqual([[0, 1, 2]]);
    expect(review.warnings.join(' ')).toContain('«a» não diz que ficheiros pode tocar');
    // No âmbito, sem zonas só conta o proibido.
    expect(outOfScope({ allowed: [], forbidden: ['x'] }, ['x/a.ts', 'y.ts'])).toEqual(['x/a.ts']);
  });

  it('os pontos de encontro partilhados escrevem-se "A, B e C"', () => {
    const review = reviewPlan(
      [part('a', ['package.json']), part('b', ['package.json']), part('c', ['package.json'])],
      ids,
    );
    expect(review.warnings.join(' ')).toContain('«a», «b» e «c» podem mexer em package.json');
  });

  it('globs com chavetas por fechar são recusados à entrada (rever ou lançar)', () => {
    const bad = part('a', ['src/{a,b']);
    const good = part('b', ['src/{a,b}']);
    expect(SplitReviewPayload.safeParse({ parts: [bad], checkIds: [] }).success).toBe(false);
    expect(SplitReviewPayload.safeParse({ parts: [good], checkIds: [] }).success).toBe(true);
    const spec = SplitPartSpec.safeParse({ part: { ...good, forbidden: ['x}'] }, agent: 'claude' });
    expect(spec.success).toBe(false);
    if (!spec.success) expect(spec.error.issues[0]?.message).toMatch(/chavetas/);
    expect(SplitPartSpec.safeParse({ part: good, agent: 'claude' }).success).toBe(true);
  });
});
