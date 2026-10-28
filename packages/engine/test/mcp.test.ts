import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcpAdapter,
  ClaudeSdkAdapter,
  CodexAppServerAdapter,
  MCP_CATALOG,
  SessionManager,
  claudeDefinition,
  codexDefinition,
  fixedMcpCatalog,
  mcpCatalog,
  registryOf,
  withFactories,
  type McpLaunch,
} from '../src/index.ts';
import { fakeCodexServer } from './codex-fakes.ts';
import { fakeAcp } from './fakes/acp-transport.ts';
import {
  fakeQuery,
  loadFixture,
  messagesOf,
  recordingSink,
  waitFor,
  type FixtureRecord,
} from './helpers.ts';

const RUNNER: McpLaunch = {
  id: 'runner',
  name: 'runner',
  command: 'C:/node/node.exe',
  args: ['runner.mjs'],
  env: { RUNNER_MODE: 'safe' },
  executesCode: true,
};
const DOCS: McpLaunch = { ...RUNNER, id: 'docs', name: 'docs', executesCode: false };

function manager(fakes: ReturnType<typeof fakeQuery>[], records = loadFixture('plain-answer')) {
  return new SessionManager({
    emit: () => undefined,
    mcp: fixedMcpCatalog([RUNNER, DOCS]),
    registry: withFactories(registryOf([claudeDefinition({ isolated: true }), codexDefinition()]), {
      claude: (options, sink) => {
        const fake = fakeQuery(records);
        fakes.push(fake);
        return new ClaudeSdkAdapter(
          { ...options, queryFn: fake.queryFn, loadSettings: false },
          sink,
        );
      },
    }),
  });
}

const base = { projectId: 'p', agent: 'claude', cwd: tmpdir(), trusted: true };

describe('servidores MCP por sessão', () => {
  it('chegam ao Claude em options.mcpServers, só nesta sessão', async () => {
    const fakes: ReturnType<typeof fakeQuery>[] = [];
    const m = manager(fakes);
    const { session } = await m.create({ ...base, mcpServerIds: ['docs'] });
    expect(session.mcpServers).toEqual(['docs']);
    expect(fakes[0]!.options().mcpServers).toMatchObject({
      docs: {
        type: 'stdio',
        command: 'C:/node/node.exe',
        args: ['runner.mjs'],
        env: { RUNNER_MODE: 'safe' },
      },
    });
    await m.create(base);
    expect(fakes[1]!.options().mcpServers).toBeUndefined();
    await m.disposeAll();
  });

  it('uma consulta só de leitura tira ao Claude as ferramentas que escrevem (as regras "allow" não chegam ao canUseTool)', async () => {
    const fakes: ReturnType<typeof fakeQuery>[] = [];
    const m = manager(fakes);
    const { session: parent } = await m.create(base);
    await m.create({
      ...base,
      mode: 'plan',
      origin: { kind: 'ask', sessionId: parent.id },
    });
    expect(fakes[1]!.rawOptions().disallowedTools).toEqual(
      expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']),
    );
    expect(fakes[0]!.rawOptions().disallowedTools).toBeUndefined();
    await m.disposeAll();
  });

  it('os segredos do agente chegam vazios ao servidor MCP', async () => {
    process.env.SOLLINE_TESTE_API_KEY = 'segredo';
    try {
      const fakes: ReturnType<typeof fakeQuery>[] = [];
      const m = manager(fakes);
      await m.create({ ...base, mcpServerIds: ['docs'] });
      const servers = fakes[0]!.options().mcpServers as Record<
        string,
        { env: Record<string, string> }
      >;
      expect(servers.docs!.env.SOLLINE_TESTE_API_KEY).toBe('');
      expect(servers.docs!.env.RUNNER_MODE).toBe('safe');
      await m.disposeAll();
    } finally {
      delete process.env.SOLLINE_TESTE_API_KEY;
    }
  });

  it('um servidor que corre programas tira o Auto e não deixa arrancar nele', async () => {
    const fakes: ReturnType<typeof fakeQuery>[] = [];
    const m = manager(fakes);
    await expect(m.create({ ...base, mode: 'auto', mcpServerIds: ['runner'] })).rejects.toThrow(
      'modo que pergunte',
    );
    const { session, capabilities } = await m.create({ ...base, mcpServerIds: ['runner'] });
    expect(capabilities.modes.map((mo) => mo.id)).not.toContain('auto');
    await expect(m.setMode(session.id, 'auto')).rejects.toThrow('Modo desconhecido');
    await m.disposeAll();
  });

  it('as ferramentas de um servidor que corre programas nunca têm "Permitir sempre"', async () => {
    const plain = messagesOf(loadFixture('plain-answer'));
    const records: FixtureRecord[] = [
      {
        kind: 'canUseTool',
        toolName: 'mcp__runner__run',
        input: { target: 'app.exe' },
        options: {
          toolUseID: 't1',
          requestId: 'r1',
          suggestions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }],
        },
      },
      ...plain.map((message) => ({ kind: 'message' as const, message })),
    ];
    const fake = fakeQuery(records);
    const sink = recordingSink();
    const adapter = new ClaudeSdkAdapter(
      {
        cwd: 'C:/p',
        mode: 'default',
        queryFn: fake.queryFn,
        loadSettings: false,
        mcpServers: [{ name: 'runner', command: 'x', args: [], env: {}, executesCode: true }],
      },
      sink,
    );
    await adapter.start();
    const asked = sink.nextAsk();
    await adapter.send('corre');
    expect(await asked).toMatchObject({ kind: 'permission', canAlwaysAllow: false });
    await adapter.close();
  });

  it('um id desconhecido falha', async () => {
    const m = manager([]);
    await expect(m.create({ ...base, mcpServerIds: ['nao-existe'] })).rejects.toThrow(
      'desconhecido',
    );
  });

  it('chegam a um agente ACP no session/new, com o env como lista', async () => {
    const fake = fakeAcp();
    const adapter = new AcpAdapter(
      {
        cwd: 'C:/p',
        mode: null,
        label: 'ACP',
        transport: fake.transport,
        mcpServers: [
          {
            name: 'docs',
            command: 'C:/node/node.exe',
            args: ['d.mjs'],
            env: { A: '1' },
            executesCode: false,
          },
        ],
      },
      recordingSink(),
    );
    await adapter.start();
    expect(fake.received.find((m) => m.method === 'session/new')?.params).toEqual({
      cwd: 'C:/p',
      mcpServers: [
        {
          name: 'docs',
          command: 'C:/node/node.exe',
          args: ['d.mjs'],
          env: [{ name: 'A', value: '1' }],
        },
      ],
    });
    await adapter.close();
  });
});

