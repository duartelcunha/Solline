import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HostRequest,
  MemorySecretStore,
  McpServerSpec,
  mcpSecretTarget,
  type McpCatalogState,
  type McpServerSpec as Spec,
} from '@solline/protocol';
import {
  HostLink,
  McpLaunchError,
  McpRegistry,
  UserMcpCatalog,
  probeMcpServer,
  resolveCommand,
  secretReaderFrom,
  type ProbeFn,
  type RegistryFetch,
} from '../src/index.ts';
import { toolPrint, toolsFingerprint } from '../src/mcp/spec.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'solline-mcp-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// O registo oficial (resposta falsa)

const official = (status = 'active') => ({
  'io.modelcontextprotocol.registry/official': { status, isLatest: true },
});
const entry = (server: object, status?: string) => ({ server, _meta: official(status) });

const NPM_SERVER = {
  name: 'io.github.acme/search',
  title: 'Acme Search',
  description: 'Pesquisa\nna Acme',
  version: '1.2.3',
  repository: { url: 'https://github.com/acme/search' },
  packages: [
    {
      registryType: 'npm',
      identifier: '@acme/search-mcp',
      version: '1.2.3',
      runtimeHint: 'npx',
      transport: { type: 'stdio' },
      runtimeArguments: [{ type: 'positional', value: '-y' }],
      packageArguments: [{ type: 'named', name: '--modo', value: 'seguro' }],
      environmentVariables: [
        { name: 'ACME_API_KEY', isRequired: true, isSecret: true },
        { name: 'ACME_REGION', description: 'Região' },
        { name: 'ACME_PUBLIC', isSecret: false },
      ],
    },
  ],
};
const PYPI_SERVER = {
  name: 'com.example/py',
  version: '0.3.0',
  packages: [
    {
      registryType: 'pypi',
      identifier: 'example-mcp',
      version: '0.3.0',
      transport: { type: 'stdio' },
    },
  ],
};
const REMOTE_SERVER = {
  name: 'ai.x/remote',
  version: '1.0.0',
  remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp' }],
};
const OCI_SERVER = {
  name: 'com.docker/img',
  version: '1.0.0',
  packages: [{ registryType: 'oci', identifier: 'docker.io/x/y', version: '1.0.0' }],
};
const latest = (pkgVersion: string) => ({
  name: 'com.bad/latest',
  version: '1.0.0',
  packages: [
    {
      registryType: 'npm',
      identifier: 'bad-mcp',
      version: pkgVersion,
      transport: { type: 'stdio' },
    },
  ],
});

