import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolBlock } from '@solline/protocol';
import {
  CODEX_LOGIN_MESSAGE,
  CodexAppServerAdapter,
  CodexNormalizer,
  REVIEWED_CODEX_VERSION,
  codexDecision,
  displayCommand,
  resolveCodexExecutable,
} from '../src/index.ts';
import { GENERATED_FROM } from '../src/adapters/codex/protocol/GENERATED_FROM.ts';
import { declinedVariant, fakeCodexServer, loadCodexFixture, replayCodex } from './codex-fakes.ts';
import { recordingSink, reduce, waitFor } from './helpers.ts';
import pkg from '../package.json' with { type: 'json' };

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

function normalize(name: string) {
  const normalizer = new CodexNormalizer({ newId: ids() });
  const deltas = [...normalizer.userTurn('user-1', 'pedido')];
  for (const record of loadCodexFixture(name)) {
    const msg = record.msg;
    if (record.dir === 'in' && typeof msg.method === 'string' && msg.id === undefined) {
      deltas.push(...normalizer.push(msg.method, msg.params));
    }
  }
  return deltas;
}

describe('CodexNormalizer com mensagens reais', () => {
  it('resposta simples: texto em streaming igual ao final, tokens e contexto', () => {
    const deltas = normalize('plain-answer');
    const turns = reduce(deltas);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    const text = turns[1]!.blocks.find((b) => b.kind === 'text');
    expect(text).toMatchObject({ text: expect.stringMatching(/\*\*monorepo\*\*/) });
    const usage = deltas.filter((d) => d.type === 'usage');
    expect(usage.at(-1)).toMatchObject({
      usage: { tokens: { input: expect.any(Number), output: expect.any(Number) } },
    });
    expect(deltas.at(-1)).toMatchObject({ type: 'turn.end', outcome: 'done' });
  });

  it('edição: comandos com o que está dentro do powershell e a edição como patch', () => {
    const turns = reduce(normalize('edit-with-permission'));
    const tools = turns[1]!.blocks.filter((b): b is ToolBlock => b.kind === 'tool');
    const read = tools[0]!;
    expect(read).toMatchObject({ category: 'read', summary: 'Ler notes.txt', state: 'ok' });
    expect(read.content?.[0]).toMatchObject({
      type: 'command',
      command: 'Get-Content -LiteralPath notes.txt',
    });
    const edit = tools.find((t) => t.name === 'apply_patch')!;
    expect(edit).toMatchObject({
      category: 'edit',
      summary: 'Editar notes.txt',
      state: 'ok',
      content: [{ type: 'patch', unified: expect.stringContaining('+The quick beta fox.') }],
    });
    const texts = turns[1]!.blocks.filter((b) => b.kind === 'text');
    expect(texts.map((t) => (t.kind === 'text' ? t.text : ''))).toContain(
      'Substituí “alpha” por “beta” em `notes.txt`.',
    );
  });

  it('edição recusada fica como ferramenta com erro', () => {
    const normalizer = new CodexNormalizer({ newId: ids() });
    const deltas = [...normalizer.userTurn('u', 'x')];
    for (const r of declinedVariant(loadCodexFixture('edit-with-permission'))) {
      if (r.dir === 'in' && typeof r.msg.method === 'string' && r.msg.id === undefined) {
        deltas.push(...normalizer.push(r.msg.method, r.msg.params));
      }
    }
    const edit = reduce(deltas)[1]!.blocks.find(
      (b) => b.kind === 'tool' && b.name === 'apply_patch',
    );
    expect(edit).toMatchObject({ state: 'error', output: 'Recusado.' });
  });

  it('o plano do turno vira lista de tarefas e um turno falhado deixa aviso', () => {
    const normalizer = new CodexNormalizer({ newId: ids() });
    const deltas = [
      ...normalizer.userTurn('u', 'x'),
      ...normalizer.push('turn/plan/updated', {
        plan: [
          { step: 'Ler', status: 'completed' },
          { step: 'Editar', status: 'inProgress' },
          { step: 'Testar', status: 'pending' },
        ],
      }),
      ...normalizer.push('turn/completed', {
        turn: { id: 't', status: 'failed', error: { message: 'Limite de uso atingido' } },
      }),
    ];
    const turn = reduce(deltas)[1]!;
    expect(turn.blocks.find((b) => b.kind === 'todo')).toMatchObject({
      entries: [
        { content: 'Ler', status: 'completed' },
        { content: 'Editar', status: 'in_progress' },
        { content: 'Testar', status: 'pending' },
      ],
    });
    expect(turn.blocks.find((b) => b.kind === 'notice')).toMatchObject({
      tone: 'error',
      text: 'Limite de uso atingido',
    });
    expect(deltas.at(-1)).toMatchObject({ type: 'turn.end', outcome: 'error' });
  });

  it('tira o comando de dentro do powershell -Command', () => {
    expect(
      displayCommand(
        `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'npm test'`,
      ),
    ).toBe('npm test');
    expect(displayCommand('git status')).toBe('git status');
  });
});

