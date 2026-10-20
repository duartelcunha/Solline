import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcpAdapter,
  ClaudeSdkAdapter,
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
import { fakeAcp } from './fakes/acp-transport.ts';
import {
  fakeQuery,
  loadFixture,
  messagesOf,
  recordingSink,
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
    expect(fakes[0]!.options().mcpServers).toEqual({
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

  it('o Codex ainda não aceita servidores MCP por sessão; um id desconhecido falha', async () => {
    const m = manager([]);
    await expect(m.create({ ...base, agent: 'codex', mcpServerIds: ['docs'] })).rejects.toThrow(
      'ainda não aceita',
    );
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
