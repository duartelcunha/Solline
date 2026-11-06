import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RulesState,
  type CommandPayload,
  type ProjectRule,
  type ProjectRulesView,
} from '@solline/protocol';
import {
  INDEX_TITLE,
  RulesManager,
  globToRegExp,
  lengthWarning,
  matchesAny,
  matchesGlob,
  registryOf,
  renderStart,
  renderTouched,
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

  it('desfazer repõe a regra e a pré-visualização é o texto do arranque', async () => {
    const { engine } = open(path.join(temp(), 'data'));
    await request(engine, 'rules.save', {
      projectId: null,
      title: 'Geral',
      text: 'Vale em todo o lado.',
    });
    const saved = await request<ProjectRulesView>(engine, 'rules.save', {
      projectId: 'p',
      title: 'Estilo',
      text: 'Dois espaços.',
    });
    expect(saved.canUndo).toBe(true);
    const preview = await request<{ claude: string; codex: string; acp: string }>(
      engine,
      'rules.preview',
      { projectId: 'p' },
    );
    expect(preview.claude).toContain('## Geral');
    expect(preview.claude).toContain('## Estilo');
    expect(preview.codex).toBe(preview.claude);
    expect(preview.acp).toContain('não é uma mensagem do utilizador');
    const undone = await request<ProjectRulesView>(engine, 'rules.undo', { projectId: 'p' });
    expect(undone.rules.map((r) => r.title)).toEqual([]);
    expect(engine.rules.view(null).rules.map((r) => r.title)).toEqual(['Geral']);
  });

  it('uma importação antiga fica desligada e o texto mantém-se', () => {
    const restored = RulesState.parse({
      version: 1,
      revision: 3,
      projects: {
        p: {
          rules: [
            {
              id: 'imp',
              projectId: 'p',
              title: 'Do ficheiro',
              text: 'Texto importado.',
              globs: [],
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          importedFrom: ['CLAUDE.md'],
          warnings: [],
        },
        q: {
          rules: [
            {
              id: 'own',
              projectId: 'q',
              title: 'Minha',
              text: 'Escrita na app.',
              globs: [],
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          importedFrom: [],
          warnings: [],
        },
      },
    });
    expect(restored.version).toBe(2);
    expect(restored.projects.p?.rules[0]).toMatchObject({
      title: 'Do ficheiro',
      text: 'Texto importado.',
      enabled: false,
    });
    expect(restored.projects.q?.rules[0]?.enabled).toBe(true);
    expect(restored.global.rules).toEqual([]);
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
