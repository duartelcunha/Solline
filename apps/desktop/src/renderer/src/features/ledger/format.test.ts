import { describe, expect, it } from 'vitest';
import { shownAmount } from './format.ts';

describe('consumo visível', () => {
  it('zero reportado fica zero e o em falta fica desconhecido', () => {
    const format = (value: number) => String(value);
    expect(shownAmount(0, format)).toBe('0');
    expect(shownAmount(null, format)).toBe('desconhecido');
  });
});
