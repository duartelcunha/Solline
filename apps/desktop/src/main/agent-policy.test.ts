import { describe, expect, it } from 'vitest';
import { addedKeys, allowedLoginUrl } from './agent-policy.ts';

const isAllowedLoginUrl = (agent: string, raw: string) => allowedLoginUrl(agent, raw) !== null;

describe('allowedLoginUrl', () => {
  it('devolve o URL interpretado, que é o que se abre', () => {
    expect(allowedLoginUrl('codex', ' https://AUTH.openai.com/x ')?.href).toBe(
      'https://auth.openai.com/x',
    );
  });

  it('abre o login da OpenAI para o Codex', () => {
    expect(
      isAllowedLoginUrl('codex', 'https://auth.openai.com/oauth/authorize?client_id=x&state=y'),
    ).toBe(true);
  });

  it('recusa outros hosts, http, portas, credenciais no URL e outros agentes', () => {
    for (const url of [
      'http://auth.openai.com/oauth',
      'https://auth.openai.com.evil.example/oauth',
      'https://evil.example/?https://auth.openai.com',
      'https://auth.openai.com:8443/oauth',
      'https://user:pass@auth.openai.com/oauth',
      'https://openai.com/oauth',
      'file:///C:/Windows/System32/calc.exe',
      'não é um url',
    ]) {
      expect(isAllowedLoginUrl('codex', url), url).toBe(false);
    }
    expect(isAllowedLoginUrl('opencode', 'https://auth.openai.com/oauth')).toBe(false);
  });
});

describe('addedKeys', () => {
  it('só conta as novas, sem olhar a maiúsculas', () => {
    expect(addedKeys(['A_KEY'], ['a_key', 'B_TOKEN'])).toEqual(['B_TOKEN']);
    expect(addedKeys(['A_KEY', 'B_TOKEN'], ['A_KEY'])).toEqual([]);
  });
});
