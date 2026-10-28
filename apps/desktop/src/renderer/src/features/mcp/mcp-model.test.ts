import { describe, expect, it } from 'vitest';
import type { McpCatalogServer, McpRegistryResult } from '@solline/protocol';
import {
  alreadyAdded,
  atLimit,
  buildManual,
  changeLines,
  emptyManual,
  filledValues,
  needsApproval,
  parseArgs,
  projectSelection,
  skippedLine,
  sourceInfo,
  statusInfo,
  toggleSelection,
  verifiedLabel,
} from './mcp-model.ts';

const server = (over: Partial<McpCatalogServer> = {}): McpCatalogServer => ({
  id: 's1',
  name: 's1',
  spec: {
    label: 'Servidor',
    command: 'node',
    args: [],
    env: [],
    source: { kind: 'manual' },
  },
  commandLine: 'node',
  fingerprint: '0'.repeat(64),
  status: 'ready',
  approved: true,
  tools: [],
  toolsHash: '1'.repeat(64),
  probedAt: 1,
  changed: null,
  error: null,
  createdAt: 1,
  ...over,
});

describe('estado de um servidor', () => {
  it('diz o que falta fazer', () => {
    expect(statusInfo(server()).label).toBe('Pronto');
    expect(statusInfo(server({ status: 'needs-approval', approved: false })).label).toBe(
      'Por aprovar',
    );
    const changed = statusInfo(server({ status: 'changed' }));
    expect(changed.label).toBe('Precisa de nova aprovação');
    expect(changed.hint).toContain('mudaram');
    expect(statusInfo(server({ status: 'error', error: 'falhou' })).hint).toBe('falhou');
    expect(needsApproval(server())).toBe(false);
    expect(needsApproval(server({ status: 'changed' }))).toBe(true);
    expect(needsApproval(server({ approved: false, status: 'needs-approval' }))).toBe(true);
  });

  it('mostra a origem e quem verificou o dono', () => {
    expect(sourceInfo({ kind: 'manual' })).toMatchObject({ title: 'Acrescentado à mão' });
    const info = sourceInfo({
      kind: 'registry',
      name: 'io.github.a/b',
      version: '1.2.3',
      registryType: 'npm',
      identifier: '@a/b',
      verified: 'github',
    });
    expect(info).toMatchObject({
      title: 'io.github.a/b',
      version: '1.2.3',
      verified: 'Dono verificado pelo GitHub',
    });
    expect(verifiedLabel('dns')).toBe('Dono verificado por DNS');
    expect(verifiedLabel(null)).toBe('Dono não verificado');
  });

  it('lista só os grupos de ferramentas que mudaram', () => {
    expect(
      changeLines({ added: ['a'], removed: [], altered: ['b', 'c'], hash: '0'.repeat(64) }),
    ).toEqual([
      { label: 'Novas', names: ['a'] },
      { label: 'Alteradas', names: ['b', 'c'] },
    ]);
  });
});

describe('formulário à mão', () => {
  it('um argumento por linha', () => {
    expect(parseArgs('-y\n  pacote@1.0.0 \n\n')).toEqual(['-y', 'pacote@1.0.0']);
  });

  it('não reclama enquanto faltam o nome e o comando', () => {
    expect(buildManual(emptyManual)).toEqual({ ok: false, error: null });
    expect(buildManual({ ...emptyManual, label: 'x' })).toEqual({ ok: false, error: null });
  });

  it('valida como o protocolo e separa os valores', () => {
    const base = { ...emptyManual, label: 'Local', command: 'node', args: 'a.js\n--x' };
    const ok = buildManual({
      ...base,
      env: [
        { name: 'TOKEN', secret: true, required: true, value: 'abc' },
        { name: 'REGIAO', secret: false, required: false, value: '' },
      ],
    });
    expect(ok).toMatchObject({
      ok: true,
      spec: { command: 'node', args: ['a.js', '--x'] },
      values: { TOKEN: 'abc' },
    });
    // A spec nunca leva valores.
    expect(JSON.stringify((ok as { spec: unknown }).spec)).not.toContain('abc');
    const reserved = buildManual({
      ...base,
      env: [{ name: 'PATH', secret: false, required: false, value: 'x' }],
    });
    expect(reserved).toMatchObject({ ok: false });
    expect((reserved as { error: string }).error).toContain('não se declara');
    expect(
      buildManual({ ...base, env: [{ name: 'TOKEN', secret: true, required: true, value: '' }] }),
    ).toEqual({ ok: false, error: 'Falta o valor de TOKEN.' });
    expect(buildManual({ ...base, command: '-x' })).toMatchObject({ ok: false });
  });

  it('os valores do registo: só os preenchidos, e diz a obrigatória em falta', () => {
    const rows = [
      { name: 'A', secret: true, required: true, value: '' },
      { name: 'B', secret: false, required: false, value: 'v' },
    ];
    expect(filledValues(rows)).toEqual({ values: { B: 'v' }, missing: 'A' });
    const filled = [{ name: 'A', secret: true, required: true, value: 'x' }, ...rows.slice(1)];
    expect(filledValues(filled).missing).toBeNull();
  });

  it('um servidor do registo já acrescentado reconhece-se pelo nome', () => {
    const result = { name: 'io.github.a/b' } as McpRegistryResult;
    const added = server({
      spec: {
        ...server().spec,
        source: {
          kind: 'registry',
          name: 'io.github.a/b',
          version: '1.0.0',
          registryType: 'npm',
          identifier: 'x',
          verified: null,
        },
      },
    });
    expect(alreadyAdded([server(), added], result)).toBe(added);
    expect(alreadyAdded([server()], result)).toBeUndefined();
  });
});

describe('escolha por projeto', () => {
  it('liga e desliga até 8, e ignora o que já saiu do catálogo', () => {
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
    const full = ['1', '2', '3', '4', '5', '6', '7', '8'];
    expect(atLimit(full)).toBe(true);
    expect(toggleSelection(full, '9')).toEqual(full);
    expect(toggleSelection(full, '8')).toHaveLength(7);
    expect(projectSelection({ p: ['s1', 'fantasma'] }, 'p', [server()])).toEqual(['s1']);
    expect(projectSelection({}, 'p', [server()])).toEqual([]);
  });
});

describe('servidores de fora de uma sessão', () => {
  it('uma frase com a razão de cada um', () => {
    const label = (id: string) => (id === 'a' ? 'Docs' : id);
    expect(skippedLine([{ id: 'a', reason: 'needs-approval' }], label)).toBe(
      '1 servidor MCP do projeto ficou de fora: Docs (precisa de aprovação).',
    );
    expect(
      skippedLine(
        [
          { id: 'a', reason: 'restricted-mode' },
          { id: 'b', reason: 'limit' },
        ],
        label,
      ),
    ).toBe(
      '2 servidores MCP do projeto ficaram de fora: Docs (este modo não deixa correr programas externos), b (passa do limite de 8 servidores).',
    );
  });
});
