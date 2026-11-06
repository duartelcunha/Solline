import { describe, expect, it } from 'vitest';
import type { ProjectRule } from '@solline/protocol';
import { alwaysOnSize, firstLine, globsText, parseGlobs } from './rules-model.ts';

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
