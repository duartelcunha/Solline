import { describe, expect, it } from 'vitest';
import type { ProjectRule } from '@solline/protocol';
import {
  alwaysOnSize,
  conflictFile,
  firstLine,
  globsText,
  importSummary,
  parseGlobs,
} from './rules-model.ts';

const rule = (over: Partial<ProjectRule> = {}): ProjectRule => ({
  id: 'r',
  projectId: 'p',
  title: 'Título',
  text: 'Texto',
  globs: [],
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('padrões de ficheiro', () => {
  it('aceita vírgulas e linhas, sem repetir', () => {
    expect(parseGlobs('*.ts, src/db/**\n*.ts\n  docs/*.md ')).toEqual({
      globs: ['*.ts', 'src/db/**', 'docs/*.md'],
      error: null,
    });
    expect(parseGlobs('')).toEqual({ globs: [], error: null });
    expect(globsText(['*.ts', 'a/**'])).toBe('*.ts, a/**');
  });

  it('recusa caminhos absolutos, .. e mais de 20 padrões', () => {
    for (const bad of ['/etc/*', 'C:\\x', '../fora', 'a/../b'])
      expect(parseGlobs(bad).error).toContain('relativo');
    const many = Array.from({ length: 21 }, (_, i) => `f${i}.ts`).join(',');
    expect(parseGlobs(many).error).toContain('20');
  });
});

describe('tamanho das regras sempre ativas', () => {
  it('conta só as ligadas e sem padrões, como o motor', () => {
    const rules = [
      rule({ title: 'A', text: 'um\ndois' }),
      rule({ id: 's', title: 'B', text: 'x', globs: ['*.ts'] }),
      rule({ id: 'o', title: 'C', text: 'y', enabled: false }),
    ];
    const size = alwaysOnSize(rules);
    // «## A\n\num\ndois» tem 4 linhas.
    expect(size.lines).toBe(4);
    expect(size.chars).toBe('## A\n\num\ndois'.length);
    expect(alwaysOnSize([])).toEqual({ lines: 0, chars: 0 });
  });

  it('a primeira linha do texto', () => {
    expect(firstLine('\n  Primeira  \nSegunda')).toBe('Primeira');
  });
});

describe('importar e exportar', () => {
  it('resume o que se importou, o que já existia e o estado dos ficheiros', () => {
    const summary = importSummary({
      imported: [rule(), rule({ id: 'q' })],
      skipped: [{ title: 'Estilo', reason: 'duplicate' }],
      files: [
        { name: 'CLAUDE.md', state: 'read' },
        { name: 'AGENTS.md', state: 'exported' },
      ],
    });
    expect(summary.headline).toBe('Importei 2 regras.');
    expect(summary.details).toEqual([
      'CLAUDE.md: lido',
      'AGENTS.md: é uma exportação da Solline por editar, não há nada a importar',
      '«Estilo» já existia',
    ]);
    expect(importSummary({ imported: [], skipped: [], files: [] }).headline).toBe(
      'Não havia regras novas para importar.',
    );
    expect(importSummary({ imported: [rule()], skipped: [], files: [] }).headline).toBe(
      'Importei 1 regra.',
    );
  });

  it('o ficheiro de um conflito só se importa se for um dos dois conhecidos', () => {
    const conflict = (path: string) => ({ path, reason: 'edited' as const, message: '' });
    expect(conflictFile(conflict('C:\\x\\AGENTS.md'))).toBe('AGENTS.md');
    expect(conflictFile(conflict('/x/CLAUDE.md'))).toBe('CLAUDE.md');
    expect(conflictFile(conflict('/x/outro.md'))).toBeNull();
  });
});
