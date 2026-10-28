import {
  RulesState,
  SpaceMemory,
  type ConsultRequest,
  type McpCatalogServer,
  type McpRegistryResult,
  type McpServerSpec,
} from '@solline/protocol';

/** Dados sintéticos do «um só cérebro» (regras, memórias, MCP, consultas) para os cenários de QA. */

const at = 1792663200000;
const hex = (digit: string) => digit.repeat(64);

export const cerebroMemories = (projectId: string, sessionId: string): SpaceMemory[] => [
  SpaceMemory.parse({
    id: 'mem-utc',
    projectId,
    text: 'Os testes de integração precisam da base em UTC; sem isso falham à meia-noite.',
    source: 'Claude · proposta de memória',
    sourceId: null,
    state: 'pending',
    createdAt: at + 3000,
    reason: 'Dois testes falharam por isto na integração contínua esta semana.',
    citations: [
      { path: 'packages/db/test/setup.ts', line: 12, endLine: 20 },
      { commit: 'a1b2c3d4e5f6' },
    ],
    origin: { agent: 'claude', sessionId, turnId: 'user-1', projectId },
  }),
  SpaceMemory.parse({
    id: 'mem-dlx',
    projectId,
    text: 'Neste repositório usa `pnpm dlx` em vez de `npx` para correr ferramentas pontuais.',
    source: 'Codex · proposta de memória',
    sourceId: null,
    state: 'pending',
    createdAt: at + 2000,
    reason: 'A documentação das ferramentas pede-o.',
    citations: [{ path: 'docs/ferramentas.md' }],
    origin: { agent: 'codex', sessionId, turnId: 'user-1', projectId },
    external: true,
  }),
  SpaceMemory.parse({
    id: 'mem-nav',
    projectId,
    text: 'O processo principal nunca importa nada do renderer.',
    source: 'Claude · proposta de memória',
    sourceId: null,
    state: 'pending',
    createdAt: at + 1000,
    reason: 'Quebra o isolamento do contexto e já aconteceu uma vez.',
    citations: [{ path: 'apps/desktop/src/main/index.ts', line: 40 }],
    origin: { agent: 'claude', sessionId: 'sessao-fechada', projectId },
  }),
  SpaceMemory.parse({
    id: 'mem-ramos',
    projectId,
    text: 'Os nomes dos ramos seguem feat/<issue>-<tema>.',
    source: 'Claude · proposta de memória',
    sourceId: null,
    state: 'toConfirm',
    createdAt: at,
    reason: 'Regra de equipa.',
    citations: [{ path: 'CONTRIBUTING.md', line: 8, endLine: 12 }],
    origin: { agent: 'claude', sessionId, projectId },
    stale: 'evidence',
    approvedAt: at,
  }),
  SpaceMemory.parse({
    id: 'mem-calma',
    projectId,
    text: 'Interfaces calmas: uma decisão de cada vez.',
    source: 'Duarte · memória escrita no espaço',
    sourceId: null,
    state: 'active',
    createdAt: at - 1000,
  }),
];

export function cerebroRules(projectId: string): RulesState {
  const rule = (id: string, title: string, text: string, globs: string[] = [], enabled = true) => ({
    id,
    projectId,
    title,
    text,
    globs,
    enabled,
    createdAt: at,
    updatedAt: at,
  });
  return RulesState.parse({
    version: 1,
    revision: 1,
    projects: {
      [projectId]: {
        rules: [
          rule(
            'rule-commits',
            'Mensagens de commit',
            'Commits em português europeu, no formato Conventional Commits.\nUma linha de assunto com menos de 72 caracteres.',
          ),
          rule(
            'rule-testes',
            'Testes antes de dar por feito',
            'Corre os testes do pacote que mexeste e diz o resultado.',
          ),
          rule(
            'rule-migracoes',
            'Migrações da base de dados',
            'Cada migração é reversível e traz um teste.',
            ['src/db/**', '*.sql'],
          ),
          rule(
            'rule-ingles',
            'Comentários em inglês',
            'Os comentários do código ficam em inglês.',
            [],
            false,
          ),
        ],
        importedFrom: ['CLAUDE.md'],
        warnings: [
          {
            kind: 'native',
            text: 'Importaste regras de CLAUDE.md. Se o ficheiro continuar na pasta, o agente pode ver as regras duas vezes.',
          },
        ],
      },
    },
  });
}

const spec = (
  label: string,
  command: string,
  args: string[],
  env: McpServerSpec['env'],
  source: McpServerSpec['source'],
): McpServerSpec => ({ label, command, args, env, source });