function fakeRegistry(body: unknown) {
  const urls: { url: string; init: RequestInit }[] = [];
  const fetch: RegistryFetch = async (url, init) => {
    urls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { registry: new McpRegistry({ fetch }), urls };
}

describe('registo oficial', () => {
  it('só mostra npm e PyPI com versão fixada, com o espaço de nomes e quem o verificou', async () => {
    const { registry, urls } = fakeRegistry({
      servers: [
        entry(NPM_SERVER),
        entry(PYPI_SERVER),
        entry(REMOTE_SERVER),
        entry(OCI_SERVER),
        entry(latest('latest')),
        entry(latest('^1.0.0')),
        entry({ ...NPM_SERVER, name: 'io.github.acme/velho' }, 'deprecated'),
      ],
      metadata: { nextCursor: 'seguinte' },
    });
    const result = await registry.search('  pesquisa ');
    expect(result.results.map((r) => [r.name, r.commandLine])).toEqual([
      ['io.github.acme/search', 'npx -y @acme/search-mcp@1.2.3 --modo seguro'],
      ['com.example/py', 'uvx example-mcp==0.3.0'],
    ]);
    expect(result.results[0]).toMatchObject({
      namespace: 'io.github.acme',
      verified: 'github',
      registryType: 'npm',
      description: 'Pesquisa na Acme',
    });
    expect(result.results[1]).toMatchObject({ namespace: 'com.example', verified: 'dns' });
    expect(result.skipped).toEqual({ remote: 1, other: 4 });
    expect(result.nextCursor).toBe('seguinte');
    // Uma variável é secreta a menos que o registo diga o contrário.
    expect(result.results[0]!.env).toEqual([
      { name: 'ACME_API_KEY', secret: true, required: true },
      { name: 'ACME_REGION', secret: true, required: false, description: 'Região' },
      { name: 'ACME_PUBLIC', secret: false, required: false },
    ]);
    // O pedido leva só o texto pesquisado.
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!.url);
    expect(url.origin).toBe('https://registry.modelcontextprotocol.io');
    expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'search', 'version']);
    expect(url.searchParams.get('search')).toBe('pesquisa');
    expect(urls[0]!.init.redirect).toBe('error');
    expect(Object.keys(urls[0]!.init.headers as object).sort()).toEqual(['accept', 'user-agent']);
  });

  it('recusa latest, intervalos e curingas ao resolver', async () => {
    for (const version of ['latest', '^1.0.0', '1.x', '>=1', '*', '']) {
      const { registry } = fakeRegistry({ server: latest(version), _meta: official() });
      await expect(registry.resolve('com.bad/latest', '1.0.0')).rejects.toThrow('versão fixada');
    }
  });

  it('refaz o comando a partir do registo e ignora o que ele manda correr', async () => {
    const hostile = {
      ...NPM_SERVER,
      packages: [
        {
          ...NPM_SERVER.packages[0],
          runtimeHint: 'powershell',
          runtimeArguments: [{ type: 'positional', value: '-c calc.exe' }],
        },
      ],
    };
    const { registry } = fakeRegistry({ server: hostile, _meta: official() });
    const spec = McpServerSpec.parse(await registry.resolve('io.github.acme/search', '1.2.3'));
    expect(spec.command).toBe('npx');
    expect(spec.args).toEqual(['-y', '@acme/search-mcp@1.2.3', '--modo', 'seguro']);
    expect(spec.source).toMatchObject({ kind: 'registry', verified: 'github' });
  });

  it('PyPI vira uvx com versão fixada; remoto e variáveis perigosas ficam de fora', async () => {
    const py = fakeRegistry({ server: PYPI_SERVER, _meta: official() });
    expect((await py.registry.resolve('com.example/py', '0.3.0')).args).toEqual([
      'example-mcp==0.3.0',
    ]);
    const remote = fakeRegistry({ server: REMOTE_SERVER, _meta: official() });
    await expect(remote.registry.resolve('ai.x/remote', '1.0.0')).rejects.toThrow('remoto');
    const dangerous = fakeRegistry({
      server: {
        ...NPM_SERVER,
        packages: [
          {
            ...NPM_SERVER.packages[0],
            environmentVariables: [{ name: 'NODE_OPTIONS', isSecret: false }],
          },
        ],
      },
      _meta: official(),
    });
    await expect(dangerous.registry.resolve('io.github.acme/search', '1.2.3')).rejects.toThrow(
      'pacote',
    );
  });

  it('recusa outro servidor, resposta inválida e erro HTTP', async () => {
    const other = fakeRegistry({ server: PYPI_SERVER, _meta: official() });
    await expect(other.registry.resolve('io.github.acme/search', '1.2.3')).rejects.toThrow(
      'outro servidor',
    );
    const garbage = fakeRegistry({ servers: 'x' });
    await expect(garbage.registry.search('x')).rejects.toThrow('formato');
    const failing = new McpRegistry({ fetch: async () => new Response('', { status: 503 }) });
    await expect(failing.search('x')).rejects.toThrow('503');
    await expect(failing.resolve('sem-barra', '1')).rejects.toThrow('inválido');
  });
});

// ---------------------------------------------------------------------------------------------
// O catálogo do utilizador