function adapter(server: ReturnType<typeof fakeCodexServer>, extra: Record<string, unknown> = {}) {
  const sink = recordingSink();
  const a = new CodexAppServerAdapter(
    { cwd: 'C:/p', mode: 'ask', transport: server.transport, ...extra },
    sink,
  );
  return { sink, adapter: a };
}

describe('CodexAppServerAdapter', () => {
  it('arranca: modelos visíveis, ordem do effort, modos, thread e sem custo', async () => {
    const server = fakeCodexServer();
    const { adapter: a, sink } = adapter(server);
    const started = await a.start();
    expect(started.capabilities.models.map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-5.6-terra']);
    expect(started.capabilities.effortOrder).toEqual(['low', 'medium', 'high', 'ultra']);
    expect(started.capabilities.modes.map((m) => m.id)).toEqual(['read-only', 'ask', 'auto']);
    expect(started.capabilities.features).toEqual({ cost: false, context: true, resume: true });
    expect(started.settings).toMatchObject({ model: 'gpt-6-luna', mode: 'ask', effort: 'medium' });
    expect(a.agentSessionId()).toBe('thread-1');
    const init = server.received.find((m) => m.method === 'initialize');
    expect(init).toMatchObject({
      params: {
        clientInfo: { name: 'solline', title: 'Solline' },
        capabilities: { experimentalApi: false },
      },
    });
    expect(server.received.find((m) => m.method === 'thread/start')).toMatchObject({
      params: { cwd: 'C:/p', approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
    });
    expect(sink.deltas).toContainEqual({ type: 'meta', agentSessionId: 'thread-1' });
    await a.close();
    expect(server.killed).toBe(true);
  });

  it('sem sessão no Codex não arranca e diz porquê', async () => {
    const server = fakeCodexServer({ account: { account: null, requiresOpenaiAuth: true } });
    const { adapter: a } = adapter(server);
    await expect(a.start()).rejects.toThrow(CODEX_LOGIN_MESSAGE);
    expect(server.killed).toBe(true);
  });

  it('sem o sandbox do Windows só fica o Ask e um aviso', async () => {
    const server = fakeCodexServer({ sandbox: 'notConfigured' });
    const { adapter: a, sink } = adapter(server, { mode: 'auto' });
    const started = await a.start();
    if (process.platform === 'win32') {
      expect(started.capabilities.modes.map((m) => m.id)).toEqual(['ask']);
      expect(started.settings.mode).toBe('ask');
      expect(reduce(sink.deltas).flatMap((t) => t.blocks)).toContainEqual(
        expect.objectContaining({ kind: 'notice', text: expect.stringContaining('sandbox') }),
      );
    }
    await a.close();
  });

  it('modelo, effort e modo vão no turn/start seguinte', async () => {
    const server = fakeCodexServer();
    const { adapter: a, sink } = adapter(server);
    await a.start();
    await a.setModel('gpt-5.6-terra');
    await a.setEffort('ultra');
    await a.setMode('read-only');
    expect(sink.deltas.filter((d) => d.type === 'settings').at(-1)).toEqual({
      type: 'settings',
      settings: { mode: 'read-only' },
    });
    await a.send('olá');
    const first = await server.waitFor((m) => m.method === 'turn/start');
    expect(first.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'olá' }],
      model: 'gpt-5.6-terra',
      effort: 'ultra',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly' },
    });
    server.notify('turn/completed', { turn: { id: server.turnId(), status: 'completed' } });
    await waitFor(() => sink.states.at(-1)?.state === 'idle');
    await a.send('outra');
    await waitFor(() => server.received.filter((m) => m.method === 'turn/start').length === 2);
    const second = server.received.filter((m) => m.method === 'turn/start')[1]!;
    expect(second.params).not.toHaveProperty('model');
    await a.close();
  });

  it('aprovação de comando: cartão com o comando, resposta accept/acceptForSession/decline', async () => {
    const server = fakeCodexServer();
    const { adapter: a, sink } = adapter(server);
    await a.start();
    await a.send('corre os testes');
    const asked = sink.nextAsk();
    const reply = server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'exec-1',
      command: `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'npm test'`,
      cwd: 'C:/p',
      reason: 'Corre a suite',
    });
    const block = await asked;
    expect(block).toMatchObject({
      kind: 'permission',
      title: 'Correr npm test',
      description: 'Corre a suite',
      category: 'execute',
      canAlwaysAllow: true,
      alwaysScope: 'session',
      content: [{ type: 'command', command: 'npm test' }],
    });
    expect(sink.states.at(-1)?.state).toBe('needs-you');
    expect(() => a.answerPermission(block.id, { decision: 'deny-always' })).toThrow();
    a.answerPermission(block.id, { decision: 'allow-always' });
    expect((await reply).result).toEqual({ decision: 'acceptForSession' });
    expect(codexDecision('item/commandExecution/requestApproval', { decision: 'deny' })).toBe(
      'decline',
    );
    expect(codexDecision('execCommandApproval', { decision: 'allow-once' })).toBe('approved');
    await a.close();
  });

  it('serverRequest/resolved fecha o cartão como cancelado', async () => {
    const server = fakeCodexServer();
    const { adapter: a, sink } = adapter(server);
    await a.start();
    await a.send('x');
    const asked = sink.nextAsk();
    const reply = server.request('item/fileChange/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
    });
    const block = await asked;
    server.notify('serverRequest/resolved', { threadId: 'thread-1', requestId: 100 });
    expect((await reply).result).toEqual({ decision: 'cancel' });
    await waitFor(() =>
      sink.deltas.some(
        (d) =>
          d.type === 'block.upsert' &&
          d.block.id === block.id &&
          'status' in d.block &&
          d.block.status === 'cancelled',
      ),
    );
    await a.close();
  });

  it('interromper cancela o pedido aberto e manda turn/interrupt com o turno do Codex', async () => {
    const server = fakeCodexServer();
    const { adapter: a, sink } = adapter(server);
    await a.start();
    await a.send('trabalho longo');
    await server.waitFor((m) => m.method === 'turn/start');
    await waitFor(() => server.turnId() === 'turn-1');
    server.notify('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } });
    const asked = sink.nextAsk();
    const reply = server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'exec-1',
      command: 'rm -rf build',
    });
    await asked;
    await a.interrupt();
    expect((await reply).result).toEqual({ decision: 'cancel' });
    expect(server.received.find((m) => m.method === 'turn/interrupt')).toMatchObject({
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    server.notify('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
    await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'));
    expect(sink.deltas.find((d) => d.type === 'turn.end')).toMatchObject({
      outcome: 'interrupted',
    });
    await a.close();
  });

  it('se o processo cai, a sessão fica em erro; retomar usa thread/resume', async () => {
    const server = fakeCodexServer();
    const { adapter: a, sink } = adapter(server);
    await a.start();
    server.crash();
    await waitFor(() => sink.states.at(-1)?.state === 'error');
    expect(sink.states.at(-1)?.error).toContain('Codex');

    const again = fakeCodexServer();
    const resumed = adapter(again, { resume: a.agentSessionId() });
    await resumed.adapter.start();
    expect(again.received.find((m) => m.method === 'thread/resume')).toMatchObject({
      params: { threadId: 'thread-1', cwd: 'C:/p' },
    });
    expect(again.received.some((m) => m.method === 'thread/start')).toBe(false);
    await resumed.adapter.close();
  });

  it('interromper logo a seguir a enviar manda turn/interrupt quando o turno é conhecido', async () => {
    const server = fakeCodexServer();
    const { adapter: a } = adapter(server);
    await a.start();
    await a.send('trabalho longo');
    await a.interrupt();
    const interrupt = await server.waitFor((m) => m.method === 'turn/interrupt');
    expect(interrupt.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    await a.close();
  });

  it('se o turn/start falha, modelo e modo pedidos vão no turno seguinte', async () => {
    const server = fakeCodexServer({ failTurnStarts: 1 });
    const { adapter: a, sink } = adapter(server);
    await a.start();
    await a.setModel('gpt-5.6-terra');
    await a.setMode('read-only');
    await a.send('primeira');
    await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'));
    await a.send('segunda');
    await waitFor(() => server.received.filter((m) => m.method === 'turn/start').length === 2);
    expect(server.received.filter((m) => m.method === 'turn/start')[1]!.params).toMatchObject({
      model: 'gpt-5.6-terra',
      sandboxPolicy: { type: 'readOnly' },
    });
    await a.close();
  });

  it('um codex.exe que não existe falha o arranque sem derrubar o motor', async () => {
    const sink = recordingSink();
    const a = new CodexAppServerAdapter(
      { cwd: tmpdir(), mode: 'ask', executable: path.join(tmpdir(), 'nao-existe', 'codex.exe') },
      sink,
    );
    await expect(a.start()).rejects.toThrow();
  });

  it('na recusa da gravação, a resposta ao Codex é decline', async () => {
    const replay = replayCodex(declinedVariant(loadCodexFixture('edit-with-permission')));
    const sink = recordingSink();
    const a = new CodexAppServerAdapter(
      { cwd: 'C:/p', mode: 'read-only', transport: replay.transport },
      sink,
    );
    await a.start();
    const asked = sink.nextAsk();
    await a.send('edita');
    a.answerPermission((await asked).id, { decision: 'deny' });
    await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'), 5_000);
    expect(replay.received.find((m) => m.method === undefined && m.id === 0)).toEqual({
      id: 0,
      result: { decision: 'decline' },
    });
    expect(
      codexDecision('item/fileChange/requestApproval', { decision: 'cancelled', reason: 'x' }),
    ).toBe('cancel');
    expect(codexDecision('applyPatchApproval', { decision: 'deny' })).toEqual({
      denied: { rejection: 'The user denied this action.' },
    });
    expect(codexDecision('execCommandApproval', { decision: 'cancelled', reason: 'x' })).toBe(
      'abort',
    );
    await a.close();
  });

  it('reproduz a gravação real da edição com aprovação', async () => {
    const replay = replayCodex(loadCodexFixture('edit-with-permission'));
    const sink = recordingSink();
    const a = new CodexAppServerAdapter(
      { cwd: 'C:/p', mode: 'read-only', transport: replay.transport },
      sink,
    );
    await a.start();
    const asked = sink.nextAsk();
    await a.send('edita');
    const block = await asked;
    expect(block).toMatchObject({
      kind: 'permission',
      title: 'Editar notes.txt',
      content: [{ type: 'patch', unified: expect.stringContaining('beta') }],
    });
    a.answerPermission(block.id, { decision: 'allow-once' });
    await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'), 5_000);
    const answer = replay.received.find((m) => m.method === undefined && m.id === 0);
    expect(answer).toEqual({ id: 0, result: { decision: 'accept' } });
    expect(replay.done()).toBe(true);
    await a.close();
  });
});

describe('Codex: versão e executável', () => {
  it('os tipos foram gerados da versão revista, que é a do package.json', () => {
    expect(GENERATED_FROM).toBe(REVIEWED_CODEX_VERSION);
    expect(pkg.dependencies['@openai/codex']).toBe(REVIEWED_CODEX_VERSION);
  });

  it('encontra o codex.exe de um npm -g no PATH, nunca por caminhos relativos', async () => {
    const prefix = await mkdtemp(path.join(tmpdir(), 'solline-npm-'));
    try {
      const vendor = path.join(
        prefix,
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        '@openai',
        'codex-win32-x64',
        'vendor',
        'x86_64-pc-windows-msvc',
      );
      await mkdir(path.join(vendor, 'bin'), { recursive: true });
      await writeFile(path.join(vendor, 'bin', 'codex.exe'), '');
      await writeFile(
        path.join(vendor, 'codex-package.json'),
        JSON.stringify({ version: '9.9.9' }),
      );
      await writeFile(path.join(prefix, 'codex.cmd'), '');
      const notBundled = () => {
        throw new Error('não está no motor');
      };
      const found = resolveCodexExecutable({
        platform: 'win32',
        arch: 'x64',
        resolve: notBundled,
        pathEnv: ['relativo', prefix].join(path.delimiter),
      });
      expect(found).toEqual({
        path: path.join(vendor, 'bin', 'codex.exe'),
        version: '9.9.9',
        source: 'path',
      });
      expect(
        resolveCodexExecutable({
          platform: 'win32',
          arch: 'x64',
          resolve: notBundled,
          pathEnv: 'relativo',
        }),
      ).toBeNull();
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  });
});
