import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDescriptor, EngineEvent, ResponseEnvelope } from '@solline/protocol';
import {
  CATALOG,
  Engine,
  LoginManager,
  REVIEWED_CODEX_VERSION,
  catalogArgs,
  catalogDefinition,
  claudeDefinition,
  codexDefinition,
  codexNeedsLogin,
  fileAgentSettings,
  findBinaryAgent,
  memoryAgentSettings,
  registryOf,
  startCodexLogin,
  withFactories,
  type AgentStartOptions,
  type BinaryVersionCacheEntry,
  type LoginFlow,
} from '../src/index.ts';
import { fakeCodexServer } from './codex-fakes.ts';
import { waitFor } from './helpers.ts';

const LOGGED_OUT = { account: null, requiresOpenaiAuth: true };

let next = 0;
function call(engine: Engine, command: string, payload: unknown): Promise<ResponseEnvelope> {
  return engine.handle({ kind: 'request', id: `a${++next}`, command, payload });
}

async function agents(engine: Engine, refresh?: boolean): Promise<AgentDescriptor[]> {
  const listed = await call(engine, 'agents.list', refresh ? { refresh } : {});
  if (!listed.ok) throw new Error(listed.error.message);
  return (listed.result as { agents: AgentDescriptor[] }).agents;
}

