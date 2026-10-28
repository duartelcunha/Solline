import { describe, expect, it } from 'vitest';
import type { McpCatalogServer, McpServerSpec } from '@solline/protocol';
import { applyValues, approvalPrompt, newServerId } from './mcp-main.ts';

const spec: McpServerSpec = {
  label: 'Acme',
  command: 'npx',
  args: ['-y', '@acme/search@1.2.3', '--modo', 'seguro a'],
  env: [
    { name: 'ACME_KEY', secret: true, required: true },
    { name: 'ACME_REGION', secret: false, required: false },
  ],
  source: {
    kind: 'registry',
    name: 'io.github.acme/search',
    version: '1.2.3',
    registryType: 'npm',
    identifier: '@acme/search',
    verified: 'github',
  },
};

function server(over: Partial<McpCatalogServer> = {}): McpCatalogServer {
  return {
    id: 'abc',
    name: 'acme',
    spec,
    commandLine: 'npx -y @acme/search@1.2.3 --modo "seguro a"',
    fingerprint: '0'.repeat(64),
    status: 'needs-approval',
    approved: false,
    tools: null,
    toolsHash: null,
    probedAt: null,
    changed: null,
    error: null,
    createdAt: 0,
    ...over,
  };
}

describe('valores das variáveis', () => {
  it('os secretos saem à parte e nunca ficam nos dados do catálogo; os públicos ficam', () => {
    const { spec: out, secrets } = applyValues(spec, { ACME_KEY: 'segredo', ACME_REGION: 'eu' });
    expect(secrets).toEqual({ ACME_KEY: 'segredo' });
    expect(JSON.stringify(out)).not.toContain('segredo');
    expect(out.env).toEqual([
      { name: 'ACME_KEY', secret: true, required: true },
      { name: 'ACME_REGION', secret: false, required: false, value: 'eu' },
    ]);
  });

  it('recusa variáveis que o servidor não declara', () => {
    expect(() => applyValues(spec, { OUTRA: 'x' })).toThrow('não existe');
  });

  it('ao mudar um servidor, o valor público que já havia fica se não deram outro', () => {
    const { spec: out } = applyValues(spec, {}, [
      { name: 'ACME_REGION', secret: false, required: false, value: 'us' },
      { name: 'ACME_KEY', secret: true, required: true },
    ]);
    expect(out.env[1]).toMatchObject({ value: 'us' });
    expect(out.env[0]).not.toHaveProperty('value');
  });

  it('ids novos servem de nome no cofre', () => {
    expect(newServerId()).toMatch(/^[a-z0-9]{12}$/);
    expect(newServerId()).not.toBe(newServerId());
  });
});

describe('confirmação nativa da aprovação', () => {
  it('mostra o comando, os argumentos e os nomes das variáveis exatos', () => {
    const prompt = approvalPrompt(server());
    expect(prompt.message).toBe(
      'A Solline vai arrancar `npx -y @acme/search@1.2.3 --modo "seguro a"` com as variáveis ACME_KEY (secreta), ACME_REGION (sem valor). Permitir?',
    );
    expect(prompt.detail).toContain('registo oficial');
    expect(prompt.detail).toContain('GitHub');
    expect(prompt.detail).toContain('Gestor de Credenciais');
  });

  it('mostra o valor de cada variável pública: tudo o que a impressão aprova se vê', () => {
    const prompt = approvalPrompt(
      server({
        spec: {
          ...spec,
          env: [
            { name: 'ACME_KEY', secret: true, required: true },
            { name: 'ACME_REGION', secret: false, required: false, value: 'eu west' },
          ],
        },
      }),
    );
    expect(prompt.message).toContain('ACME_KEY (secreta)');
    expect(prompt.message).toContain('ACME_REGION="eu west"');
  });

  it('sem variáveis, diz-o; à mão, diz que foi escrito pelo utilizador', () => {
    const prompt = approvalPrompt(
      server({
        spec: { ...spec, env: [], source: { kind: 'manual' } },
        commandLine: 'uvx x==1.0.0',
      }),
    );
    expect(prompt.message).toContain('sem variáveis');
    expect(prompt.detail).toContain('escrito por ti');
  });

  it('com as ferramentas mudadas, mostra o que mudou', () => {
    const prompt = approvalPrompt(
      server({
        status: 'changed',
        approved: true,
        changed: {
          added: ['apagar'],
          removed: ['ler'],
          altered: ['escrever'],
          hash: '1'.repeat(64),
        },
      }),
    );
    expect(prompt.title).toBe('Ferramentas mudadas');
    expect(prompt.detail).toContain('Novas: apagar');
    expect(prompt.detail).toContain('Tiradas: ler');
    expect(prompt.detail).toContain('Alteradas: escrever');
    expect(prompt.message).toContain('npx -y @acme/search@1.2.3');
  });
});
