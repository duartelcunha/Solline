import { describe, expect, it } from 'vitest';
import { HOODS, MOODS, botFrame, botSvg, palette, STATE_COLOURS } from '../src/bot/geometry.ts';

describe('bots da Solline', () => {
  it('cada humor tem capuz, cara, bainha e olhos', () => {
    for (const mood of MOODS) {
      const frame = botFrame(mood);
      expect(frame.hood).toMatch(/^M/);
      expect(frame.face).toMatch(/^M/);
      expect(frame.eyes.length).toBeGreaterThan(0);
    }
  });

  it('a cor do estado vive na bainha: âmbar quando precisa de ti, vermelho quando cai', () => {
    expect(botFrame('needs-you').tone).toBe('attention');
    expect(botFrame('crashed').tone).toBe('danger');
    for (const mood of ['waiting', 'working', 'done', 'sleeping', 'reading'] as const) {
      expect(botFrame(mood).tone).toBe('calm');
    }
    expect(palette('claude', 'attention')).toMatchObject({
      hem: STATE_COLOURS.attention,
      eyes: STATE_COLOURS.attention,
    });
    expect(palette('claude', 'danger').hem).toBe(STATE_COLOURS.danger);
    expect(palette('claude').hem).toContain(HOODS.claude);
  });

  it('o capuz do "caiu" descai sem rodar (rodar deixava um buraco na bainha)', () => {
    expect(botFrame('crashed').hoodTransform).not.toContain('rotate');
  });

  it('o SVG em texto traz o que o ícone e as pré-visualizações precisam', () => {
    const svg = botSvg('waiting', 'solline', 32);
    expect(svg).toContain('width="32"');
    expect(svg).toContain('#ffd071');
  });
});
