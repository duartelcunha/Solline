import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcpAdapter,
  CATALOG,
  acpOutcome,
  catalogDefinition,
  classifyModeRisk,
  findNpmAgent,
} from '../src/index.ts';
import { fakeAcp } from './fakes/acp-transport.ts';
import { recordingSink, reduce, waitFor } from './helpers.ts';

function adapter(fake: ReturnType<typeof fakeAcp>, extra: Record<string, unknown> = {}) {
  const sink = recordingSink();
  const a = new AcpAdapter(
    {
      cwd: 'C:/p',
      mode: null,
      label: 'Falso',
      transport: fake.transport,
      loginHint: 'falso login',
      ...extra,
    },
    sink,
  );
  return { sink, adapter: a };
}

describe('AcpAdapter', () => {
  it('arranca: config options viram modelos, modos (sem acesso total) e effort', async () => {
    const fake = fakeAcp();
    const { adapter: a, sink } = adapter(fake);
    const started = await a.start();
    expect(started.capabilities.models.map((m) => m.id)).toEqual(['fast', 'smart']);
    expect(started.capabilities.modes.map((m) => [m.id, m.risk])).toEqual([
      ['ask', 'ask'],
      ['plan', 'plan'],
    ]);
    expect(started.capabilities.effortOrder).toEqual(['low', 'high']);
    expect(started.settings).toEqual({ mode: 'ask', model: 'fast', effort: 'low' });
    expect(fake.received[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false }, terminal: false },
      },
    });
    expect(fake.received.find((m) => m.method === 'session/new')?.params).toEqual({
      cwd: 'C:/p',
      mcpServers: [],
    });
    expect(sink.deltas).toContainEqual({ type: 'meta', agentSessionId: 'sess-1' });
    await a.close();
  });

  it('um agente que arranca em acesso total passa para o modo mais fechado', async () => {
    const fake = fakeAcp({ startInFullAccess: true });
    const { adapter: a } = adapter(fake);
    const started = await a.start();
    expect(started.settings.mode).toBe('plan');
    expect(
      fake.received.find((m) => m.method === 'session/set_config_option')?.params,
    ).toMatchObject({
      configId: 'mode',
      value: 'plan',
    });
    await a.close();
  });

  it('modos e modelos à moda antiga, sem o bypass', async () => {
    const fake = fakeAcp({ legacy: true });
    const { adapter: a } = adapter(fake);
    const started = await a.start();
    expect(started.capabilities.modes.map((m) => m.id)).toEqual(['ask']);
    expect(started.capabilities.models.map((m) => m.id)).toEqual(['fast']);
    await a.close();
  });

  it('versão do protocolo diferente e autenticação em falta dão erros claros', async () => {
    await expect(adapter(fakeAcp({ protocolVersion: 2 })).adapter.start()).rejects.toThrow(
      'ACP v2',
    );
    await expect(adapter(fakeAcp({ authRequired: true })).adapter.start()).rejects.toThrow(
      'iniciares sessão. Entra com: falso login',
    );
  });

  it('resposta simples: raciocínio, plano, texto em streaming, contexto e custo', async () => {
    const fake = fakeAcp();
    const { adapter: a, sink } = adapter(fake);
    await a.start();
    await a.send('o que é um monorepo?');
    await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'));
    const turn = reduce(sink.deltas)[1]!;
    expect(turn.blocks.find((b) => b.kind === 'thinking')).toMatchObject({
      text: 'A pensar no assunto.',
      done: true,
    });
    expect(turn.blocks.find((b) => b.kind === 'todo')).toMatchObject({
      entries: [{ content: 'Responder', status: 'completed', priority: 'high' }],
    });
    expect(turn.blocks.find((b) => b.kind === 'text')).toMatchObject({
      text: 'Um **monorepo** é um só repositório.',
    });
    expect(sink.deltas).toContainEqual({
      type: 'usage',
      usage: { context: { usedTokens: 1200, maxTokens: 200000, percent: 1 }, costUsd: 0.0123 },
    });
    // O primeiro custo em dólares liga o custo nas capacidades.
    expect(a.capabilities().features.cost).toBe(true);
    expect(sink.states.at(-1)?.state).toBe('idle');
    await a.close();
  });

  it('pedido de autorização: diff da ferramenta, rótulos do agente e as quatro respostas', async () => {
    const fake = fakeAcp();
    const { adapter: a, sink } = adapter(fake);
    await a.start();
    const asked = sink.nextAsk();
    await a.send('edit notes');
    const block = await asked;
    expect(block).toMatchObject({
      kind: 'permission',
      title: 'Editar notes.txt',
      category: 'edit',
      canAlwaysAllow: true,
      canAlwaysDeny: true,
      allowAlwaysLabel: 'Permitir sempre neste projeto',
      denyAlwaysLabel: 'Recusar sempre',
      content: [{ type: 'diff', oldText: 'alpha', newText: 'beta' }],
    });
    a.answerPermission(block.id, { decision: 'deny-always' });
    await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'));
    const answer = fake.received.find((m) => m.method === undefined && m.id === 1000);
    expect(answer).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'never' } },
    });
    const tool = reduce(sink.deltas)[1]!.blocks.find((b) => b.kind === 'tool');
    expect(tool).toMatchObject({ state: 'error', output: 'Recusado.' });

    const options = [
      { optionId: 'a', name: 'a', kind: 'allow_once' as const },
      { optionId: 'r', name: 'r', kind: 'reject_once' as const },
    ];
    expect(acpOutcome(options, { decision: 'allow-once' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'a' },
    });
    expect(acpOutcome(options, { decision: 'deny-always' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'r' },
    });
    expect(acpOutcome(options, { decision: 'allow-always' })).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(acpOutcome(options, { decision: 'cancelled', reason: 'x' })).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    await a.close();
  });

  it('interromper manda session/cancel e o turno fecha como interrompido', async () => {
    const fake = fakeAcp();
    const { adapter: a, sink } = adapter(fake);
    await a.start();
    await a.send('slow job');
    await waitFor(() => sink.deltas.some((d) => d.type === 'block.append'));
    await a.interrupt();
    await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'));
    expect(fake.received.some((m) => m.method === 'session/cancel')).toBe(true);
    expect(sink.deltas.find((d) => d.type === 'turn.end')).toMatchObject({
      outcome: 'interrupted',
    });
    await a.close();
  });

  it('modelo, effort e modo vão por session/set_config_option e atualizam as capacidades', async () => {
    const fake = fakeAcp();
    const { adapter: a, sink } = adapter(fake);
    await a.start();
    await a.setModel('smart');
    await a.setEffort('high');
    await a.setMode('plan');
    const sets = fake.received
      .filter((m) => m.method === 'session/set_config_option')
      .map((m) => m.params);
    expect(sets).toEqual([
      { sessionId: 'sess-1', configId: 'model', value: 'smart' },
      { sessionId: 'sess-1', configId: 'effort', value: 'high' },
      { sessionId: 'sess-1', configId: 'mode', value: 'plan' },
    ]);
    expect(sink.deltas.some((d) => d.type === 'capabilities')).toBe(true);
    await a.close();
  });

  it('se o agente cai fica em erro; retomar usa session/resume quando o agente sabe', async () => {
    const fake = fakeAcp();
    const { adapter: a, sink } = adapter(fake);
    await a.start();
    fake.crash();
    await waitFor(() => sink.states.at(-1)?.state === 'error');
    expect(sink.states.at(-1)?.error).toContain('Falso');

    const again = fakeAcp({ resume: true });
    const resumed = adapter(again, { resume: 'sess-1' });
    await resumed.adapter.start();
    expect(again.received.find((m) => m.method === 'session/resume')?.params).toMatchObject({
      sessionId: 'sess-1',
    });
    await resumed.adapter.close();
    await expect(adapter(fakeAcp(), { resume: 'sess-1' }).adapter.start()).rejects.toThrow(
      'não sabe retomar',
    );
  });

  it('corre um agente ACP como processo de verdade', async () => {
    const sink = recordingSink();
    const a = new AcpAdapter(
      {
        cwd: tmpdir(),
        mode: null,
        label: 'Falso',
        command: process.execPath,
        args: [path.join(import.meta.dirname, 'fakes', 'acp-agent.ts')],
        env: { ...process.env },
      },
      sink,
    );
    await a.start();
    await a.send('olá');
    await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'), 10_000);
    expect(reduce(sink.deltas)[1]!.blocks.find((b) => b.kind === 'text')).toMatchObject({
      text: expect.stringContaining('monorepo'),
    });
    await a.close();
  }, 20_000);
});

