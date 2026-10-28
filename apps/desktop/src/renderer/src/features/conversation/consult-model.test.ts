import { describe, expect, it } from 'vitest';
import type { ConsultRequest } from '@solline/protocol';
import { consultCopy, deskCanAllowDirectly, firstConsult } from './consult-model.ts';

const name = (id: string) => ({ claude: 'Claude', codex: 'Codex' })[id] ?? id;
const base = {
  id: 'c',
  sessionId: 's',
  from: 'claude',
  to: 'codex',
  text: 'Onde está o parser?',
  createdAt: 1,
};
const ask = (over: Partial<ConsultRequest> = {}): ConsultRequest => ({
  ...base,
  kind: 'ask',
  summary: 'O Claude quer perguntar ao Codex',
  ...over,
});
const delegate = (over: Partial<ConsultRequest> = {}): ConsultRequest => ({
  ...base,
  kind: 'delegate',
  summary: 'O Claude quer delegar uma tarefa no Codex',
  ...over,
});

describe('texto do cartão de consulta', () => {
  it('perguntar: só leitura, sem avisos se for de outro fabricante', () => {
    const copy = consultCopy(ask(), name);
    expect(copy.title).toBe('O Claude quer perguntar ao Codex');
    expect(copy.textLabel).toBe('Pergunta do Claude');
    expect(copy.effect).toContain('só de leitura');
    expect(copy.notes).toEqual([]);
    expect(copy.facts).toEqual([]);
  });

  it('perguntar ao mesmo fabricante avisa que não é uma segunda opinião independente', () => {
    const copy = consultCopy(ask({ to: 'claude', sameVendor: true }), name);
    expect(copy.notes).toHaveLength(1);
    expect(copy.notes[0]).toContain('mesmo fabricante');
  });

  it('delegar mostra o agente, o modo e o título; o modo em falta diz-se', () => {
    const copy = consultCopy(
      delegate({ mode: { id: 'workspace-write', label: 'Editar ficheiros' }, title: 'Testes' }),
      name,
    );
    expect(copy.facts).toEqual([
      { label: 'Agente', value: 'Codex' },
      { label: 'Modo', value: 'Editar ficheiros' },
      { label: 'Título', value: 'Testes' },
    ]);
    expect(copy.effect).toContain('branch');
    expect(consultCopy(delegate(), name).facts[1]?.value).toBe('o modo por omissão do agente');
  });

  it('na mesa só se permite perguntar; o mais antigo responde-se primeiro', () => {
    expect(deskCanAllowDirectly('ask')).toBe(true);
    expect(deskCanAllowDirectly('delegate')).toBe(false);
    expect(firstConsult([ask({ id: '1' }), ask({ id: '2' })])?.id).toBe('1');
    expect(firstConsult([])).toBeNull();
  });
});
