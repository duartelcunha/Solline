import type {
  AgentCapabilities,
  AgentDescriptor,
  Block,
  FileDiff,
  Project,
  Quality,
  QuestionBlock,
  Timeline,
} from '@solline/protocol';

export const project: Project = {
  id: 'atelier',
  name: 'Atelier',
  path: 'C:/qa/atelier',
  trusted: true,
  addedAt: 1792663200000,
};
export const capabilities: AgentCapabilities = {
  models: [
    {
      id: 'sonnet',
      resolved: null,
      label: 'Sonnet',
      description: 'Equilíbrio e precisão',
      efforts: ['low', 'medium', 'high'],
    },
    {
      id: 'opus',
      resolved: null,
      label: 'Opus',
      description: 'Trabalho exigente',
      efforts: ['low', 'medium', 'high'],
    },
  ],
  modes: [
    { id: 'default', label: 'Perguntar', description: 'Pedir antes de alterar', risk: 'ask' },
    { id: 'plan', label: 'Planear', description: 'Só leitura', risk: 'plan' },
  ],
  effort: true,
  effortOrder: ['low', 'medium', 'high'],
  features: { cost: true, context: true, resume: true, rewind: true, steer: true },
};
export const agents: AgentDescriptor[] = [
  {
    id: 'claude',
    label: 'Claude',
    transport: 'claude-sdk',
    status: 'ready',
    experimental: false,
    untrustedProjects: 'allowed',
    mcp: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    transport: 'codex-app-server',
    status: 'needs-login',
    experimental: false,
    untrustedProjects: 'refused',
    login: { label: 'Entrar com ChatGPT', pending: false },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    transport: 'acp',
    status: 'not-found',
    experimental: true,
    untrustedProjects: 'refused',
    keys: [],
    detail: 'O agente ainda não está instalado.',
  },
];
export const permission: Block = {
  kind: 'permission',
  id: 'ask-1',
  toolName: 'Edit',
  toolUseId: 'tool-1',
  title: 'Atualizar a navegação',
  description: 'Alterar src/navigation.ts para preservar a seleção ao regressar à mesa.',
  input: {
    file_path: 'src/navigation.ts',
    old_string: 'active = null',
    new_string: 'active = previous',
  },
  canAlwaysAllow: true,
  alwaysScope: 'session',
  defaultToNo: false,
  category: 'edit',
  content: [
    {
      type: 'diff',
      path: 'src/navigation.ts',
      oldText: 'active = null',
      newText: 'active = previous',
    },
  ],
  status: 'pending',
};
export const blocks: Block[] = [
  {
    kind: 'thinking',
    id: 'thinking',
    text: 'Vou manter a seleção e verificar a navegação por teclado.',
    done: true,
    parentToolId: null,
  },
  {
    kind: 'text',
    id: 'answer',
    text: 'A navegação já mantém o contexto entre sessões.\n\n### O que mudou\n\nO projeto e a seleção ficam no mesmo lugar quando regressas à mesa. Os atalhos continuam disponíveis.\n\n```ts\nconst active = previous ?? sessions[0];\n```\n\nFalta confirmar a alteração antes de correr as verificações.',
    parentToolId: null,
  },
  {
    kind: 'tool',
    id: 'read',
    name: 'Read',
    summary: 'Ler src/navigation.ts',
    input: { path: 'src/navigation.ts' },
    state: 'ok',
    output: 'export const active = null;',
    parentToolId: null,
    category: 'read',
  },
];
export const diff: FileDiff = {
  path: 'src/navigation.ts',
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 1,
  hunks: [
    {
      id: 'hunk-1',
      header: '@@ -1 +1 @@',
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [
        { kind: 'del', text: 'const active = null;', oldNo: 1, newNo: null },
        { kind: 'add', text: 'const active = previous ?? sessions[0];', oldNo: null, newNo: 1 },
      ],
    },
  ],
};
export const timeline: Timeline = {
  available: true,
  checkpoints: [
    {
      turnId: 'user-1',
      index: 0,
      title: 'Melhorar a navegação entre sessões',
      at: 1792663200000,
      state: 'done',
      stats: { files: 1, additions: 1, deletions: 1 },
    },
  ],
  pending: { files: 1, additions: 1, deletions: 1 },
  undo: null,
  conversationRewind: 'agent',
  rewoundTo: null,
};
/** Two files and independent hunks expose an over-broad renderer review command. */
export const targetedReview: FileDiff[] = [
  {
    ...structuredClone(diff),
    additions: 2,
    deletions: 2,
    hunks: [
      ...structuredClone(diff.hunks),
      {
        id: 'hunk-2',
        header: '@@ -20 +20 @@',
        oldStart: 20,
        oldLines: 1,
        newStart: 20,
        newLines: 1,
        lines: [
          { kind: 'del', text: 'const fallback = null;', oldNo: 20, newNo: null },
          { kind: 'add', text: 'const fallback = "mesa";', oldNo: null, newNo: 20 },
        ],
      },
    ],
  },
  {
    ...structuredClone(diff),
    path: 'src/shortcuts.ts',
    hunks: [
      {
        id: 'hunk-3',
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: 'del', text: 'const shortcut = "old";', oldNo: 1, newNo: null },
          { kind: 'add', text: 'const shortcut = "Escape";', oldNo: null, newNo: 1 },
        ],
      },
    ],
  },
];
export const multipleQuestions: QuestionBlock = {
  kind: 'question',
  id: 'ask-1',
  status: 'pending',
  questions: [
    {
      header: 'Organização',
      question: 'Como agrupar?',
      multiSelect: false,
      options: [
        { label: 'Por projeto', description: '' },
        { label: 'Por atividade', description: '' },
      ],
    },
    {
      header: 'Verificações',
      question: 'O que verificar?',
      multiSelect: true,
      options: [
        { label: 'Teclado', description: '' },
        { label: 'Contraste', description: '' },
        { label: 'Movimento', description: '' },
      ],
    },
  ],
};
export const qualityFindings: Quality = {
  available: true,
  enabled: true,
  review: {
    state: 'done',
    turnId: 'user-1',
    error: null,
    findings: [
      {
        id: 'finding-1',
        path: 'src/navigation.ts',
        line: 1,
        severity: 'bug',
        priority: 0,
        confidence: 0.9,
        status: 'open',
        title: 'Preservar a sessão anterior',
        detail: 'A seleção deve sobreviver a uma atualização em segundo plano.',
      },
      {
        id: 'finding-2',
        path: 'src/navigation.ts',
        line: null,
        severity: 'risk',
        priority: 1,
        confidence: 0.7,
        status: 'open',
        title: 'Validar a lista vazia',
        detail: 'Uma lista vazia deve apresentar o estado inicial.',
      },
    ],
  },
  stats: { fixed: 0, dismissed: 0, total: 2 },
};
/**
 * Uma revisão de outro fabricante (Codex a rever o Claude): 3 achados à vista e 3 dobrados
 * (um de ruído e dois com pouca confiança), com os contadores de uma sessão onde já se corrigiu
 * e dispensou.
 */
