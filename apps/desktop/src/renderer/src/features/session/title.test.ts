import { describe, expect, it } from 'vitest';
import { titleFrom } from './title.ts';

describe('título da sessão', () => {
  it('guarda a frase inteira quando cabe em duas linhas', () => {
    const sentence = 'Melhora a navegação entre sessões e verifica os estados do teclado.';
    expect(sentence.length).toBeGreaterThan(60);
    expect(titleFrom(sentence)).toBe(sentence);
    expect(titleFrom('  uma   linha \n partida  ')).toBe('uma linha partida');
    expect(titleFrom('   ')).toBe('Nova sessão');
  });

  it('corta só o que não cabe, com reticências', () => {
    const long = 'a'.repeat(121);
    expect(titleFrom(long)).toHaveLength(120);
    expect(titleFrom(long).endsWith('…')).toBe(true);
  });
});
