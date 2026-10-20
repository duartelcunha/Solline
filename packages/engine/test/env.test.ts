import { describe, expect, it } from 'vitest';
import { CLAUDE_ENV_POLICY, agentEnv, sanitizedEnv } from '../src/index.ts';

const HOST = {
  PATH: '/bin',
  CLAUDE_CONFIG_DIR: '/c',
  ANTHROPIC_API_KEY: 'k',
  OPENAI_API_KEY: 'o',
  GH_TOKEN: 'g',
  AWS_SECRET_ACCESS_KEY: 'a',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  CLAUDE_CODE_SESSION_ID: 'x',
  CLAUDE_AGENT_SDK_VERSION: '1',
  ANTHROPIC_BASE_URL: 'http://localhost',
  CLAUDE_PID: '1',
  USE_LOCAL_OAUTH: '1',
};

describe('sanitizedEnv', () => {
  it('tira as variáveis herdadas de uma sessão anfitriã e identifica a Solline', () => {
    expect(sanitizedEnv(HOST)).toEqual({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/c',
      ANTHROPIC_API_KEY: 'k',
      OPENAI_API_KEY: 'o',
      GH_TOKEN: 'g',
      AWS_SECRET_ACCESS_KEY: 'a',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'solline',
    });
  });

  it('é a política do Claude: o ambiente dele não mudou com o registo', () => {
    expect(agentEnv(CLAUDE_ENV_POLICY, HOST)).toEqual(sanitizedEnv(HOST));
  });
});

describe('agentEnv', () => {
  it('em no-secrets só passam os segredos declarados', () => {
    const env = agentEnv({ base: 'no-secrets', keys: ['OPENAI_API_KEY'] }, HOST);
    expect(env).toMatchObject({ PATH: '/bin', OPENAI_API_KEY: 'o', CLAUDE_CONFIG_DIR: '/c' });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('CLAUDECODE');
  });

  it('o herdado sai sempre, mesmo no overlay de origem', () => {
    const env = agentEnv({ base: 'host' }, HOST);
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
  });

  it('copia variáveis de origem, larga as pedidas e o overlay ganha no fim', () => {
    const env = agentEnv(
      {
        base: 'no-secrets',
        drop: ['CLAUDE_CONFIG_DIR'],
        fromEnv: { ANTHROPIC_AUTH_TOKEN: 'DEEPSEEK_API_KEY' },
        overlay: { ANTHROPIC_BASE_URL: 'https://api.example.com', PATH: '/outro' },
      },
      { ...HOST, DEEPSEEK_API_KEY: 'd' },
    );
    expect(env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'd',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
      PATH: '/outro',
    });
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY');
  });
});