const SECRET = 'segredo-super-secreto-123';

function manual(over: Partial<Spec> = {}): Spec {
  return {
    label: 'Ferramentas da equipa',
    command: process.execPath,
    args: ['servidor.mjs', '--porta', '1'],
    env: [
      { name: 'API_TOKEN', secret: true, required: true },
      { name: 'REGIAO', secret: false, required: false, value: 'eu' },
    ],
    source: { kind: 'manual' },
    ...over,
  };
}

const prints = (...names: string[]) =>
  names.map((name) =>
    toolPrint({ name, description: `Faz ${name}`, inputSchema: { type: 'object' } }),
  );

function build(options: { dataDir?: string; tools?: string[] } = {}) {
  const calls: { command: string; args: readonly string[]; env: Record<string, string> }[] = [];
  const control = { tools: options.tools ?? ['ler', 'escrever'], fail: '' };
  const probe: ProbeFn = async (target, probeOptions) => {
    calls.push({ command: target.command, args: target.args, env: { ...target.env } });
    if (control.fail) throw new Error(control.fail);
    const tools = prints(...control.tools);
    expect(probeOptions?.secrets).toContain(SECRET);
    return { tools, hash: toolsFingerprint(tools) };
  };
  const store = new MemorySecretStore();
  const changes: McpCatalogState[] = [];
  const make = () =>
    new UserMcpCatalog({
      dataDir: options.dataDir,
      secrets: secretReaderFrom(store),
      probe,
      node: () => process.execPath,
      onChange: (state) => changes.push(state),
    });
  return { catalog: make(), make, store, calls, control, changes };
}

async function approved(env: ReturnType<typeof build>, spec: Spec = manual(), id = 'srv1') {
  await env.store.set(mcpSecretTarget(id, 'API_TOKEN'), SECRET);
  const added = env.catalog.add(id, spec);
  await env.catalog.approve(id, { fingerprint: added.fingerprint });
  return added;
}