export function cerebroServers(): McpCatalogServer[] {
  const tools = [
    { name: 'search_docs', description: 'Procura nas páginas da documentação.' },
    { name: 'read_page', description: 'Devolve o texto de uma página da documentação.' },
    { name: 'list_sections', description: 'Lista as secções de um manual.' },
  ];
  return [
    {
      id: 'docs',
      name: 'docs',
      spec: spec('Documentação', 'npx', ['-y', '@acme/docs-mcp@1.4.2'], [], {
        kind: 'registry',
        name: 'io.github.acme/docs-mcp',
        version: '1.4.2',
        registryType: 'npm',
        identifier: '@acme/docs-mcp',
        verified: 'github',
      }),
      commandLine: 'npx -y @acme/docs-mcp@1.4.2',
      fingerprint: hex('a'),
      status: 'ready',
      approved: true,
      tools,
      toolsHash: hex('b'),
      probedAt: at,
      changed: null,
      error: null,
      createdAt: at,
    },
    {
      id: 'ledger',
      name: 'ledger',
      spec: spec(
        'Livro de contas',
        'uvx',
        ['ledger-mcp==0.9.1'],
        [{ name: 'LEDGER_TOKEN', secret: true, required: true, description: 'Chave de leitura' }],
        {
          kind: 'registry',
          name: 'com.exemplo/ledger',
          version: '0.9.1',
          registryType: 'pypi',
          identifier: 'ledger-mcp',
          verified: 'dns',
        },
      ),
      commandLine: 'uvx ledger-mcp==0.9.1',
      fingerprint: hex('c'),
      status: 'changed',
      approved: true,
      tools: [{ name: 'query', description: 'Corre uma consulta só de leitura.' }],
      toolsHash: hex('d'),
      probedAt: at,
      changed: { added: ['export_csv'], removed: [], altered: ['query'], hash: hex('e') },
      error: null,
      createdAt: at,
    },
    {
      id: 'notas',
      name: 'notas',
      spec: spec(
        'Notas locais',
        'node',
        ['C:/ferramentas/notas-mcp/index.js'],
        [
          { name: 'NOTAS_TOKEN', secret: true, required: true },
          { name: 'NOTAS_REGIAO', secret: false, required: false, value: 'eu' },
        ],
        { kind: 'manual' },
      ),
      commandLine: 'node C:/ferramentas/notas-mcp/index.js',
      fingerprint: hex('f'),
      status: 'needs-approval',
      approved: false,
      tools: null,
      toolsHash: null,
      probedAt: null,
      changed: null,
      error: null,
      createdAt: at,
    },
    {
      id: 'quebrado',
      name: 'quebrado',
      spec: spec('Servidor de teste', 'node', ['servidor.js'], [], { kind: 'manual' }),
      commandLine: 'node servidor.js',
      fingerprint: hex('1'),
      status: 'error',
      approved: true,
      tools: null,
      toolsHash: null,
      probedAt: at,
      changed: null,
      error: 'O servidor fechou antes de responder (código 1).',
      createdAt: at,
    },
  ];
}

export const cerebroRegistry: McpRegistryResult[] = [
  {
    name: 'io.github.acme/docs-mcp',
    title: 'Documentação Acme',
    description: 'Pesquisa e leitura da documentação pública da Acme.',
    version: '1.4.2',
    namespace: 'io.github.acme',
    verified: 'github',
    repository: 'https://github.com/acme/docs-mcp',
    registryType: 'npm',
    identifier: '@acme/docs-mcp',
    packageVersion: '1.4.2',
    commandLine: 'npx -y @acme/docs-mcp@1.4.2',
    env: [],
  },
  {
    name: 'com.exemplo/relatorios',
    title: 'Relatórios',
    description: 'Gera relatórios a partir de uma conta Exemplo.',
    version: '2.0.0',
    namespace: 'com.exemplo',
    verified: 'dns',
    repository: null,
    registryType: 'pypi',
    identifier: 'exemplo-relatorios',
    packageVersion: '2.0.0',
    commandLine: 'uvx exemplo-relatorios==2.0.0',
    env: [
      { name: 'REL_API_KEY', secret: true, required: true, description: 'Chave da conta' },
      { name: 'REL_REGIAO', secret: false, required: false },
    ],
  },
  {
    name: 'dev.anonimo/utilitarios',
    title: 'Utilitários',
    description: 'Pequenas ferramentas de texto.',
    version: '0.3.0',
    namespace: 'dev.anonimo',
    verified: null,
    repository: null,
    registryType: 'npm',
    identifier: 'anonimo-utilitarios',
    packageVersion: '0.3.0',
    commandLine: 'npx -y anonimo-utilitarios@0.3.0',
    env: [],
  },
];

/** Um pedido de consulta ou delegação como o motor o escreve. */
export function consultRequest(
  kind: 'ask' | 'delegate',
  sessionId: string,
  over: Partial<ConsultRequest> = {},
): ConsultRequest {
  return kind === 'ask'
    ? {
        id: 'consult-1',
        kind: 'ask',
        sessionId,
        from: 'claude',
        to: 'codex',
        summary: 'O Claude quer perguntar ao Codex',
        text: 'Onde é que o parser de configuração valida os caminhos relativos? Preciso de saber se aceita `..` antes de mexer na migração.',
        context:
          'Estou a mudar a leitura de packages/engine/src/config.ts. A migração atual assume caminhos já normalizados.',
        sameVendor: false,
        createdAt: at,
        ...over,
      }
    : {
        id: 'consult-2',
        kind: 'delegate',
        sessionId,
        from: 'claude',
        to: 'codex',
        summary: 'O Claude quer delegar uma tarefa no Codex',
        text: 'Escreve os testes do parser de configuração para caminhos com `..` e com ligações simbólicas. Não mexas no código de produção.',
        title: 'Testes do parser de configuração',
        mode: { id: 'workspace-write', label: 'Editar ficheiros' },
        createdAt: at,
        ...over,
      };
}

export const cerebro = { memories: cerebroMemories, rules: cerebroRules, servers: cerebroServers };