describe('catálogo MCP', () => {
  it('o REA só fica pronto instalado na pasta da app, na versão revista e com Node no PATH', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'solline-mcp-'));
    try {
      const node = () => 'C:/node/node.exe';
      expect((await mcpCatalog({ dataDir, node }).list())[0]).toMatchObject({
        id: 'rea',
        status: 'not-found',
        executesCode: true,
        detail: expect.stringContaining('--ignore-scripts rea-agents@6.7.0'),
      });
      const root = path.join(dataDir, 'mcp', 'rea', 'node_modules', 'rea-agents');
      await mkdir(path.join(root, 'scripts'), { recursive: true });
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '6.8.0' }));
      expect((await mcpCatalog({ dataDir, node }).list())[0]).toMatchObject({
        status: 'unreviewed',
      });
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ version: MCP_CATALOG[0]!.reviewedVersion }),
      );
      expect((await mcpCatalog({ dataDir, node: () => null }).list())[0]).toMatchObject({
        status: 'not-found',
        detail: 'Falta o Node.js no PATH',
      });
      const catalog = mcpCatalog({ dataDir, node });
      expect((await catalog.list())[0]).toMatchObject({ status: 'ready' });
      expect(await catalog.launch('rea')).toEqual({
        id: 'rea',
        name: 'rea',
        command: 'C:/node/node.exe',
        args: [path.join(root, 'scripts', 'rea.mjs'), 'mcp'],
        env: {},
        executesCode: true,
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('servidores MCP por sessão no Codex', () => {
  function codexManager(server = fakeCodexServer()) {
    const m = new SessionManager({
      emit: () => undefined,
      mcp: fixedMcpCatalog([RUNNER, DOCS]),
      registry: withFactories(registryOf([codexDefinition()]), {
        codex: (options, sink) =>
          new CodexAppServerAdapter({ ...options, transport: server.transport }, sink),
      }),
    });
    return { m, server };
  }
  const codex = { ...base, agent: 'codex' };
  const toolApproval = (server: string, persist: unknown = ['session', 'always']) => ({
    threadId: 'thread-1',
    turnId: null,
    serverName: server,
    mode: 'form',
    message: 'Allow the MCP server to run tool "exec"?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist,
      tool_name: 'exec',
      tool_title: 'Executar',
      tool_params: { cmd: 'dir' },
    },
  });

  it('vão na config do thread (nunca no config.toml), com todas as ferramentas a pedir', async () => {
    const { m, server } = codexManager();
    const { session } = await m.create({ ...codex, mcpServerIds: ['docs'] });
    expect(session.mcpServers).toEqual(['docs']);
    const start = server.received.find((msg) => msg.method === 'thread/start');
    const config = (start?.params as { config?: Record<string, unknown> }).config;
    expect(config).toEqual({
      'mcp_servers.docs': {
        command: 'C:/node/node.exe',
        args: ['runner.mjs'],
        env: expect.objectContaining({ RUNNER_MODE: 'safe' }),
        startup_timeout_sec: 30,
        default_tools_approval_mode: 'prompt',
      },
    });
    // Os segredos que o Codex recebe (a chave da OpenAI) vão vazios para o servidor.
    const env = (config!['mcp_servers.docs'] as { env: Record<string, string> }).env;
    for (const [key, value] of Object.entries(env)) {
      if (key !== 'RUNNER_MODE') expect(value).toBe('');
    }
    await m.disposeAll();
  });

  it('sem servidores, o thread/start não leva config', async () => {
    const { m, server } = codexManager();
    await m.create(codex);
    const start = server.received.find((msg) => msg.method === 'thread/start');
    expect(start?.params).not.toHaveProperty('config');
    await m.disposeAll();
  });

  it('um servidor que corre programas tira o Auto ao Codex', async () => {
    const { m } = codexManager();
    await expect(m.create({ ...codex, mode: 'auto', mcpServerIds: ['runner'] })).rejects.toThrow(
      'pergunte antes',
    );
    const { capabilities } = await m.create({ ...codex, mcpServerIds: ['runner'] });
    expect(capabilities.modes.map((mode) => mode.id)).not.toContain('auto');
    await m.disposeAll();
  });

  function adapter(mcpServers: McpLaunch[]) {
    const server = fakeCodexServer();
    const sink = recordingSink();
    const a = new CodexAppServerAdapter(
      { cwd: 'C:/p', mode: 'ask', transport: server.transport, mcpServers },
      sink,
    );
    return { a, sink, server };
  }

  it('o pedido de uma ferramenta MCP vira cartão; "sempre" fica na sessão', async () => {
    const { a, sink, server } = adapter([DOCS]);
    await a.start();
    const asked = sink.nextAsk();
    const reply = server.request('mcpServer/elicitation/request', toolApproval('docs'));
    const block = await asked;
    expect(block).toMatchObject({
      kind: 'permission',
      toolName: 'mcp__docs__exec',
      title: 'docs: Executar',
      input: { cmd: 'dir' },
      canAlwaysAllow: true,
      alwaysScope: 'session',
    });
    a.answerPermission(block.id, { decision: 'allow-always' });
    expect((await reply).result).toEqual({
      action: 'accept',
      content: {},
      _meta: { persist: 'session' },
    });
    await a.close();
  });

  it('um servidor que corre programas nunca tem "Permitir sempre"; negar recusa', async () => {
    const { a, sink, server } = adapter([RUNNER]);
    await a.start();
    const asked = sink.nextAsk();
    const reply = server.request('mcpServer/elicitation/request', toolApproval('runner'));
    const block = await asked;
    expect(block).toMatchObject({ canAlwaysAllow: false });
    expect(() => a.answerPermission(block.id, { decision: 'allow-always' })).toThrow();
    a.answerPermission(block.id, { decision: 'deny' });
    expect((await reply).result).toEqual({ action: 'decline', content: null, _meta: null });
    await a.close();
  });

  it('sem persist de sessão, só se permite uma vez', async () => {
    const { a, sink, server } = adapter([DOCS]);
    await a.start();
    const asked = sink.nextAsk();
    const reply = server.request('mcpServer/elicitation/request', toolApproval('docs', 'always'));
    const block = await asked;
    expect(block).toMatchObject({ canAlwaysAllow: false });
    a.answerPermission(block.id, { decision: 'allow-once' });
    expect((await reply).result).toEqual({ action: 'accept', content: {}, _meta: null });
    await a.close();
  });

  it('outras elicitações continuam recusadas com um aviso', async () => {
    const { a, sink, server } = adapter([DOCS]);
    await a.start();
    const reply = await server.request('mcpServer/elicitation/request', {
      threadId: 'thread-1',
      turnId: null,
      serverName: 'docs',
      mode: 'url',
      _meta: null,
      message: 'Entra',
      url: 'https://example.com',
      elicitationId: 'e1',
    });
    expect(reply.result).toEqual({ action: 'decline', content: null, _meta: null });
    await waitFor(() =>
      sink.deltas.some(
        (d) =>
          d.type === 'block.upsert' && d.block.kind === 'notice' && /recusado/.test(d.block.text),
      ),
    );
    await a.close();
  });

  it('um nome que partia a chave da config não arranca', async () => {
    const { a } = adapter([{ ...DOCS, name: 'a.b' }]);
    await expect(a.start()).rejects.toThrow('inválido');
  });
});
