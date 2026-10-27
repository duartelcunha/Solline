import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@solline/protocol';
import { laneKey, laneOptions } from './lane-options.ts';

const model = (id: string): ModelOption => ({
  id,
  resolved: null,
  label: id.toUpperCase(),
  description: '',
  efforts: [],
});
const models = [model('default'), model('haiku'), model('sonnet'), model('opus')];
const agents = [
  { id: 'claude', label: 'Claude', status: 'ready' as const },
  { id: 'codex', label: 'Codex', status: 'ready' as const },
  { id: 'gemini', label: 'Gemini', status: 'needs-login' as const },
];
const modelLabel = (m: ModelOption) => m.label;

describe('escolhas de agente e modelo', () => {
  it('para as pistas de uma corrida: os outros modelos e os outros agentes prontos', () => {
    const options = laneOptions({ agent: 'claude', model: 'sonnet', models, agents, modelLabel });
    expect(options.map((o) => o.key)).toEqual(['claude:haiku', 'claude:opus', 'codex:']);
    expect(options[0]?.lane).toEqual({ agent: 'claude', model: 'haiku' });
    expect(options[2]?.lane).toEqual({ agent: 'codex' });
  });

  it('para as partes: a sessão como está vem primeiro, com o nome do modelo', () => {
    const options = laneOptions({
      agent: 'claude',
      model: 'sonnet',
      models,
      agents,
      modelLabel,
      includeCurrent: true,
    });
    expect(options[0]).toEqual({
      key: 'claude:sonnet',
      lane: { agent: 'claude', model: 'sonnet' },
      label: 'SONNET',
    });
    expect(options).toHaveLength(4);
  });

  it('sem modelo escolhido, a sessão atual chama-se pelo agente', () => {
    const [first] = laneOptions({
      agent: 'claude',
      model: null,
      models,
      agents,
      modelLabel,
      includeCurrent: true,
    });
    expect(first).toEqual({ key: 'claude:', lane: { agent: 'claude' }, label: 'Claude' });
  });

  it('a chave junta agente e modelo', () => {
    expect(laneKey({ agent: 'codex' })).toBe('codex:');
    expect(laneKey({ agent: 'claude', model: 'opus' })).toBe('claude:opus');
  });
});