export const qualityFolded: Quality = {
  available: true,
  enabled: true,
  review: {
    state: 'done',
    turnId: 'user-1',
    error: null,
    trigger: 'turn',
    reviewer: { vendor: 'codex', model: 'gpt-5.5', sameVendor: false },
    findings: [
      {
        id: 'finding-1',
        path: 'src/navigation.ts',
        line: 1,
        severity: 'bug',
        priority: 0,
        confidence: 0.92,
        status: 'open',
        title: 'Preservar a sessão anterior',
        detail: 'A seleção deve sobreviver a uma atualização em segundo plano.',
      },
      {
        id: 'finding-2',
        path: 'src/navigation.ts',
        line: null,
        severity: 'risk',
        priority: 1,
        confidence: 0.8,
        status: 'open',
        title: 'Validar a lista vazia',
        detail: 'Uma lista vazia deve apresentar o estado inicial.',
      },
      {
        id: 'finding-3',
        path: 'src/shortcuts.ts',
        line: 12,
        severity: 'risk',
        priority: 2,
        confidence: 0.74,
        status: 'open',
        title: 'Escape fecha duas camadas',
        detail: 'Com um menu aberto dentro de um diálogo, a tecla fecha as duas.',
      },
      {
        id: 'finding-4',
        path: 'src/navigation.ts',
        line: 1,
        severity: 'slop',
        priority: 3,
        confidence: 0.9,
        status: 'open',
        title: 'Nome pouco claro para a variável previous',
        detail: 'Um nome como lastActive diz melhor o que guarda.',
      },
      {
        id: 'finding-5',
        path: 'src/navigation.ts',
        line: null,
        severity: 'risk',
        priority: 2,
        confidence: 0.45,
        status: 'open',
        title: 'Possível corrida entre dois eventos de foco',
        detail: 'Só acontece se os eventos chegarem pela ordem inversa.',
      },
      {
        id: 'finding-6',
        path: 'src/shortcuts.ts',
        line: null,
        severity: 'bug',
        priority: 1,
        confidence: 0.55,
        status: 'open',
        title: 'O atalho pode colidir com o do sistema',
        detail: 'Depende da disposição do teclado.',
      },
    ],
  },
  stats: { fixed: 3, dismissed: 1, total: 10 },
};
/** Sem achados e do mesmo fabricante: um bom resultado, com a nota de que vale menos. */
export const qualityClean: Quality = {
  available: true,
  enabled: true,
  review: {
    state: 'done',
    turnId: 'user-1',
    error: null,
    findings: [],
    trigger: 'manual',
    reviewer: { vendor: 'claude', model: 'sonnet', sameVendor: true },
  },
  stats: { fixed: 0, dismissed: 0, total: 0 },
};
export const longModelLabel =
  'Modelo de investigação para contextos extensos e decisões de navegação entre vários projetos';
export const longModeLabel =
  'Pedir autorização antes de qualquer alteração de ficheiros no projeto atual';
export const longToolOutput = Array.from(
  { length: 180 },
  (_, index) =>
    `Linha ${index + 1}: resultado completo da verificação de navegação, foco e preservação do contexto.`,
).join('\n');
export const scenes = [
  'welcome',
  'conversation',
  'permission',
  'question',
  'plan',
  'review',
  'review-targeted',
  'queue',
  'worktree-queue',
  'error',
  'long',
  'untrusted',
  'limited-agent',
  'multi-question',
  'tool-error',
  'quality-findings',
  'quality-error',
  'quality-folded',
  'quality-clean',
  'handed-off',
  'lineage',
  'unavailable-mcp',
  'long-controls',
  'long-tool',
  'cerebro',
  'rules-conflict',
  'consult-ask',
  'consult-same-vendor',
  'consult-delegate',
  'mcp-skipped',
  'issues-missing',
  'issues-empty',
  'archived',
  'celebrate',
] as const;
export type Scene = (typeof scenes)[number];