describe('conta do Codex', () => {
  it('sem conta e com auth da OpenAI precisa de login; não pede um token novo', async () => {
    const server = fakeCodexServer({ account: LOGGED_OUT });
    expect(await codexNeedsLogin(server.transport())).toBe(true);
    const read = server.received.find((m) => m.method === 'account/read');
    expect(read?.params).toEqual({ refreshToken: false });
    expect(server.killed).toBe(true);
  });

  it('com conta do ChatGPT está pronto', async () => {
    const server = fakeCodexServer();
    expect(await codexNeedsLogin(server.transport())).toBe(false);
  });

  it('o login devolve o endereço da OpenAI e acaba com o account/login/completed', async () => {
    const server = fakeCodexServer({ account: LOGGED_OUT });
    const flow = await startCodexLogin(server.transport());
    expect(flow.url).toMatch(/^https:\/\/auth\.openai\.com\//);
    const start = server.received.find((m) => m.method === 'account/login/start');
    expect(start?.params).toEqual({ type: 'chatgpt' });
    // Um fim de outro login não conta.
    server.notify('account/login/completed', { loginId: 'outro', success: false, error: 'x' });
    server.notify('account/login/completed', {
      loginId: 'login-1',
      success: true,
      error: null,
      onboardingEntrypoint: null,
    });
    await expect(flow.done).resolves.toBeUndefined();
    expect(server.killed).toBe(true);
  });

  it('um login recusado acaba com o erro do Codex', async () => {
    const server = fakeCodexServer();
    const flow = await startCodexLogin(server.transport());
    server.notify('account/login/completed', {
      loginId: 'login-1',
      success: false,
      error: 'access_denied',
      onboardingEntrypoint: null,
    });
    await expect(flow.done).rejects.toThrow('access_denied');
  });

  it('cancelar manda account/login/cancel e fecha o processo', async () => {
    const server = fakeCodexServer();
    const flow = await startCodexLogin(server.transport());
    await flow.cancel();
    await expect(flow.done).rejects.toThrow('cancelado');
    expect(server.received.find((m) => m.method === 'account/login/cancel')?.params).toEqual({
      loginId: 'login-1',
    });
    expect(server.killed).toBe(true);
  });

  it('se o Codex cair a meio, o login falha com uma frase calma', async () => {
    const server = fakeCodexServer();
    const flow = await startCodexLogin(server.transport());
    server.crash();
    await expect(flow.done).rejects.toThrow('fechou antes de acabar o login');
  });

  it('uma resposta de login desconhecida não deixa o processo vivo', async () => {
    const server = fakeCodexServer({ login: { type: 'apiKey' } });
    await expect(startCodexLogin(server.transport())).rejects.toThrow('não conhece');
    expect(server.killed).toBe(true);
  });
});

function manualFlow(url = 'https://auth.openai.com/x') {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const done = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  done.catch(() => undefined);
  const cancelled: string[] = [];
  const flow: LoginFlow = {
    url,
    done,
    cancel: async () => {
      cancelled.push(url);
      reject(new Error('Login cancelado'));
    },
  };
  return { flow, resolve, reject, cancelled };
}

describe('LoginManager', () => {
  it('um segundo login do mesmo agente cancela o primeiro', async () => {
    const changes: [string, string | undefined][] = [];
    const logins = new LoginManager({ onChange: (a, e) => changes.push([a, e]) });
    const first = manualFlow('https://auth.openai.com/1');
    const second = manualFlow('https://auth.openai.com/2');
    expect(await logins.start('codex', async () => first.flow)).toBe(first.flow);
    expect(await logins.start('codex', async () => second.flow)).toBe(second.flow);
    expect(first.cancelled).toHaveLength(1);
    expect(logins.pending('codex')).toBe(true);
    second.resolve();
    await waitFor(() => !logins.pending('codex'));
    // Cancelar o primeiro avisa sem erro; o segundo acaba bem.
    expect(changes).toEqual([
      ['codex', undefined],
      ['codex', undefined],
    ]);
  });

  it('ao fim do tempo cancela e avisa que expirou', async () => {
    const changes: [string, string | undefined][] = [];
    const logins = new LoginManager({ onChange: (a, e) => changes.push([a, e]), timeoutMs: 20 });
    const login = manualFlow();
    await logins.start('codex', async () => login.flow);
    await waitFor(() => changes.length > 0);
    expect(changes[0]![1]).toMatch(/expirou/);
    expect(login.cancelled).toHaveLength(1);
    expect(logins.pending('codex')).toBe(false);
  });

  it('um segundo clique enquanto o primeiro prepara fecha o processo do primeiro', async () => {
    const logins = new LoginManager({ onChange: () => undefined });
    const first = manualFlow('https://auth.openai.com/1');
    const second = manualFlow('https://auth.openai.com/2');
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const one = logins.start('codex', async () => {
      await slow;
      return first.flow;
    });
    expect(logins.pending('codex')).toBe(true);
    const two = logins.start('codex', async () => second.flow);
    expect(await two).toBe(second.flow);
    release();
    await expect(one).rejects.toThrow('substituído');
    expect(first.cancelled).toHaveLength(1);
    expect(second.cancelled).toHaveLength(0);
    expect(logins.pending('codex')).toBe(true);
  });

  it('cancelar ou fechar o motor a meio do arranque não deixa o processo órfão', async () => {
    const logins = new LoginManager({ onChange: () => undefined });
    const login = manualFlow();
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const started = logins.start('codex', async () => {
      await slow;
      return login.flow;
    });
    await logins.cancelAll();
    expect(logins.pending('codex')).toBe(false);
    release();
    await expect(started).rejects.toThrow();
    expect(login.cancelled).toHaveLength(1);
    await expect(logins.start('codex', async () => manualFlow().flow)).rejects.toThrow('fechar');
  });

  it('um login que falha avisa com o erro', async () => {
    const changes: [string, string | undefined][] = [];
    const logins = new LoginManager({ onChange: (a, e) => changes.push([a, e]) });
    const login = manualFlow();
    await logins.start('codex', async () => login.flow);
    login.reject(new Error('access_denied'));
    await waitFor(() => changes.length > 0);
    expect(changes).toEqual([['codex', 'access_denied']]);
  });
});

function codexEngine(account: unknown) {
  const events: EngineEvent[] = [];
  const servers: ReturnType<typeof fakeCodexServer>[] = [];
  let current: unknown = account;
  const definition = codexDefinition({
    resolve: () => ({ path: 'C:/codex.exe', version: REVIEWED_CODEX_VERSION, source: 'path' }),
    accountTransport: () => {
      const server = fakeCodexServer({ account: current });
      servers.push(server);
      return server.transport();
    },
  });
  const engine = new Engine({
    registry: registryOf([definition]),
    emit: (event) => events.push(event),
    settings: memoryAgentSettings(),
  });
  return {
    engine,
    events,
    servers,
    loggedIn: () => {
      current = undefined;
    },
  };
}

describe('Entrar com ChatGPT pelo motor', () => {
  it('sem sessão o Codex aparece como needs-login, com o botão e a versão', async () => {
    const { engine } = codexEngine(LOGGED_OUT);
    const [codex] = await agents(engine);
    expect(codex).toMatchObject({
      id: 'codex',
      status: 'needs-login',
      login: { label: 'Entrar com ChatGPT', pending: false },
      version: { installed: REVIEWED_CODEX_VERSION, reviewed: REVIEWED_CODEX_VERSION },
    });
    expect(codex).not.toHaveProperty('keys');
  });

  it('a resposta fica guardada; refresh volta a perguntar ao Codex', async () => {
    const { engine, servers } = codexEngine(LOGGED_OUT);
    await agents(engine);
    await agents(engine);
    expect(servers).toHaveLength(1);
    await agents(engine, true);
    expect(servers).toHaveLength(2);
  });

  it('o login acaba com agents.changed e a lista volta a perguntar', async () => {
    const { engine, events, servers, loggedIn } = codexEngine(LOGGED_OUT);
    await agents(engine);
    const started = await call(engine, 'agents.loginStart', { agent: 'codex' });
    expect(started).toMatchObject({
      ok: true,
      result: { url: expect.stringMatching(/^https:\/\/auth\.openai\.com\//) },
    });
    expect((await agents(engine))[0]!.login).toEqual({
      label: 'Entrar com ChatGPT',
      pending: true,
    });
    const login = servers.at(-1)!;
    loggedIn();
    login.notify('account/login/completed', {
      loginId: 'login-1',
      success: true,
      error: null,
      onboardingEntrypoint: null,
    });
    await waitFor(() => events.some((e) => e.type === 'agents.changed'));
    expect(events.find((e) => e.type === 'agents.changed')).toEqual({
      kind: 'event',
      type: 'agents.changed',
      agent: 'codex',
    });
    const [codex] = await agents(engine);
    expect(codex).toMatchObject({ status: 'ready', login: { pending: false } });
  });

  it('cancelar pelo motor fecha o processo do login', async () => {
    const { engine, servers } = codexEngine(LOGGED_OUT);
    await call(engine, 'agents.loginStart', { agent: 'codex' });
    const cancelled = await call(engine, 'agents.loginCancel', { agent: 'codex' });
    expect(cancelled.ok).toBe(true);
    expect(servers.at(-1)!.killed).toBe(true);
    expect((await agents(engine))[0]!.login?.pending).toBe(false);
  });

  it('um agente sem login dentro da app recusa o loginStart', async () => {
    const engine = new Engine({ registry: registryOf([claudeDefinition({ isolated: true })]) });
    const refused = await call(engine, 'agents.loginStart', { agent: 'claude' });
    expect(refused).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/login/) },
    });
  });

  it('o loginStart não se manda pela interface (só o main)', async () => {
    const { engine } = codexEngine(LOGGED_OUT);
    // O motor aceita-o (vem do main); o que interessa é que não está no contrato da interface.
    const { CommandNameSchema } = await import('@solline/protocol');
    expect(CommandNameSchema.safeParse('agents.loginStart').success).toBe(false);
    expect(CommandNameSchema.safeParse('agents.saveKeys').success).toBe(false);
    expect(CommandNameSchema.safeParse('agents.keys').success).toBe(false);
    expect(CommandNameSchema.safeParse('agents.login').success).toBe(true);
    await engine.dispose();
  });
});

