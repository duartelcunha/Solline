import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RulesState,
  type CommandPayload,
  type ProjectRule,
  type ProjectRulesView,
  type RulesExportResult,
  type RulesImportResult,
} from '@solline/protocol';
import {
  INDEX_TITLE,
  RulesManager,
  exportRules,
  globToRegExp,
  lengthWarning,
  matchesAny,
  matchesGlob,
  nativeCoverage,
  readNativeFiles,
  registryOf,
  renderAgentsMd,
  renderStart,
  renderTouched,
  splitSections,
  withMarker,
} from '../src/index.ts';
import { Engine } from '../src/engine.ts';

const roots: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'solline-rules-'));
  roots.push(root);
  return root;
}

function manager() {
  const saved: RulesState[] = [];
  const rules = new RulesManager({ save: (state) => saved.push(state) });
  return { rules, saved };
}

function input(over: Partial<CommandPayload<'rules.save'>> = {}): CommandPayload<'rules.save'> {
  return {
    projectId: 'p',
    title: 'Estilo',
    text: 'Usa dois espaços.',
    globs: [],
    enabled: true,
    ...over,
  };
}

function rule(over: Partial<ProjectRule> = {}): ProjectRule {
  return {
    id: 'abcd1234',
    projectId: 'p',
    title: 'Estilo',
    text: 'Usa dois espaços.',
    globs: [],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('padrões de ficheiro', () => {
  it('sem barra vale em qualquer pasta; com barra parte da raiz', () => {
    expect(matchesGlob('*.ts', 'a.ts')).toBe(true);
    expect(matchesGlob('*.ts', 'src/a/b.ts')).toBe(true);
    expect(matchesGlob('*.ts', 'src/a/b.tsx')).toBe(false);
    expect(matchesGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchesGlob('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(matchesGlob('src/*.ts', 'lib/src/a.ts')).toBe(false);
    expect(matchesGlob('package.json', 'apps/web/package.json')).toBe(true);
  });

  it('** atravessa pastas e src/db/** é tudo o que está dentro', () => {
    expect(matchesGlob('src/db/**', 'src/db/schema.sql')).toBe(true);
    expect(matchesGlob('src/db/**', 'src/db/migrations/001.sql')).toBe(true);
    expect(matchesGlob('src/db/**', 'src/dbx/a.sql')).toBe(false);
    expect(matchesGlob('src/db/**', 'other/src/db/a.sql')).toBe(false);
    expect(matchesGlob('**/*.test.ts', 'a.test.ts')).toBe(true);
    expect(matchesGlob('**/*.test.ts', 'packages/x/test/a.test.ts')).toBe(true);
    expect(matchesGlob('src/**/index.ts', 'src/index.ts')).toBe(true);
    expect(matchesGlob('src/**/index.ts', 'src/a/b/index.ts')).toBe(true);
  });

  it('?, {a,b} e [abc]; uma barra no fim é a pasta toda, em qualquer nível', () => {
    expect(matchesGlob('file?.ts', 'file1.ts')).toBe(true);
    expect(matchesGlob('file?.ts', 'file12.ts')).toBe(false);
    expect(matchesGlob('*.{ts,tsx}', 'src/a.tsx')).toBe(true);
    expect(matchesGlob('*.{ts,tsx}', 'src/a.js')).toBe(false);
    expect(matchesGlob('v[12].md', 'v2.md')).toBe(true);
    expect(matchesGlob('v[!12].md', 'v2.md')).toBe(false);
    expect(matchesGlob('build/', 'apps/web/build/x.js')).toBe(true);
    expect(matchesGlob('src/db/', 'src/db/x.sql')).toBe(true);
  });

  it('separadores do Windows, ./ e raiz absoluta no padrão não atrapalham', () => {
    expect(matchesGlob('src/db/**', 'src\\db\\x.sql')).toBe(true);
    expect(matchesGlob('./src/db/**', './src/db/x.sql')).toBe(true);
    expect(matchesGlob('/src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchesGlob('/src/*.ts', 'lib/src/a.ts')).toBe(false);
  });

  it('carateres especiais do regex são literais e chavetas por fechar também', () => {
    expect(matchesGlob('a+b(1).ts', 'a+b(1).ts')).toBe(true);
    expect(matchesGlob('a+b(1).ts', 'aab(1).ts')).toBe(false);
    expect(matchesGlob('x{y.ts', 'x{y.ts')).toBe(true);
  });

  it('matchesAny: a lista vazia não casa com nada', () => {
    expect(matchesAny([], 'a.ts')).toBe(false);
    expect(matchesAny(['*.md', '*.ts'], 'src/a.ts')).toBe(true);
    expect(globToRegExp('*.ts', false).flags).toBe('');
    expect(globToRegExp('*.TS', true).test('a.ts')).toBe(true);
  });
});

describe('importar por secções', () => {
  it('uma regra por ## de topo; o que vem antes é uma regra com o nome do #', () => {
    const sections = splitSections(
      '# Solline\n\nCliente de desktop.\n\n## Arquitetura\n\nTrês peças.\n\n### Detalhe\nmais\n\n## Testes\nCorre tudo.\n',
      'CLAUDE.md',
    );
    expect(sections).toEqual([
      { title: 'Solline', text: 'Cliente de desktop.' },
      { title: 'Arquitetura', text: 'Três peças.\n\n### Detalhe\nmais' },
      { title: 'Testes', text: 'Corre tudo.' },
    ]);
  });

  it('## dentro de blocos de código não parte, e sem preâmbulo não há regra extra', () => {
    const sections = splitSections(
      '## Exemplo\n\n```md\n## isto é código\n```\n\n~~~\n## e isto\n~~~\n\n## Outra\nx\n',
      'AGENTS.md',
    );
    expect(sections.map((s) => s.title)).toEqual(['Exemplo', 'Outra']);
    expect(sections[0]?.text).toContain('## isto é código');
    expect(splitSections('# Só título\n<!-- nota -->\n', 'CLAUDE.md')).toEqual([]);
  });

  it('um # dentro de código no preâmbulo não vira título', () => {
    const [first] = splitSections('Antes\n\n```sh\n# comentário\n```\n\n## A\nb', 'CLAUDE.md');
    expect(first).toEqual({ title: 'CLAUDE.md', text: 'Antes\n\n```sh\n# comentário\n```' });
  });

  it('CRLF e títulos compridos', () => {
    const [a, b] = splitSections(`## A\r\numa\r\n## ${'x'.repeat(300)}\r\ncorpo`, 'f');
    expect(a).toEqual({ title: 'A', text: 'uma' });
    expect(b?.title.length).toBe(120);
  });
});

describe('o texto de cada destino', () => {
  const always = rule({ id: 'a1', title: 'Estilo', text: 'Usa dois espaços.' });
  const sql = rule({
    id: 'b2',
    title: 'SQL',
    text: 'Sempre com transação.',
    globs: ['*.sql', 'db/**'],
  });
  const off = rule({ id: 'c3', title: 'Desligada', text: 'Nunca aparece.', enabled: false });

  it('instructions: regras sem padrões inteiras, as outras só no índice, com o id e a ferramenta', () => {
    const text = renderStart([always, sql, off], { target: 'instructions', readTool: true })!;
    expect(text).toContain('# Regras do projeto (Solline)');
    expect(text).toContain('## Estilo\n\nUsa dois espaços.');
    expect(text).not.toContain('Sempre com transação.');
    expect(text).not.toContain('Nunca aparece.');
    expect(text).toContain(`## ${INDEX_TITLE}`);
    expect(text).toContain(
      '- SQL (id b2): `*.sql`, `db/**`. Lê com a ferramenta read_rule quando editares estes ficheiros.',
    );
  });

  it('sem a ferramenta o índice só diz que a regra entra ao editar', () => {
    const text = renderStart([sql], { target: 'instructions', readTool: false })!;
    expect(text).not.toContain('read_rule');
    expect(text).toContain('Aplica-se quando editares estes ficheiros.');
  });

  it('context: a moldura diz que não é uma mensagem do utilizador', () => {
    const text = renderStart([always], { target: 'context', readTool: false })!;
    expect(text).toContain('não é uma mensagem do utilizador');
    expect(renderStart([always], { target: 'instructions', readTool: false })).not.toContain(
      'não é uma mensagem do utilizador',
    );
  });

  it('sem regras ativas não há bloco', () => {
    expect(renderStart([off], { target: 'instructions', readTool: true })).toBeUndefined();
    expect(renderTouched([])).toBeUndefined();
  });

  it('ao tocar: as regras inteiras, com a moldura de contexto', () => {
    const text = renderTouched([sql])!;
    expect(text).toContain('não é uma mensagem do utilizador');
    expect(text).toContain('## SQL\n\nSempre com transação.');
  });

  it('AGENTS.md: comentário, regras sem padrões e índice com a nota de ferramenta opcional', () => {
    const text = renderAgentsMd([always, sql, off]);
    expect(text.startsWith('<!-- Gerado pela Solline.')).toBe(true);
    expect(text).toContain('# Regras do projeto\n');
    expect(text).toContain('## Estilo\n\nUsa dois espaços.');
    expect(text).toContain('(se a tiveres)');
    expect(text).not.toContain('Nunca aparece.');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('aviso de tamanho', () => {
  const lines = (count: number) => Array.from({ length: count }, (_, i) => `linha ${i}`).join('\n');

  it('só conta as regras sem padrões e só acima de ~150 linhas ou ~8000 caracteres', () => {
    expect(lengthWarning([rule({ text: lines(100) })])).toBeUndefined();
    expect(lengthWarning([rule({ text: lines(160) })])?.kind).toBe('length');
    expect(lengthWarning([rule({ text: 'x'.repeat(8100) })])?.kind).toBe('length');
    // Com padrões, a regra não vai inteira no arranque: não pesa.
    expect(lengthWarning([rule({ text: lines(400), globs: ['*.ts'] })])).toBeUndefined();
    expect(lengthWarning([rule({ text: lines(400), enabled: false })])).toBeUndefined();
  });

  it('chega ao estado do projeto e nunca bloqueia guardar', () => {
    const { rules } = manager();
    const view = rules.save(input({ title: 'Longa', text: lines(200) }));
    expect(view.warnings.map((w) => w.kind)).toEqual(['length']);
    expect(view.rules).toHaveLength(1);
    const shorter = rules.save(input({ id: view.rules[0]?.id, title: 'Longa', text: 'curta' }));
    expect(shorter.warnings).toEqual([]);
  });
});

describe('guardar, alterar, apagar', () => {
  it('CRUD por projeto, com ids curtos e sem misturar projetos', () => {
    const { rules, saved } = manager();
    const created = rules.save(input({ globs: ['*.ts'] }));
    const id = created.rules[0]!.id;
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(created.rules[0]).toMatchObject({ projectId: 'p', title: 'Estilo', globs: ['*.ts'] });
    rules.save(input({ projectId: 'q', title: 'Outro projeto' }));
    expect(rules.view('p').rules).toHaveLength(1);
    expect(rules.view('q').rules).toHaveLength(1);

    const changed = rules.save(input({ id, title: 'Estilo 2', text: 'Novo', enabled: false }));
    expect(changed.rules[0]).toMatchObject({ id, title: 'Estilo 2', text: 'Novo', enabled: false });
    expect(changed.rules[0]!.updatedAt).toBeGreaterThanOrEqual(changed.rules[0]!.createdAt);
    expect(rules.enabled('p')).toEqual([]);
    expect(rules.get('p', id)?.title).toBe('Estilo 2');
    expect(rules.get('q', id)).toBeUndefined();

    expect(() => rules.save(input({ id: 'nao-existe' }))).toThrow('já não existe');
    expect(rules.delete('p', id).rules).toEqual([]);
    // Apagar o que já não existe não é um erro nem muda nada.
    const revision = saved.length;
    expect(rules.delete('p', id).rules).toEqual([]);
    expect(saved).toHaveLength(revision);
    expect(saved.at(-1)?.revision).toBe(saved.length);
  });

  it('se guardar falha o estado não muda', () => {
    const rules = new RulesManager({
      save: () => {
        throw new Error('disco cheio');
      },
    });
    expect(() => rules.save(input())).toThrow('disco cheio');
    expect(rules.view('p').rules).toEqual([]);
    expect(rules.snapshot().revision).toBe(0);
  });

  it('o protocolo recusa padrões absolutos ou com ..', async () => {
    const { RuleInput } = await import('@solline/protocol');
    for (const glob of ['/etc/*', 'C:\\x\\*', '../fora/**', 'a/../../b']) {
      expect(RuleInput.safeParse(input({ globs: [glob] })).success, glob).toBe(false);
    }
    expect(RuleInput.safeParse(input({ globs: ['src/**'] })).success).toBe(true);
  });
});

async function importOf(
  rules: RulesManager,
  cwd: string,
  only?: 'AGENTS.md' | 'CLAUDE.md',
): Promise<RulesImportResult> {
  return rules.importFiles('p', await readNativeFiles(cwd, only));
}

describe('importar CLAUDE.md e AGENTS.md', () => {
  it('parte por secções, sem padrões, e avisa que o agente pode ver duas vezes', async () => {
    const dir = temp();
    writeFileSync(
      path.join(dir, 'CLAUDE.md'),
      '# Proj\n\nIntro.\n\n## Arquitetura\nTrês peças.\n\n## Testes\nCorre tudo.\n',
    );
    const { rules } = manager();
    const result = await importOf(rules, dir);
    expect(result.imported.map((r) => r.title)).toEqual(['Proj', 'Arquitetura', 'Testes']);
    expect(result.imported.every((r) => r.globs.length === 0 && r.enabled)).toBe(true);
    expect(result.files).toEqual([
      { name: 'AGENTS.md', state: 'missing' },
      { name: 'CLAUDE.md', state: 'read' },
    ]);
    const view = rules.view('p');
    expect(view.importedFrom).toEqual(['CLAUDE.md']);
    expect(view.warnings.map((w) => w.kind)).toContain('native');
    expect(view.warnings.find((w) => w.kind === 'native')?.text).toContain('duas vezes');
  });

  it('volta a importar sem repetir (mesmo com outra caixa e espaços) e aceita só um ficheiro', async () => {
    const dir = temp();
    writeFileSync(path.join(dir, 'CLAUDE.md'), '## A\ntexto   um\n## B\ntexto dois\n');
    writeFileSync(path.join(dir, 'AGENTS.md'), '## a\nTEXTO UM\n## C\ntexto três\n');
    const { rules } = manager();
    const first = await importOf(rules, dir, 'CLAUDE.md');
    expect(first.imported.map((r) => r.title)).toEqual(['A', 'B']);
    const second = await importOf(rules, dir);
    expect(second.imported.map((r) => r.title)).toEqual(['C']);
    expect(second.skipped.filter((s) => s.reason === 'duplicate').map((s) => s.title)).toEqual([
      'a',
      'A',
      'B',
    ]);
    expect(rules.view('p').rules.map((r) => r.title)).toEqual(['A', 'B', 'C']);
    const third = await importOf(rules, dir);
    expect(third.imported).toEqual([]);
  });

  it('secções vazias, só com @imports ou demasiado compridas ficam de fora, com o motivo', async () => {
    const dir = temp();
    writeFileSync(
      path.join(dir, 'CLAUDE.md'),
      `## Vazia\n\n## Imports\n@AGENTS.md\n\n## Enorme\n${'x'.repeat(10_050)}\n\n## Boa\nok\n`,
    );
    const { rules } = manager();
    const result = await importOf(rules, dir);
    expect(result.imported.map((r) => r.title)).toEqual(['Boa']);
    expect(result.skipped).toEqual([
      { title: 'Vazia', reason: 'empty' },
      { title: 'Imports', reason: 'empty' },
      { title: 'Enorme', reason: 'too-long' },
    ]);
  });

  it('uma exportação da Solline por editar não se importa; editada, adota-se', async () => {
    const dir = temp();
    const { rules } = manager();
    rules.save(input({ title: 'Estilo', text: 'Dois espaços.' }));
    rules.save(input({ title: 'SQL', text: 'Transação.', globs: ['*.sql'] }));
    await exportRules(dir, rules.enabled('p'));
    const fresh = manager().rules;
    const untouched = await fresh.importFiles('p', await readNativeFiles(dir));
    expect(untouched.files.map((f) => f.state)).toEqual(['exported', 'exported']);
    expect(untouched.imported).toEqual([]);

    const file = path.join(dir, 'AGENTS.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n## Minha\nregra à mão\n`);
    const adopted = await fresh.importFiles('p', await readNativeFiles(dir, 'AGENTS.md'));
    // O índice e o cabeçalho gerados não viram regras; as secções que lá estavam sim.
    expect(adopted.imported.map((r) => r.title)).toEqual(['Estilo', 'Minha']);
    expect(adopted.files).toEqual([{ name: 'AGENTS.md', state: 'read' }]);
  });

  it('ligações simbólicas e pastas não se leem', async () => {
    const dir = temp();
    mkdirSync(path.join(dir, 'CLAUDE.md'));
    const files = await readNativeFiles(dir);
    expect(files.find((f) => f.name === 'CLAUDE.md')?.state).toBe('unsafe');
  });
});

describe('exportar para AGENTS.md e CLAUDE.md', () => {
  const ruleSet = [
    rule({ id: 'a1', title: 'Estilo', text: 'Dois espaços.' }),
    rule({ id: 'b2', title: 'SQL', text: 'Transação.', globs: ['*.sql'] }),
  ];

  it('escreve os dois com marcador e hash, e o CLAUDE.md só importa o AGENTS.md', async () => {
    const dir = temp();
    const result = await exportRules(dir, ruleSet);
    expect(result).toEqual({ written: ['AGENTS.md', 'CLAUDE.md'] });
    const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(agents).toMatch(/^<!-- solline:rules v1 sha256=[0-9a-f]{64} -->\n/);
    expect(agents).toContain('## Estilo');
    expect(claude).toMatch(/^<!-- solline:rules v1 sha256=[0-9a-f]{64} -->\n@AGENTS\.md\n$/);
    // Ficheiros normais, nunca ligações simbólicas, e sem restos temporários.
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      expect(lstatSync(path.join(dir, name)).isFile()).toBe(true);
      expect(lstatSync(path.join(dir, name)).isSymbolicLink()).toBe(false);
    }
    expect(await nativeCoverage(dir, ruleSet)).toEqual({
      'AGENTS.md': 'current',
      'CLAUDE.md': 'current',
    });
  });

  it('reescreve o que ela própria escreveu e ninguém editou, mesmo com regras novas', async () => {
    const dir = temp();
    await exportRules(dir, ruleSet);
    const more = [...ruleSet, rule({ id: 'c3', title: 'Nova', text: 'Mais uma.' })];
    expect(await nativeCoverage(dir, more)).toEqual({
      'AGENTS.md': 'stale',
      'CLAUDE.md': 'current',
    });
    expect(await exportRules(dir, more)).toEqual({ written: ['AGENTS.md', 'CLAUDE.md'] });
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('## Nova');
  });

  it('recusa um ficheiro sem marcador: conflito, e não escreve nenhum dos dois', async () => {
    const dir = temp();
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# O meu CLAUDE.md\n');
    const result = (await exportRules(dir, ruleSet)) as Extract<
      RulesExportResult,
      { conflict: unknown }
    >;
    expect(result.conflict).toMatchObject({ path: 'CLAUDE.md', reason: 'unmarked' });
    expect(result.conflict.message).toContain('adotá-lo');
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('# O meu CLAUDE.md\n');
    expect(() => readFileSync(path.join(dir, 'AGENTS.md'))).toThrow();
  });

  it('recusa um ficheiro exportado e depois editado à mão', async () => {
    const dir = temp();
    await exportRules(dir, ruleSet);
    const file = path.join(dir, 'AGENTS.md');
    const edited = `${readFileSync(file, 'utf8')}\numa linha minha\n`;
    writeFileSync(file, edited);
    const result = await exportRules(dir, ruleSet);
    expect(result).toMatchObject({ conflict: { path: 'AGENTS.md', reason: 'edited' } });
    expect(readFileSync(file, 'utf8')).toBe(edited);
    expect(await nativeCoverage(dir, ruleSet)).toMatchObject({ 'AGENTS.md': 'edited' });
  });

  it('um marcador com hash errado ou um hash copiado para outro texto conta como editado', async () => {
    const dir = temp();
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      `<!-- solline:rules v1 sha256=${'0'.repeat(64)} -->\nconteúdo\n`,
    );
    expect(await exportRules(dir, ruleSet)).toMatchObject({ conflict: { reason: 'edited' } });
  });

  it('o git no Windows pode trocar LF por CRLF sem que isso conte como edição', async () => {
    const dir = temp();
    await exportRules(dir, ruleSet);
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(dir, name);
      writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    }
    expect(await nativeCoverage(dir, ruleSet)).toEqual({
      'AGENTS.md': 'current',
      'CLAUDE.md': 'current',
    });
    expect(await exportRules(dir, ruleSet)).toEqual({ written: ['AGENTS.md', 'CLAUDE.md'] });
  });

  it('nunca escreve por cima de uma ligação simbólica nem a segue', async () => {
    const dir = temp();
    const outside = path.join(temp(), 'fora.md');
    writeFileSync(outside, 'não mexer\n');
    try {
      symlinkSync(outside, path.join(dir, 'AGENTS.md'));
    } catch {
      // Sem privilégio para criar ligações (Windows sem modo de programador): não há o que testar.
      return;
    }
    const result = await exportRules(dir, ruleSet);
    expect(result).toMatchObject({ conflict: { path: 'AGENTS.md', reason: 'unsafe' } });
    expect(readFileSync(outside, 'utf8')).toBe('não mexer\n');
    expect(lstatSync(path.join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(true);
  });

  it('o marcador cobre só o corpo: o mesmo corpo dá o mesmo hash', () => {
    expect(withMarker('x\n')).toBe(withMarker('x\n'));
    expect(withMarker('x\n')).not.toBe(withMarker('y\n'));
  });
});

describe('no motor: comandos, projeto resolvido pelo main e recuperação', () => {
  const key = Buffer.alloc(32, 7);

  function open(dataDir: string) {
    const events: { type: string }[] = [];
    const engine = new Engine({
      registry: registryOf([]),
      dataDir,
      recoveryKey: key,
      isolated: true,
      checkpoints: false,
      checks: false,
      reviewer: false,
      worktrees: false,
      emit: (event) => events.push(event),
    });
    engines.push(engine);
    return { engine, events };
  }

  let id = 0;
  async function request<T>(engine: Engine, command: string, payload: unknown): Promise<T> {
    const result = await engine.handle({ kind: 'request', id: `rules-${++id}`, command, payload });
    if (!result.ok) throw new Error(result.error.message);
    return result.result as T;
  }

  it('as regras sobrevivem a um reinício e o estado vai no snapshot', async () => {
    const dataDir = path.join(temp(), 'data');
    const first = open(dataDir);
    const saved = await request<ProjectRulesView>(first.engine, 'rules.save', {
      projectId: 'p',
      title: 'Estilo',
      text: 'Dois espaços.',
      globs: ['*.ts'],
    });
    await request(first.engine, 'rules.save', { projectId: 'p', title: 'Outra', text: 'Texto.' });
    expect(first.events.filter((e) => e.type === 'rules.changed')).toHaveLength(2);
    await first.engine.dispose();

    const second = open(dataDir);
    const listed = await request<ProjectRulesView>(second.engine, 'rules.list', { projectId: 'p' });
    expect(listed.rules.map((r) => [r.id, r.title, r.globs])).toEqual([
      [saved.rules[0]!.id, 'Estilo', ['*.ts']],
      [listed.rules[1]!.id, 'Outra', []],
    ]);
    const snapshot = await request<{ rules?: RulesState }>(second.engine, 'engine.snapshot', {});
    expect(RulesState.parse(snapshot.rules).revision).toBe(2);
    expect(second.engine.rules.enabled('p')).toHaveLength(2);

    const afterDelete = await request<ProjectRulesView>(second.engine, 'rules.delete', {
      projectId: 'p',
      id: saved.rules[0]!.id,
    });
    expect(afterDelete.rules).toHaveLength(1);
    await second.engine.dispose();
    const third = open(dataDir);
    expect(
      (await request<ProjectRulesView>(third.engine, 'rules.list', { projectId: 'p' })).rules,
    ).toHaveLength(1);
  });

  it('importa e exporta pela pasta que o main dá, e o conflito vem no resultado', async () => {
    const root = temp();
    const project = path.join(root, 'project');
    mkdirSync(project);
    writeFileSync(path.join(project, 'AGENTS.md'), '## Testes\nCorre `pnpm test`.\n');
    const { engine } = open(path.join(root, 'data'));

    const imported = await request<RulesImportResult>(engine, 'rules.importNow', {
      projectId: 'p',
      cwd: project,
    });
    expect(imported.imported.map((r) => r.title)).toEqual(['Testes']);

    const conflict = await request<RulesExportResult>(engine, 'rules.exportNow', {
      projectId: 'p',
      cwd: project,
    });
    expect(conflict).toMatchObject({ conflict: { path: 'AGENTS.md', reason: 'unmarked' } });
    // O aviso de duplicação mantém-se enquanto o ficheiro à mão continuar lá.
    expect(engine.rules.view('p').importedFrom).toEqual(['AGENTS.md']);

    rmSync(path.join(project, 'AGENTS.md'));
    const written = await request<RulesExportResult>(engine, 'rules.exportNow', {
      projectId: 'p',
      cwd: project,
    });
    expect(written).toEqual({ written: ['AGENTS.md', 'CLAUDE.md'] });
    expect(engine.rules.view('p').importedFrom).toEqual([]);
    expect(engine.rules.view('p').warnings).toEqual([]);

    await expect(
      request(engine, 'rules.exportNow', { projectId: 'vazio', cwd: project }),
    ).rejects.toThrow('Não há regras ativas');
    await expect(
      request(engine, 'rules.importNow', { projectId: 'p', cwd: path.join(root, 'nao-existe') }),
    ).rejects.toThrow('já não existe');
    await expect(
      request(engine, 'rules.importNow', { projectId: 'p', cwd: 'relativo' }),
    ).rejects.toThrow('já não existe');
  });

  it('os comandos de escrita passam pelo diário e a leitura não', async () => {
    const root = temp();
    const { engine } = open(path.join(root, 'data'));
    await request(engine, 'rules.save', { projectId: 'p', title: 'A', text: 'b' });
    const { operations } = await request<{ operations: { command: string }[] }>(
      engine,
      'engine.snapshot',
      {},
    );
    expect(operations.map((o) => o.command)).toEqual(['rules.save']);
    await request(engine, 'rules.list', { projectId: 'p' });
    const after = await request<{ operations: unknown[] }>(engine, 'engine.snapshot', {});
    expect(after.operations).toHaveLength(1);
  });
});