describe('catálogo do utilizador', () => {
  it('acrescentar à mão fica por aprovar e escolhe um nome livre para o agente', () => {
    const { catalog } = build();
    const a = catalog.add('a1', manual());
    const b = catalog.add('b2', manual());
    expect([a.name, b.name]).toEqual(['ferramentas-da-equipa', 'ferramentas-da-equipa-2']);
    expect(a).toMatchObject({ status: 'needs-approval', approved: false, tools: null });
    expect(catalog.add('c3', manual({ label: 'Solline' })).name).not.toBe('solline');
  });

  it('draft à mão valida e recusa comandos, variáveis e textos perigosos', async () => {
    const { catalog } = build();
    const good = {
      label: 'x',
      command: 'uvx',
      args: ['pkg==1.0.0'],
      env: [{ name: 'TOKEN', secret: true, required: true }],
    };
    expect((await catalog.draft({ kind: 'manual', spec: good })).source).toEqual({
      kind: 'manual',
    });
    for (const bad of [
      { ...good, command: '-rf' },
      { ...good, args: ['uma\nlinha'] },
      { ...good, env: [{ name: 'PATH', secret: false, required: false }] },
      { ...good, env: [{ name: 'NODE_OPTIONS', secret: false, required: false }] },
      { ...good, env: [{ name: 'npm_config_registry', secret: false, required: false }] },
      {
        ...good,
        env: [
          { name: 'A', secret: true, required: true },
          { name: 'A', secret: true, required: true },
        ],
      },
    ])
      await expect(catalog.draft({ kind: 'manual', spec: bad })).rejects.toThrow('inválidos');
    expect(() =>
      McpServerSpec.parse({
        ...manual(),
        env: [{ name: 'API_TOKEN', secret: true, required: true, value: 'x' }],
      }),
    ).toThrow();
  });

  it('exige aprovação antes de arrancar: nem a sonda nem a entrega correm', async () => {
    const env = build();
    env.catalog.add('srv1', manual());
    await env.store.set(mcpSecretTarget('srv1', 'API_TOKEN'), SECRET);
    await expect(env.catalog.launch('srv1')).rejects.toMatchObject({
      reason: 'needs-approval',
    });
    await expect(env.catalog.probe('srv1')).rejects.toBeInstanceOf(McpLaunchError);
    expect(env.calls).toHaveLength(0);
  });

  it('a aprovação só vale para a impressão que o utilizador viu', async () => {
    const env = build();
    const added = env.catalog.add('srv1', manual());
    await expect(env.catalog.approve('srv1', { fingerprint: '0'.repeat(64) })).rejects.toThrow(
      'mudou depois',
    );
    expect(env.catalog.get('srv1').approved).toBe(false);
    expect(env.calls).toHaveLength(0);
    // Aprovado: a sonda corre uma vez e guarda as ferramentas e a impressão.
    await env.store.set(mcpSecretTarget('srv1', 'API_TOKEN'), SECRET);
    const { server } = await env.catalog.approve('srv1', { fingerprint: added.fingerprint });
    expect(env.calls).toHaveLength(1);
    expect(server).toMatchObject({ status: 'ready', approved: true });
    expect(server.tools?.map((t) => t.name)).toEqual(['ler', 'escrever']);
    expect(server.toolsHash).toBe(toolsFingerprint(prints('ler', 'escrever')));
    expect(server.probedAt).not.toBeNull();
  });

  it('a sonda arranca com as variáveis e os segredos certos, e a entrega não volta a sondar', async () => {
    const env = build();
    await approved(env);
    expect(env.calls[0]).toMatchObject({
      command: process.execPath,
      args: ['servidor.mjs', '--porta', '1'],
      env: { API_TOKEN: SECRET, REGIAO: 'eu' },
    });
    const launch = await env.catalog.launch('srv1');
    expect(launch).toMatchObject({
      id: 'srv1',
      name: 'ferramentas-da-equipa',
      command: process.execPath,
      args: ['servidor.mjs', '--porta', '1'],
      env: { API_TOKEN: SECRET, REGIAO: 'eu' },
      executesCode: true,
    });
    await env.catalog.launch('srv1');
    expect(env.calls).toHaveLength(1);
  });

  it('mudar os argumentos, o comando ou as variáveis volta a pedir aprovação', async () => {
    const env = build();
    await approved(env);
    const base = manual();
    for (const change of [
      { args: ['outro.mjs'] },
      { command: process.execPath.replace(/node/i, 'nodo') },
      { env: [...base.env, { name: 'MAIS', secret: false, required: false, value: '1' }] },
      { env: [{ name: 'API_TOKEN', secret: true, required: true }] },
      { env: [base.env[0]!, { name: 'REGIAO', secret: false, required: false, value: 'us' }] },
    ]) {
      const fresh = build();
      await approved(fresh);
      const updated = fresh.catalog.update('srv1', { ...base, ...change });
      expect(updated, JSON.stringify(change)).toMatchObject({
        status: 'needs-approval',
        approved: false,
        tools: null,
        toolsHash: null,
      });
      await expect(fresh.catalog.launch('srv1')).rejects.toMatchObject({
        reason: 'needs-approval',
      });
    }
    // Só o rótulo: o que corre é igual, a aprovação mantém-se.
    expect(env.catalog.update('srv1', { ...base, label: 'Outro nome' })).toMatchObject({
      status: 'ready',
      approved: true,
    });
    // Voltar a aprovar volta a guardar as ferramentas.
    const again = build();
    await approved(again);
    const changed = again.catalog.update('srv1', { ...base, args: ['outro.mjs'] });
    await again.catalog.approve('srv1', { fingerprint: changed.fingerprint });
    expect(again.calls).toHaveLength(2);
    expect(again.calls[1]!.args).toEqual(['outro.mjs']);
  });

  it('volta a sondar na primeira entrega de cada execução; se o hash mudou, bloqueia até nova aprovação', async () => {
    const dataDir = tempDir();
    const env = build({ dataDir });
    await approved(env);
    expect(env.calls).toHaveLength(1);

    // Nova execução da app: o catálogo lê-se do disco e a primeira entrega sonda outra vez.
    const sameTools = env.make();
    await sameTools.launch('srv1');
    expect(env.calls).toHaveLength(2);
    await sameTools.launch('srv1');
    expect(env.calls).toHaveLength(2);

    // Outra execução em que o servidor passou a anunciar outras ferramentas.
    env.control.tools = ['ler', 'apagar-tudo'];
    const next = env.make();
    await expect(next.launch('srv1')).rejects.toMatchObject({ reason: 'changed' });
    const view = next.get('srv1');
    expect(view.status).toBe('changed');
    expect(view.changed).toMatchObject({
      added: ['apagar-tudo'],
      removed: ['escrever'],
      altered: [],
    });
    expect(view.tools?.map((t) => t.name)).toEqual(['ler', 'escrever']);
    // Continua bloqueado sem voltar a sondar.
    const calls = env.calls.length;
    await expect(next.launch('srv1')).rejects.toMatchObject({ reason: 'changed' });
    expect(env.calls).toHaveLength(calls);
    // O bloqueio também se vê a partir do disco, noutra execução.
    await expect(env.make().launch('srv1')).rejects.toMatchObject({ reason: 'changed' });

    // Aprovar sem ver a impressão certa não serve; vendo-a, serve.
    await expect(
      next.approve('srv1', { fingerprint: view.fingerprint, toolsHash: '2'.repeat(64) }),
    ).rejects.toThrow('mudaram outra vez');
    await expect(next.approve('srv1', { fingerprint: view.fingerprint })).rejects.toThrow(
      'mudaram outra vez',
    );
    const ok = await next.approve('srv1', {
      fingerprint: view.fingerprint,
      toolsHash: view.changed!.hash,
    });
    expect(ok.server.status).toBe('ready');
    expect(ok.server.tools?.map((t) => t.name)).toEqual(['ler', 'apagar-tudo']);
    await expect(next.launch('srv1')).resolves.toMatchObject({ id: 'srv1' });
  });

  it('uma ferramenta com o esquema mudado (mesmo nome e descrição) também conta como mudança', async () => {
    const dataDir = tempDir();
    const env = build({ dataDir });
    await approved(env);
    const probe: ProbeFn = async () => {
      const tools = [
        toolPrint({ name: 'ler', description: 'Faz ler', inputSchema: { type: 'object', x: 1 } }),
        ...prints('escrever'),
      ];
      return { tools, hash: toolsFingerprint(tools) };
    };
    const next = new UserMcpCatalog({
      dataDir,
      secrets: secretReaderFrom(env.store),
      probe,
      node: () => process.execPath,
    });
    await expect(next.launch('srv1')).rejects.toMatchObject({ reason: 'changed' });
    expect(next.get('srv1').changed).toMatchObject({ added: [], removed: [], altered: ['ler'] });
  });

  it('um servidor que falha na sonda não é entregue, e o erro não leva o segredo', async () => {
    const env = build({ dataDir: tempDir() });
    await approved(env);
    const fresh = env.make();
    env.control.fail = `não arrancou: ${SECRET} inválido`;
    const error = await fresh.launch('srv1').catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'error' });
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect(String((error as Error).message)).toContain('***');
    expect(fresh.get('srv1')).toMatchObject({ status: 'error' });
    expect(JSON.stringify(fresh.state())).not.toContain(SECRET);
    // Passa a funcionar quando o servidor volta.
    env.control.fail = '';
    await expect(fresh.launch('srv1')).resolves.toMatchObject({ id: 'srv1' });
    expect(fresh.get('srv1').status).toBe('ready');
  });

  it('falta de um segredo obrigatório e cofre em falta dão erros claros, sem arrancar nada', async () => {
    const env = build();
    const added = env.catalog.add('srv1', manual());
    await env.catalog.approve('srv1', { fingerprint: added.fingerprint });
    expect(env.calls).toHaveLength(0);
    await expect(env.catalog.launch('srv1')).rejects.toThrow('falta o valor de API_TOKEN');
    const noVault = new UserMcpCatalog({
      probe: async () => ({ tools: [], hash: '0'.repeat(64) }),
    });
    noVault.add('srv1', manual());
    await noVault
      .approve('srv1', { fingerprint: noVault.get('srv1').fingerprint })
      .catch(() => undefined);
    await expect(noVault.launch('srv1')).rejects.toThrow('cofre de segredos');
  });

  it('duas sessões a arrancar juntas partilham a sonda', async () => {
    const env = build({ dataDir: tempDir() });
    await approved(env);
    const fresh = env.make();
    const before = env.calls.length;
    await Promise.all([fresh.launch('srv1'), fresh.launch('srv1'), fresh.launch('srv1')]);
    expect(env.calls.length - before).toBe(1);
  });

  it('o ficheiro do catálogo não leva segredos e a escolha por projeto guarda-se e limpa-se', async () => {
    const dataDir = tempDir();
    const env = build({ dataDir });
    await approved(env);
    await env.catalog.setProject('p1', ['srv1']);
    await env.catalog.setProject('p2', ['srv1']);
    const files = readdirSync(dataDir);
    expect(files).toEqual(['mcp-catalog.json']);
    const text = readFileSync(path.join(dataDir, 'mcp-catalog.json'), 'utf8');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('"REGIAO"');
    expect(text).toContain('"eu"');
    expect(env.make().projectServers('p1')).toEqual(['srv1']);
    expect(env.make().projectServers('p3')).toEqual([]);
    await expect(env.catalog.setProject('p1', ['nao-existe'])).rejects.toThrow('desconhecido');
    await expect(
      env.catalog.setProject(
        'p1',
        Array.from({ length: 9 }, (_, i) => `s${i}`),
      ),
    ).rejects.toThrow('no máximo 8');
    expect(env.catalog.remove('srv1')).toBe(true);
    expect(env.catalog.state().projects).toEqual({});
    expect(env.catalog.remove('srv1')).toBe(false);
    expect(env.make().state().servers).toEqual([]);
  });

  it('um catálogo ilegível guarda-se ao lado e começa vazio', () => {
    const dataDir = tempDir();
    writeFileSync(path.join(dataDir, 'mcp-catalog.json'), '{ isto não é JSON');
    const { catalog } = build({ dataDir });
    expect(catalog.state().servers).toEqual([]);
    expect(readdirSync(dataDir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it('só os servidores prontos aparecem na lista de ligar à mão a uma sessão', async () => {
    const env = build();
    env.catalog.add('a1', manual({ label: 'Por aprovar' }));
    await approved(env, manual({ label: 'Pronto' }), 'b2');
    expect(env.catalog.descriptors()).toEqual([
      { id: 'b2', label: 'Pronto', status: 'ready', executesCode: true },
    ]);
  });

  it('um servidor do registo não se edita', async () => {
    const env = build();
    env.catalog.add('r1', {
      ...manual(),
      source: {
        kind: 'registry',
        name: 'io.github.acme/search',
        version: '1.2.3',
        registryType: 'npm',
        identifier: '@acme/search-mcp',
        verified: 'github',
      },
    });
    expect(() => env.catalog.update('r1', manual())).toThrow('não se edita');
  });

  it('o evento do catálogo nunca leva segredos', async () => {
    const env = build();
    await approved(env);
    await env.catalog.launch('srv1');
    expect(env.changes.length).toBeGreaterThan(0);
    expect(JSON.stringify(env.changes)).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------------------------
// Como o comando aprovado se arranca de verdade

describe('arranque sem shell', () => {
  it('npx corre pelo Node do sistema, com os argumentos aprovados e nada mais', () => {
    const root = tempDir();
    const node = path.join(root, process.platform === 'win32' ? 'node.exe' : 'node');
    writeFileSync(node, '');
    mkdirSync(path.join(root, 'node_modules', 'npm', 'bin'), { recursive: true });
    const cli = path.join(root, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    writeFileSync(cli, '');
    expect(
      resolveCommand({ command: 'npx', args: ['-y', 'a@1.0.0', '--x'] }, { node: () => node }),
    ).toEqual({
      command: node,
      args: [cli, '-y', 'a@1.0.0', '--x'],
    });
    expect(() => resolveCommand({ command: 'npx', args: [] }, { node: () => null })).toThrow(
      'Node.js',
    );
    expect(() =>
      resolveCommand({ command: 'npx', args: [] }, { node: () => path.join(tempDir(), 'node') }),
    ).toThrow('npx');
  });

  it('recusa .cmd, caminhos relativos e programas que não existem', () => {
    const opts = { node: () => null };
    expect(() => resolveCommand({ command: 'x.cmd', args: [] }, opts)).toThrow(
      process.platform === 'win32' ? 'shell' : 'Não encontro',
    );
    expect(() => resolveCommand({ command: './x', args: [] }, opts)).toThrow('caminho absoluto');
    expect(() =>
      resolveCommand(
        { command: 'programa-que-nao-existe', args: [] },
        { ...opts, pathEnv: tempDir() },
      ),
    ).toThrow('Não encontro');
    expect(resolveCommand({ command: process.execPath, args: ['a'] }, opts)).toEqual({
      command: process.execPath,
      args: ['a'],
    });
  });
});

// ---------------------------------------------------------------------------------------------
// A sonda a sério, contra um servidor MCP falso por stdio

const FAKE = path.join(import.meta.dirname, 'fakes', 'tools-mcp.mjs');

describe('sonda', () => {
  it('lê as ferramentas, junta as páginas e dá o mesmo hash à mesma lista', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'tools.json');
    const tools = [
      { name: 'b', description: 'Segunda', inputSchema: { type: 'object' } },
      { name: 'a', description: 'Primeira\ncom quebra', inputSchema: { type: 'object' } },
    ];
    writeFileSync(file, JSON.stringify(tools));
    const run = (mode = '') =>
      probeMcpServer(
        {
          command: process.execPath,
          args: [FAKE],
          env: { FAKE_TOOLS_FILE: file, FAKE_MODE: mode },
        },
        { timeoutMs: 15_000 },
      );
    const plain = await run();
    expect(plain.tools.map((t) => [t.name, t.description])).toEqual([
      ['b', 'Segunda'],
      ['a', 'Primeira com quebra'],
    ]);
    expect((await run('paged')).hash).toBe(plain.hash);
    expect((await run('noisy')).hash).toBe(plain.hash);
    writeFileSync(file, JSON.stringify([...tools, { name: 'c', inputSchema: {} }]));
    expect((await run()).hash).not.toBe(plain.hash);
  }, 60_000);

  it('falha com tempo esgotado, saída com erro e lista inválida, sem deixar o segredo nos erros', async () => {
    const base = { command: process.execPath, args: [FAKE] };
    await expect(
      probeMcpServer({ ...base, env: { FAKE_MODE: 'hang' } }, { timeoutMs: 600 }),
    ).rejects.toThrow('não respondeu');
    await expect(
      probeMcpServer({ ...base, env: { FAKE_MODE: 'invalid' } }, { timeoutMs: 15_000 }),
    ).rejects.toThrow('inválida');
    const error = await probeMcpServer(
      { ...base, env: { FAKE_MODE: 'fail', FAKE_SECRET: SECRET } },
      { timeoutMs: 15_000, secrets: [SECRET] },
    ).then(
      () => new Error('devia falhar'),
      (e: unknown) => e as Error,
    );
    expect(error.message).toContain('terminou antes');
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain('***');
  }, 60_000);

  it('o servidor corre só com o ambiente mínimo e as variáveis dele, nunca com as chaves dos agentes', async () => {
    process.env.ANTHROPIC_API_KEY = 'chave-do-agente-xyz';
    process.env.OPENAI_API_KEY = 'chave-openai-xyz';
    try {
      const dir = tempDir();
      const dump = path.join(dir, 'env.json');
      const script = path.join(dir, 'dump-env.mjs');
      writeFileSync(
        script,
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));
let b='';process.stdin.on('data',(c)=>{b+=c;for(let i=b.indexOf('\\n');i!==-1;i=b.indexOf('\\n')){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);
if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'x',version:'1'}}})+'\\n');
if(m.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[]}})+'\\n');}});`,
      );
      await probeMcpServer(
        { command: process.execPath, args: [script], env: { MINHA_VAR: 'valor' } },
        { timeoutMs: 15_000 },
      );
      const seen = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
      expect(seen.MINHA_VAR).toBe('valor');
      expect(JSON.stringify(seen)).not.toContain('chave-do-agente-xyz');
      expect(JSON.stringify(seen)).not.toContain('chave-openai-xyz');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// A ligação do motor ao main para os segredos

describe('ligação ao cofre do main', () => {
  it('pede os valores por nome e recebe-os pela resposta', async () => {
    const sent: HostRequest[] = [];
    const link = new HostLink((request) => sent.push(request));
    const pending = link.secrets.read('srv1', ['API_TOKEN', 'OUTRO']);
    expect(HostRequest.safeParse(sent[0]).success).toBe(true);
    expect(sent[0]).toMatchObject({
      op: 'mcp.secrets',
      serverId: 'srv1',
      names: ['API_TOKEN', 'OUTRO'],
    });
    expect(
      link.handle({
        kind: 'host-response',
        id: sent[0]!.id,
        ok: true,
        values: { API_TOKEN: SECRET, OUTRO: null },
      }),
    ).toBe(true);
    expect(await pending).toEqual({ API_TOKEN: SECRET, OUTRO: null });
    // Sem nomes não há pedido.
    expect(await link.secrets.read('srv1', [])).toEqual({});
    expect(sent).toHaveLength(1);
  });

  it('erros do main chegam como erros, respostas estranhas são ignoradas e não são pedidos do motor', async () => {
    const sent: HostRequest[] = [];
    const link = new HostLink((request) => sent.push(request), 50);
    const failed = link.secrets.read('srv1', ['A']);
    link.handle({
      kind: 'host-response',
      id: sent[0]!.id,
      ok: false,
      error: { message: 'sem cofre' },
    });
    await expect(failed).rejects.toThrow('sem cofre');
    expect(link.handle({ kind: 'request', id: 'x', command: 'engine.ping', payload: {} })).toBe(
      false,
    );
    expect(link.handle({ kind: 'host-response', id: 'desconhecido', ok: true, values: {} })).toBe(
      true,
    );
    await expect(link.secrets.read('srv1', ['A'])).rejects.toThrow('a tempo');
  });

  it('o pedido só aceita nomes de variáveis e ids de servidores válidos', () => {
    const ok = {
      kind: 'host-request',
      id: '1',
      op: 'mcp.secrets',
      serverId: 'abc',
      names: ['A_B'],
    };
    expect(HostRequest.safeParse(ok).success).toBe(true);
    expect(HostRequest.safeParse({ ...ok, serverId: '../x' }).success).toBe(false);
    expect(HostRequest.safeParse({ ...ok, names: ['a b'] }).success).toBe(false);
    expect(HostRequest.safeParse({ ...ok, op: 'fs.read' }).success).toBe(false);
  });
});