describe('risco dos modos ACP', () => {
  it('classifica pelo id e pelo nome', () => {
    expect(classifyModeRisk('yolo', 'YOLO')).toBe('full');
    expect(classifyModeRisk('bypassPermissions', 'Bypass')).toBe('full');
    expect(classifyModeRisk('plan', 'Plan')).toBe('plan');
    expect(classifyModeRisk('read-only', 'Read only')).toBe('read-only');
    expect(classifyModeRisk('acceptEdits', 'Accept edits')).toBe('edits');
    expect(classifyModeRisk('default', 'Default')).toBe('ask');
  });
});

describe('catálogo ACP', () => {
  it('encontra o OpenCode instalado com npm -g e diz se a versão foi revista', async () => {
    const prefix = await mkdtemp(path.join(tmpdir(), 'solline-npm-'));
    try {
      const root = path.join(prefix, 'node_modules', 'opencode-ai');
      await mkdir(path.join(root, 'bin'), { recursive: true });
      await writeFile(path.join(root, 'bin', 'opencode.exe'), '');
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
      await writeFile(path.join(prefix, 'opencode.cmd'), '');
      const entry = CATALOG.find((e) => e.id === 'opencode')!;
      const found = findNpmAgent(entry, ['relativo', prefix].join(path.delimiter));
      expect(found).toEqual({ binary: path.join(root, 'bin', 'opencode.exe'), version: '9.9.9' });
      expect(findNpmAgent(entry, 'relativo')).toBeNull();
      const definition = catalogDefinition(entry, () => found);
      expect(await definition.detect()).toMatchObject({ status: 'unreviewed' });
      expect(await catalogDefinition(entry, () => null).detect()).toMatchObject({
        status: 'not-found',
      });
      expect(
        await catalogDefinition(entry, () => ({
          binary: 'x',
          version: entry.reviewedVersion,
        })).detect(),
      ).toEqual({
        status: 'ready',
      });
      expect(definition).toMatchObject({
        transport: 'acp',
        untrustedProjects: 'refused',
        staticModes: [],
      });
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  });
});
