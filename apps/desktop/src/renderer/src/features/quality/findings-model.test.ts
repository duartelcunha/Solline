import { describe, expect, it } from 'vitest';
import type { Finding, Quality } from '@solline/protocol';
import {
  confidenceLabel,
  foldLabel,
  groupFindings,
  openFindings,
  priorityLabel,
  reviewByline,
  reviewHeadline,
  reviewPhase,
  secondOpinionGate,
  statsLabel,
  vendorName,
} from './findings-model.ts';

const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
  id,
  path: 'a.ts',
  line: 1,
  severity: 'bug',
  priority: 2,
  confidence: 0.9,
  status: 'open',
  title: id,
  detail: '',
  ...over,
});

const quality = (over: Partial<Quality['review']> = {}, enabled = true): Quality => ({
  available: true,
  enabled,
  review: { state: 'done', turnId: 't', findings: [], error: null, ...over },
  stats: { fixed: 0, dismissed: 0, total: 0 },
});

describe('achados: à vista e dobrados', () => {
  it('mostra no máximo 5, os mais graves primeiro, e dobra o resto', () => {
    const findings = [
      ...Array.from({ length: 6 }, (_, i) => finding(`f${i}`, { priority: i === 5 ? 0 : 1 })),
      finding('slop', { severity: 'slop' }),
      finding('doubt', { confidence: 0.4 }),
    ];
    const { shown, folded } = groupFindings(findings);
    expect(shown).toHaveLength(5);
    expect(shown[0]?.id).toBe('f5');
    expect(folded.map((f) => f.id).sort()).toEqual(['doubt', 'f4', 'slop'].sort());
  });

  it('descartados não aparecem em lado nenhum', () => {
    const findings = [finding('a'), finding('b', { status: 'dismissed' })];
    expect(openFindings(findings).map((f) => f.id)).toEqual(['a']);
    const { shown, folded } = groupFindings(findings);
    expect(shown.map((f) => f.id)).toEqual(['a']);
    expect(folded).toEqual([]);
  });

  it('o texto do dobrado concorda em número', () => {
    expect(foldLabel(1)).toBe('1 achado menos certo');
    expect(foldLabel(3)).toBe('3 achados menos certos');
  });
});

describe('contadores e rótulos', () => {
  it('"3 corrigidos · 1 dispensado", e nada quando ainda não houve nenhum', () => {
    expect(statsLabel({ fixed: 3, dismissed: 1 })).toBe('3 corrigidos · 1 dispensado');
    expect(statsLabel({ fixed: 1, dismissed: 2 })).toBe('1 corrigido · 2 dispensados');
    expect(statsLabel({ fixed: 0, dismissed: 2 })).toBe('2 dispensados');
    expect(statsLabel({ fixed: 0, dismissed: 0 })).toBeNull();
  });

  it('prioridade P0 a P3 e confiança em percentagem inteira', () => {
    expect(priorityLabel(0)).toBe('P0');
    expect(priorityLabel(3)).toBe('P3');
    expect(confidenceLabel(0.9)).toBe('90 %');
    expect(confidenceLabel(0.456)).toBe('46 %');
    expect(confidenceLabel(7)).toBe('100 %');
  });

  it('nome do fornecedor: o do agente, ou o texto com maiúscula', () => {
    expect(vendorName('codex', [{ id: 'codex', label: 'Codex' }])).toBe('Codex');
    expect(vendorName('claude')).toBe('Claude');
  });
});

describe('quem reviu', () => {
  it('"Revisto por Codex · gpt-5.5", quando foi pedida e se é o mesmo fabricante', () => {
    expect(
      reviewByline({
        reviewer: { vendor: 'codex', model: 'gpt-5.5', sameVendor: false },
        trigger: 'bring',
      }),
    ).toEqual({ by: 'Revisto por Codex · gpt-5.5', when: 'antes de trazer', sameVendor: false });
    expect(
      reviewByline({ reviewer: { vendor: 'claude', sameVendor: true }, trigger: 'manual' }),
    ).toEqual({ by: 'Revisto por Claude', when: 'a pedido', sameVendor: true });
    expect(
      reviewByline({ reviewer: { vendor: 'codex', sameVendor: false }, trigger: 'turn' })?.when,
    ).toBe('depois do turno');
  });

  it('sem revisor conhecido não há linha', () => {
    expect(reviewByline({})).toBeNull();
  });
});

describe('estado da revisão', () => {
  it('sem achados é um resultado calmo; o erro nunca parece limpo', () => {
    expect(reviewPhase(quality())).toBe('clean');
    expect(reviewHeadline(quality())).toEqual({ tone: 'calm', text: 'Sem achados' });
    const failed = quality({ state: 'error', error: 'sem rede' });
    expect(reviewPhase(failed)).toBe('error');
    expect(reviewHeadline(failed)).toEqual({
      tone: 'error',
      text: 'A revisão falhou: sem rede',
    });
  });

  it('só achados dobrados lê-se como "Sem achados certos"', () => {
    const q = quality({ findings: [finding('a', { confidence: 0.3 })] });
    expect(reviewPhase(q)).toBe('clean');
    expect(reviewHeadline(q).text).toBe('Sem achados certos');
  });

  it('com achados à vista conta só esses', () => {
    const q = quality({
      findings: [finding('a'), finding('b'), finding('c', { confidence: 0.2 })],
    });
    expect(reviewPhase(q)).toBe('found');
    expect(reviewHeadline(q)).toEqual({ tone: 'found', text: '2 achados' });
  });

  it('desligado e sem nada à vista lê-se como desligado, não como limpo', () => {
    expect(reviewPhase(quality({}, false))).toBe('off');
    expect(reviewPhase(quality({ state: 'idle' }, true))).toBe('idle');
    expect(reviewPhase({ ...quality(), available: false })).toBe('unavailable');
    expect(reviewPhase(null)).toBe('unavailable');
  });

  it('a revisar mostra progresso', () => {
    const q = quality({ state: 'running' });
    expect(reviewPhase(q)).toBe('running');
    expect(reviewHeadline(q).tone).toBe('progress');
  });
});

describe('segunda opinião: quando se pode pedir', () => {
  const ok = { busy: false, hasFinishedTurn: true };
  it('pode, parado e com um turno acabado', () => {
    expect(secondOpinionGate(quality(), ok)).toEqual({ enabled: true, reason: null });
  });
  it('desligada com motivo: a rever, agente ocupado, sem turno, sem revisor', () => {
    expect(secondOpinionGate(quality({ state: 'running' }), ok).reason).toBe(
      'Já há uma revisão a decorrer',
    );
    expect(secondOpinionGate(quality(), { ...ok, busy: true }).reason).toBe(
      'O agente ainda está a trabalhar',
    );
    expect(secondOpinionGate(quality(), { ...ok, hasFinishedTurn: false }).reason).toBe(
      'Ainda não há nenhum turno acabado',
    );
    expect(secondOpinionGate(null, ok)).toEqual({
      enabled: false,
      reason: 'O revisor não está disponível',
    });
  });
});
