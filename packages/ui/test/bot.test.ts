import { describe, expect, it } from 'vitest';
import { HOODS, MOODS, botFrame, botSvg, palette, STATE_COLOURS } from '../src/bot/geometry.ts';

describe('bots da Solline', () => {
  it('cada humor tem capuz, cara, bainha e olhos', () => {
    for (const mood of MOODS) {
      const frame = botFrame(mood);
      expect(frame.hood).toMatch(/^M/);
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
    });
    expect(palette('claude', 'danger').hem).toBe(STATE_COLOURS.danger);
    expect(palette('claude').hem).toContain(HOODS.claude);
  });

  it('o SVG em texto traz o que o ícone e as pré-visualizações precisam', () => {
    const svg = botSvg('waiting', 'solline', 32);
    expect(svg).toContain('width="32"');
    expect(svg).toContain('#fffdf4');
  });

  it('as pupilas permanecem dentro da órbita em todas as direções do cursor', () => {
    const ellipse = (path: string) => {
      const values = /^M(-?[\d.]+) (-?[\d.]+)a([\d.]+) ([\d.]+)/.exec(path);
      if (!values) throw new Error('Expected an elliptical eye');
      const [, left, y, rx, ry] = values.map(Number);
      return { x: left! + rx!, y: y!, rx: rx!, ry: ry! };
    };
    for (const mood of MOODS) {
      const eyes = botFrame(mood).eyes;
      const whites = eyes
        .filter((e) => e.paint === 'fill' && e.layer !== 'pupil')
        .map((e) => ellipse(e.d));
      const pupils = eyes.filter((e) => e.layer === 'pupil').map((e) => ellipse(e.d));
      const radius =
        mood === 'reading' ? 3 : ['crashed', 'done', 'sleeping'].includes(mood) ? 0 : 6;
      for (const [i, pupil] of pupils.entries()) {
        const white = whites[i]!;
        for (let gaze = 0; gaze < 360; gaze += 10)
          for (let edge = 0; edge < 360; edge += 5) {
            const x =
              pupil.x +
              Math.cos((edge * Math.PI) / 180) * pupil.rx +
              Math.cos((gaze * Math.PI) / 180) * radius;
            const y =
              pupil.y +
              Math.sin((edge * Math.PI) / 180) * pupil.ry +
              Math.sin((gaze * Math.PI) / 180) * radius;
            expect(
              ((x - white.x) / white.rx) ** 2 + ((y - white.y) / white.ry) ** 2,
              mood,
            ).toBeLessThanOrEqual(1);
          }
      }
    }
  });
});
