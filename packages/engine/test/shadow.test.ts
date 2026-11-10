import { describe, expect, it } from 'vitest';
import { advise, packetFrom } from '../src/shadow/judge.ts';
import type { ShadowFinding } from '@solline/protocol';

const packet = packetFrom({
  request: 'O parser rejeita o caminho vazio.',
  diff: 'src/parser.ts + if (!path) return',
  checks: 'tipos passou',
  rules: 'Não enfraquecer testes.',
});

const bug: ShadowFinding = {
  path: 'src/parser.ts',
  line: 4,
  proof: 'if (!path) return deixa passar o vazio',
  title: 'O caminho vazio ainda segue.',
};

describe('juiz em sombra', () => {
  it('sem cliente fica por fazer e não autoriza', async () => {
    const advice = await advise(packet, null);
    expect(advice.verdict).toBe('unavailable');
    expect(advice.canAuthorize).toBe(false);
    expect(advice.findings).toEqual([]);
  });

  it('um bug conhecido aponta a prova', async () => {
    const advice = await advise(packet, async () => [bug]);
    expect(advice.verdict).toBe('recommend');
    expect(advice.findings).toEqual([bug]);
    expect(advice.reason).toContain('Não autoriza');
  });

  it('falhar ou discordar é inconclusivo, nunca aprovação', async () => {
    const failed = await advise(packet, async () => {
      throw new Error('caiu');
    });
    expect(failed.verdict).toBe('inconclusive');
    expect(failed.canAuthorize).toBe(false);

    let n = 0;
    const split = await advise(packet, async () => {
      n += 1;
      return n === 1 ? [bug] : [];
    });
    expect(split.verdict).toBe('inconclusive');
  });

  it('um achado sem prova não conta', async () => {
    const advice = await advise(packet, async () => [{ ...bug, proof: '   ' }]);
    expect(advice.verdict).toBe('inconclusive');
    expect(advice.findings).toEqual([]);
  });
});
