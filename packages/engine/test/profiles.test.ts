import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@solline/protocol';
import {
  ClaudeSdkAdapter,
  DEEPSEEK,
  SessionManager,
  agentEnv,
  profileDefinition,
  registryOf,
  withFactories,
  type CredentialReader,
} from '../src/index.ts';
import { fakeQuery, loadFixture, recordingSink, waitFor } from './helpers.ts';

const HOST = {
  PATH: '/bin',
  ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer da-anthropic',
  ANTHROPIC_API_KEY: 'chave-anthropic',
  ANTHROPIC_AUTH_TOKEN: 'token-anthropic',
  ANTHROPIC_BASE_URL: 'http://localhost:9999',
  OPENAI_API_KEY: 'o',
  GH_TOKEN: 'g',
  CLAUDE_CONFIG_DIR: 'C:/Users/eu/.claude',
};

function deepseek(options: { stored?: string | null; env?: NodeJS.ProcessEnv } = {}) {
  const reads: string[] = [];
  const readCredential: CredentialReader = async (target, mode) => {
    reads.push(`${mode}:${target}`);
    const stored = options.stored ?? null;
    return mode === 'check' ? stored !== null : stored;
  };
  const definition = profileDefinition(DEEPSEEK, {
    dataDir: path.join(tmpdir(), 'solline-dados'),
    readCredential,
    env: options.env ?? {},
  });
  return { definition, reads };
}

describe('perfil DeepSeek: ambiente', () => {
  it('fala com a DeepSeek, com config própria e sem segredos nem endereço do anfitrião', () => {
    const { definition } = deepseek();
    const env = agentEnv(definition.envPolicy, HOST);
    expect(env).toMatchObject({
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'solline',
      CLAUDE_CONFIG_DIR: path.join(tmpdir(), 'solline-dados', 'profiles', 'deepseek'),
    });
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_CUSTOM_HEADERS',
      'OPENAI_API_KEY',
      'GH_TOKEN',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('é experimental, chama-se DeepSeek e não oferece Auto', () => {
    const { definition } = deepseek();
    expect(definition).toMatchObject({
      id: 'claude:deepseek',
      label: 'DeepSeek',
      experimental: true,
    });
    expect(definition.staticModes.map((m) => m.id)).not.toContain('auto');
  });
});

describe('perfil DeepSeek: chave', () => {
  it('a variável de ambiente ganha ao Gestor de Credenciais', async () => {
    const { definition, reads } = deepseek({
      stored: 'guardada',
      env: { DEEPSEEK_API_KEY: ' var ' },
    });
    expect(await definition.secrets!()).toEqual({ ANTHROPIC_AUTH_TOKEN: 'var' });
    expect(reads).toEqual([]);
  });

  it('sem variável, lê a credencial genérica solline/deepseek', async () => {
    const { definition, reads } = deepseek({ stored: 'guardada' });
    expect(await definition.secrets!()).toEqual({ ANTHROPIC_AUTH_TOKEN: 'guardada' });
    expect(reads).toEqual(['read:solline/deepseek']);
  });

  it('sem chave não arranca e diz onde a pôr', async () => {
    const { definition } = deepseek();
    await expect(definition.secrets!()).rejects.toThrow('Gestor de Credenciais');
  });

  it('o detect só verifica se a credencial existe, sem a ler', async () => {
    const missing = deepseek();
    const status = await missing.definition.detect();
    if (status.status !== 'not-found') {
      expect(status).toMatchObject({ status: 'needs-key' });
      expect(missing.reads).toEqual(['check:solline/deepseek']);
    }
    const stored = deepseek({ stored: 'x' });
    const ready = await stored.definition.detect();
    if (ready.status !== 'not-found') expect(ready).toEqual({ status: 'ready' });
  });

  it('o SessionManager não cria o adaptador sem chave', async () => {
    const created: string[] = [];
    const { definition } = deepseek();
    const registry = withFactories(registryOf([definition]), {
      'claude:deepseek': () => {
        created.push('x');
        throw new Error('não devia chegar aqui');
      },
    });
    const manager = new SessionManager({ emit: () => undefined, registry });
    await expect(
      manager.create({ projectId: 'p', agent: 'claude:deepseek', cwd: tmpdir(), trusted: true }),
    ).rejects.toThrow('Falta a chave da DeepSeek');
    expect(created).toEqual([]);
  });
});

describe('perfil DeepSeek: adaptador', () => {
  function adapter(fixture = 'plain-answer') {
    const fake = fakeQuery(loadFixture(fixture));
    const sink = recordingSink();
    const a = new ClaudeSdkAdapter(
      {
        cwd: 'C:/tmp/proj',
        mode: 'default',
        queryFn: fake.queryFn,
        projectTrusted: true,
        profile: DEEPSEEK.claude,
      },
      sink,
    );
    return { fake, sink, adapter: a };
  }

  it('não lê definições, mostra os modelos da DeepSeek, sem Auto nem custo', async () => {
    const { fake, adapter: a } = adapter();
    const started = await a.start();
    expect(fake.options().settingSources).toEqual([]);
    expect(started.capabilities.models).toEqual([
      expect.objectContaining({ id: 'default', label: 'DeepSeek Flash' }),
    ]);
    expect(started.capabilities.models[0]!.efforts.length).toBeGreaterThan(0);
    expect(started.capabilities.modes.map((m) => m.id)).not.toContain('auto');
    expect(started.capabilities.features.cost).toBe(false);
    expect(started.settings.model).toBe('default');
    await a.close();
  });

  it('"Permitir sempre" fica na sessão mesmo num projeto de confiança', async () => {
    const { sink, adapter: a } = adapter('edit-with-permission');
    await a.start();
    const ask = sink.nextAsk();
    await a.send('edita');
    expect(await ask).toMatchObject({ kind: 'permission', alwaysScope: 'session' });
    await a.close();
  });

  it('o custo que o claude.exe calcula (preços do Claude) não chega à interface', async () => {
    const events: EngineEvent[] = [];
    const { definition } = deepseek({ stored: 'k' });
    const registry = withFactories(registryOf([definition]), {
      'claude:deepseek': (options, sink) =>
        new ClaudeSdkAdapter(
          {
            ...options,
            queryFn: fakeQuery(loadFixture('plain-answer')).queryFn,
            profile: DEEPSEEK.claude,
          },
          sink,
        ),
    });
    const manager = new SessionManager({ emit: (e) => events.push(e), registry });
    const { session } = await manager.create({
      projectId: 'p',
      agent: 'claude:deepseek',
      cwd: tmpdir(),
      trusted: true,
    });
    await manager.send(session.id, 'olá');
    await waitFor(() =>
      events.some((e) => e.type === 'session.event' && e.delta.type === 'turn.end'),
    );
    const usage = events.flatMap((e) =>
      e.type === 'session.event' && e.delta.type === 'usage' ? [e.delta.usage] : [],
    );
    expect(usage.length).toBeGreaterThan(0);
    for (const u of usage) {
      expect(u).not.toHaveProperty('costUsd');
      for (const row of u.models ?? []) expect(row.costUsd).toBeNull();
    }
    expect(usage.some((u) => u.tokens)).toBe(true);
    await manager.disposeAll();
  });
});
