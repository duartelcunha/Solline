import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemorySecretStore, mcpSecretTarget } from '@solline/protocol';
import { UnavailableSecretStore, WindowsCredentialStore } from './credential-store.ts';

describe('cofre de segredos (testes sem o Windows)', () => {
  it('o cofre em memória guarda, lê vários de uma vez e apaga (o que não existe é ignorado)', async () => {
    const store = new MemorySecretStore();
    const a = mcpSecretTarget('abc', 'API_KEY');
    const b = mcpSecretTarget('abc', 'OTHER');
    await store.set(a, 'um');
    expect(await store.getMany([a, b])).toEqual(['um', null]);
    await store.remove([a, b]);
    expect(await store.get(a)).toBeNull();
  });

  it('recusa nomes que não são segredos da Solline', async () => {
    const store = new MemorySecretStore();
    await expect(store.get('Microsoft/Outlook')).rejects.toThrow('inválido');
    await expect(store.remove(['Solline/mcp/../x'])).rejects.toThrow('inválido');
    expect(() => mcpSecretTarget('Servidor', 'X')).toThrow('inválido');
    expect(() => mcpSecretTarget('abc', '1X')).toThrow('inválido');
  });

  it('sem cofre, tudo falha com a razão', async () => {
    const store = new UnavailableSecretStore('Sem cofre');
    await expect(store.get()).rejects.toThrow('Sem cofre');
  });
});

// Toca no Gestor de Credenciais de verdade (escreve e apaga um segredo de teste com um alvo
// aleatório): só corre com SOLLINE_TEST_CREDMAN=1, no Windows.
const real = process.env.SOLLINE_TEST_CREDMAN === '1' && process.platform === 'win32';
describe.skipIf(!real)('Gestor de Credenciais do Windows (real)', () => {
  it('escreve, lê, troca e apaga, com acentos e caracteres que a shell comeria', async () => {
    const store = new WindowsCredentialStore();
    const id = `teste-${randomBytes(4).toString('hex')}`;
    const target = mcpSecretTarget(id, 'TOKEN_DE_TESTE');
    const other = mcpSecretTarget(id, 'OUTRO');
    const value = `ação "x" 'y' $env:PATH %PATH% | & ; \`n é ñ 日本語-${randomBytes(6).toString('hex')}`;
    try {
      expect(await store.get(target)).toBeNull();
      await store.set(target, value);
      await store.set(other, 'segundo');
      expect(await store.getMany([target, other, mcpSecretTarget(id, 'NAO_EXISTE')])).toEqual([
        value,
        'segundo',
        null,
      ]);
      await store.set(target, 'novo');
      expect(await store.get(target)).toBe('novo');
    } finally {
      await store.remove([target, other]);
    }
    expect(await store.getMany([target, other])).toEqual([null, null]);
    // Apagar o que já não existe não falha.
    await store.remove([target]);
  }, 120_000);

  it('recusa um valor maior do que o cofre aceita', async () => {
    const store = new WindowsCredentialStore();
    const target = mcpSecretTarget(`teste-${randomBytes(4).toString('hex')}`, 'GRANDE');
    await expect(store.set(target, 'x'.repeat(1001))).rejects.toThrow('entre 1 e 1000');
  });
});