describe('variáveis escolhidas para os agentes ACP', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    delete process.env.SOLLINE_TESTE_API_KEY;
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  function acpEngine(settings = memoryAgentSettings()) {
    const entry = CATALOG[0]!;
    const definition = catalogDefinition(entry, () => ({
      binary: 'C:/opencode.exe',
      version: entry.reviewedVersion,
    }));
    const started: AgentStartOptions[] = [];
    const registry = withFactories(registryOf([definition, claudeDefinition({ isolated: true })]), {
      [entry.id]: (options) => {
        started.push(options);
        throw new Error('só queremos o ambiente');
      },
    });
    const engine = new Engine({
      registry,
      settings,
      env: { PATH: '/bin', SOLLINE_TESTE_API_KEY: 'v', OUTRA_SECRET: 's', NADA: 'n' },
    });
    return { engine, started, id: entry.id };
  }

  it('só recebe a variável depois de a escolheres', async () => {
    process.env.SOLLINE_TESTE_API_KEY = 'valor';
    const { engine, started, id } = acpEngine();
    const open = () =>
      call(engine, 'session.start', { projectId: 'p', agent: id, cwd: tmpdir(), trusted: true });
    await open();
    expect(started[0]!.env).not.toHaveProperty('SOLLINE_TESTE_API_KEY');
    expect(
      await call(engine, 'agents.saveKeys', { agent: id, keys: ['SOLLINE_TESTE_API_KEY'] }),
    ).toMatchObject({ ok: true });
    expect(await call(engine, 'agents.keys', { agent: id })).toMatchObject({
      ok: true,
      result: { label: 'OpenCode', keys: ['SOLLINE_TESTE_API_KEY'] },
    });
    const listed = (await agents(engine)).find((a) => a.id === id);
    expect(listed?.keys).toEqual(['SOLLINE_TESTE_API_KEY']);
    await open();
    expect(started[1]!.env).toMatchObject({ SOLLINE_TESTE_API_KEY: 'valor' });
  });

  it('o Claude não deixa escolher (recebe o ambiente todo) e os nomes são validados', async () => {
    const { engine, id } = acpEngine();
    expect(
      await call(engine, 'agents.saveKeys', { agent: 'claude', keys: ['X_API_KEY'] }),
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/não deixa/) } });
    for (const keys of [['nome com espaço'], ['A=B'], ['X', 'x'], Array(33).fill('K')]) {
      const refused = await call(engine, 'agents.saveKeys', { agent: id, keys });
      expect(refused.ok).toBe(false);
    }
    expect((await agents(engine)).find((a) => a.id === 'claude')).not.toHaveProperty('keys');
  });

  it('as sugestões são só nomes que parecem segredos', async () => {
    const { engine } = acpEngine();
    expect(await call(engine, 'agents.keyCandidates', {})).toMatchObject({
      ok: true,
      result: { names: ['OUTRA_SECRET', 'SOLLINE_TESTE_API_KEY'] },
    });
  });

  it('ficam em agent-settings.json; um ficheiro estragado conta como vazio', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'solline-settings-'));
    dirs.push(dir);
    const settings = fileAgentSettings(dir);
    await settings.setKeys('opencode', ['A_KEY', 'B_TOKEN']);
    expect(JSON.parse(await readFile(path.join(dir, 'agent-settings.json'), 'utf8'))).toEqual({
      version: 1,
      agents: { opencode: { keys: ['A_KEY', 'B_TOKEN'] } },
    });
    expect(await fileAgentSettings(dir).keys('opencode')).toEqual(['A_KEY', 'B_TOKEN']);
    await settings.setKeys('opencode', []);
    expect(await settings.keys('opencode')).toEqual([]);
    await writeFile(
      path.join(dir, 'agent-settings.json'),
      '{"version":1,"agents":{"x":{"keys":["a b"]}}}',
    );
    expect(await settings.keys('x')).toEqual([]);
    // Escrever por cima de um ficheiro que não se leu guarda primeiro uma cópia.
    await settings.setKeys('opencode', ['C_KEY']);
    const backups = (await readdir(dir)).filter((f) => f.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(dir, backups[0]!), 'utf8')).toContain('a b');
  });
});

