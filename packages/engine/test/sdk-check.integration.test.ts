import { describe, expect, it } from 'vitest';
import { runSdkCheck } from '../src/index.ts';

/**
 * Chama o SDK a sério: uma mensagem a Haiku com o login do Claude Code desta máquina.
 * Saltar com SOLLINE_SKIP_SDK=1 (por exemplo sem rede ou sem login).
 */
const skip = process.env.SOLLINE_SKIP_SDK === '1';

describe.skipIf(skip)('runSdkCheck (SDK real)', () => {
  it('responde ok com Haiku', { timeout: 180_000 }, async () => {
    const result = await runSdkCheck();
    console.info('[sdkCheck]', JSON.stringify(result));
    // O system/init chega antes da autenticação: prova que o claude.exe arrancou.
    expect(result.model).toMatch(/haiku/i);
    expect(typeof result.apiKeySource).toBe('string');
    expect(result.isError, `o SDK respondeu com erro: ${result.result}`).toBe(false);
    expect(result.result.trim().toLowerCase()).toMatch(/^ok\.?$/);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });
});