describe('catálogo de binários nativos (omp acp)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('procura apenas em pastas absolutas, recusa .cmd/.bat, usa fallbackPaths e faz cache por mtimeMs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'solline-bin-'));
    dirs.push(dir);
    const pathBin = path.join(dir, 'bin');
    const localAppData = path.join(dir, 'localappdata');
    await mkdir(pathBin, { recursive: true });
    await mkdir(path.join(localAppData, 'omp'), { recursive: true });

    // Um .cmd no PATH tem de ser recusado no Windows; cai para fallbackPaths (%LOCALAPPDATA%\omp\omp.exe).
    await writeFile(path.join(pathBin, 'omp.cmd'), '@echo off\n');
    const fallbackExe = path.join(localAppData, 'omp', 'omp.exe');
    await writeFile(fallbackExe, 'bin');

    const omp = CATALOG.find((e) => e.id === 'omp')!;
    const cache = new Map<string, BinaryVersionCacheEntry>();
    let calls = 0;
    const exec = () => {
      calls += 1;
      return `omp/${omp.reviewedVersion}\n`;
    };

    // Ignora entrada relativa no PATH.
    expect(
      findBinaryAgent(omp, {
        pathEnv: 'relativo',
        env: {},
        platform: 'win32',
        exec,
        cache,
      }),
    ).toBeNull();
    expect(calls).toBe(0);

    // .cmd no PATH é ignorado; encontra fallbackExe e usa cache na segunda leitura.
    const first = findBinaryAgent(omp, {
      pathEnv: ['relativo', pathBin].join(path.delimiter),
      env: { LOCALAPPDATA: localAppData },
      platform: 'win32',
      exec,
      cache,
    });
    expect(first).toEqual({ binary: fallbackExe, version: omp.reviewedVersion });
    expect(calls).toBe(1);

    const second = findBinaryAgent(omp, {
      pathEnv: pathBin,
      env: { LOCALAPPDATA: localAppData },
      platform: 'win32',
      exec,
      cache,
    });
    expect(second).toEqual(first);
    expect(calls).toBe(1);

    // Mudar mtimeMs invalida a cache; refresh: true também força nova leitura.
    const future = new Date(Date.now() + 5_000);
    await utimes(fallbackExe, future, future);
    findBinaryAgent(omp, {
      pathEnv: pathBin,
      env: { LOCALAPPDATA: localAppData },
      platform: 'win32',
      exec,
      cache,
    });
    expect(calls).toBe(2);

    findBinaryAgent(omp, {
      pathEnv: pathBin,
      env: { LOCALAPPDATA: localAppData },
      platform: 'win32',
      refresh: true,
      exec,
      cache,
    });
    expect(calls).toBe(3);

    // Binário no PATH absoluto prevalece sobre fallbackPaths e valida versão não revista.
    const exeInPath = path.join(pathBin, 'omp.exe');
    await writeFile(exeInPath, 'bin');
    const mismatched = findBinaryAgent(omp, {
      pathEnv: pathBin,
      env: { LOCALAPPDATA: localAppData },
      platform: 'win32',
      exec: () => 'omp/99.0.0\n',
      cache,
    });
    expect(mismatched).toEqual({ binary: exeInPath, version: '99.0.0' });
    const def = catalogDefinition(omp, () => mismatched);
    expect(await def.detect()).toMatchObject({ status: 'unreviewed' });
  });

  it('materializa o overlay always-ask de forma atómica e exige projeto de confiança', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'solline-omp-data-'));
    dirs.push(dataDir);
    const omp = CATALOG.find((e) => e.id === 'omp')!;
    expect(CATALOG[0]!.id).toBe('opencode');
    expect(omp.untrustedProjects).toBe('refused');
    expect(omp.envPolicy.base).toBe('no-secrets');

    const args = catalogArgs(omp, dataDir);
    const overlayPath = path.join(dataDir, 'agents', 'omp-solline-overlay.yml');
    expect(args).toEqual(['--config', overlayPath, 'acp']);

    const yaml = await readFile(overlayPath, 'utf8');
    expect(yaml).toContain('approvalMode: always-ask');
    expect(yaml).toContain('memory:\n  backend: off');
    expect(yaml).toContain('memories:\n  enabled: false');
    expect(yaml).toContain('autolearn:\n  enabled: false');
    expect(yaml).toContain('checkpoint:\n  enabled: false');
    expect(yaml).toContain('advisor:\n  enabled: false');
    expect(yaml).toContain('startup:\n  checkUpdate: false');
    expect(yaml).toContain('update:\n  auto: false');
    expect(yaml).toContain('collab:\n  autoStart: off');
    expect(yaml).toContain('contextFiles:\n  extra: []');

    // Segunda chamada preserva o ficheiro sem deixar temporários.
    expect(catalogArgs(omp, dataDir)).toEqual(['--config', overlayPath, 'acp']);
    expect(await readdir(path.join(dataDir, 'agents'))).toEqual(['omp-solline-overlay.yml']);
  });
});
