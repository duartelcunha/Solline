import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  BRAIN_PIPE_ENV,
  BRAIN_TOKEN_ENV,
  Brain,
  BrainChannel,
  BrainToolError,
  brainToolLabel,
  contextTool,
  defineBrainTool,
  sourceShimPath,
  toolSummary,
  type BrainBinding,
  type BrainSession,
} from '../src/index.ts';
import { mcpToolApproval } from '../src/adapters/codex/mcp.ts';
import { connectChannel, hello } from './brain-client.ts';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function session(id: string, title = 'Nova sessão', agent: 'claude' | 'codex' = 'codex') {
  return {
    id,
    projectId: `projeto-${id}`,
    agent,
    describe: () => ({ title, folder: `pasta-${id}` }),
  } satisfies BrainSession;
}

function brainOf(options: { channel?: BrainChannel; node?: string | null } = {}) {
  const channel = options.channel ?? new BrainChannel({ helloTimeoutMs: 300 });
  const warn = vi.fn();
  const brain = new Brain({
    channel,
    shim: sourceShimPath(),
    node: () => (options.node === undefined ? process.execPath : options.node),
    warn,
  });
  closers.push(() => brain.dispose());
  return { brain, channel, warn };
}

async function stdioBinding(brain: Brain, s: BrainSession): Promise<BrainBinding> {
  const binding = await brain.bind(s, 'stdio');
  closers.push(() => binding.revoke());
  return binding;
}

function launchEnv(binding: BrainBinding): { pipe: string; token: string } {
  const env = binding.launch?.env ?? {};
  return { pipe: env[BRAIN_PIPE_ENV] ?? '', token: env[BRAIN_TOKEN_ENV] ?? '' };
}

describe('Brain: registo e identidade do chamador', () => {
  it('cada chamada ganha a identidade da sessão que a fez, nunca a dos argumentos', async () => {
    const { brain } = brainOf();
    const a = await brain.bind(session('a', 'Primeira'), 'in-process');
    const b = await brain.bind(session('b', 'Segunda', 'claude'), 'in-process');
    const first = await a.call('solline_context', {});
    const second = await b.call('solline_context', {});
    expect(JSON.parse(first.text)).toEqual({
      project: 'projeto-a',
      folder: 'pasta-a',
      session: 'Primeira',
      agent: 'codex',
    });
    expect(JSON.parse(second.text)).toMatchObject({ project: 'projeto-b', agent: 'claude' });
    // Um agente que tente passar outra identidade nos argumentos é recusado.
    const spoof = await a.call('solline_context', { sessionId: 'b', projectId: 'projeto-b' });
    expect(spoof).toMatchObject({ isError: true });
    expect(spoof.text).toContain('Argumentos inválidos');
  });

  it('o título lê-se na altura da chamada (nasce da primeira mensagem)', async () => {
    const { brain } = brainOf();
    let title = 'Nova sessão';
    const binding = await brain.bind(
      { ...session('a'), describe: () => ({ title, folder: 'x' }) },
      'in-process',
    );
    title = 'Corrigir o login';
    expect(JSON.parse((await binding.call('solline_context', {})).text).session).toBe(
      'Corrigir o login',
    );
  });

  it('erros viram resultado de erro, nunca exceção; só os da ferramenta chegam ao agente', async () => {
    const tools = [
      defineBrainTool({
        name: 'falha_clara',
        description: 'x',
        input: { n: z.number() },
        readOnly: true,
        handler: () => {
          throw new BrainToolError('A memória não existe');
        },
      }),
      defineBrainTool({
        name: 'falha_interna',
        description: 'x',
        input: {},
        readOnly: true,
        handler: () => {
          throw new Error('caminho C:\\segredo\\interno');
        },
      }),
    ];
    const brain = new Brain({ tools });
    const binding = await brain.bind(session('a'), 'in-process');
    expect(await binding.call('falha_clara', { n: 1 })).toEqual({
      text: 'A memória não existe',
      isError: true,
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const internal = await binding.call('falha_interna', {});
    quiet.mockRestore();
    expect(internal).toEqual({ text: 'Erro interno da Solline.', isError: true });
    expect((await binding.call('falha_clara', { n: 'um' })).text).toContain('Argumentos inválidos');
    expect(await binding.call('nao_existe', {})).toMatchObject({ isError: true });
  });

  it('o resultado muito grande é cortado', async () => {
    const big = defineBrainTool({
      name: 'grande',
      description: 'x',
      input: {},
      readOnly: true,
      handler: () => 'a'.repeat(200_000),
    });
    const binding = await new Brain({ tools: [big] }).bind(session('a'), 'in-process');
    const result = await binding.call('grande', {});
    expect(result.text.length).toBeLessThan(70_000);
    expect(result.text.endsWith('[cortado]')).toBe(true);
  });

  it('revogado, o acesso fecha', async () => {
    const binding = await new Brain().bind(session('a'), 'in-process');
    expect(binding.revoked).toBe(false);
    binding.revoke();
    expect(binding.revoked).toBe(true);
    expect(await binding.call('solline_context', {})).toMatchObject({ isError: true });
  });

  it('nomes de ferramenta repetidos ou inválidos são recusados', () => {
    expect(() => new Brain({ tools: [contextTool, contextTool] })).toThrow('repetida');
    expect(() =>
      defineBrainTool({
        name: 'Mau Nome',
        description: 'x',
        input: {},
        readOnly: true,
        handler: () => 1,
      }),
    ).toThrow('inválido');
  });

  it('as ferramentas só de leitura são as que podem correr sem pedir', async () => {
    const write = defineBrainTool({
      name: 'escreve',
      description: 'x',
      input: {},
      readOnly: false,
      handler: () => 'ok',
    });
    const brain = new Brain({ tools: [contextTool, write] });
    expect(brain.readOnlyTools).toEqual(['solline_context']);
  });
});

describe('Brain: sem Node ou sem shim, sem cérebro para o Codex e o ACP', () => {
  it('sem Node no PATH: sem launch, avisa uma vez', async () => {
    const { brain, warn } = brainOf({ node: null });
    const one = await brain.bind(session('a'), 'stdio');
    const two = await brain.bind(session('b'), 'stdio');
    expect(one.launch).toBeNull();
    expect(one.available).toBe(false);
    expect(two.available).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('Node.js');
    // O Claude, em processo, não precisa de Node nenhum.
    expect((await brain.bind(session('c'), 'in-process')).available).toBe(true);
  });

  it('sem o ficheiro do shim: o mesmo', async () => {
    const warn = vi.fn();
    const brain = new Brain({
      shim: 'C:/nao/existe/shim.cjs',
      node: () => process.execPath,
      warn,
    });
    const binding = await brain.bind(session('a'), 'stdio');
    expect(binding.launch).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain('shim');
    await brain.dispose();
  });

  it('com Node e shim: o launch usa o Node do sistema e um token de pelo menos 32 bytes', async () => {
    const { brain } = brainOf();
    const binding = await stdioBinding(brain, session('a'));
    expect(binding.launch).toMatchObject({
      name: 'solline',
      command: process.execPath,
      args: [sourceShimPath()],
      executesCode: false,
      autoApprove: ['solline_context'],
    });
    const { pipe, token } = launchEnv(binding);
    expect(pipe).toMatch(
      process.platform === 'win32' ? /^\\\\\.\\pipe\\solline-brain-[0-9a-f]{32}$/ : /\.sock$/,
    );
    expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);
    const other = launchEnv(await stdioBinding(brain, session('b')));
    expect(other.token).not.toBe(token);
    expect(other.pipe).toBe(pipe);
  });
});

describe('BrainChannel', () => {
  it('um token bom abre a ligação e as chamadas chegam à sessão certa', async () => {
    const { brain } = brainOf();
    const a = launchEnv(await stdioBinding(brain, session('a', 'Titulo A')));
    const b = launchEnv(await stdioBinding(brain, session('b', 'Titulo B')));
    const client = await connectChannel(a.pipe);
    client.send({ type: 'hello', token: a.token });
    const ready = await client.next();
    expect(ready).toMatchObject({ type: 'ready' });
    expect((ready.tools as { name: string }[]).map((t) => t.name)).toEqual(['solline_context']);
    expect(ready.tools).toEqual([
      expect.objectContaining({
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        readOnly: true,
      }),
    ]);
    client.send({ type: 'call', id: 7, name: 'solline_context', args: {} });
    const result = await client.next();
    expect(result).toMatchObject({ type: 'result', id: 7, isError: false });
    expect(JSON.parse(result.text as string)).toMatchObject({ session: 'Titulo A' });
    const other = await connectChannel(b.pipe);
    other.send({ type: 'hello', token: b.token });
    await other.next();
    other.send({ type: 'call', id: 1, name: 'solline_context', args: {} });
    expect(JSON.parse((await other.next()).text as string)).toMatchObject({ session: 'Titulo B' });
    client.destroy();
    other.destroy();
  });

  it('um token desconhecido, sem hello ou mal formado é recusado e a ligação fecha', async () => {
    const { brain } = brainOf();
    const { pipe } = launchEnv(await stdioBinding(brain, session('a')));
    expect(await hello(pipe, 'token-que-ninguem-deu')).toEqual({
      type: 'error',
      message: 'unauthorized',
    });
    const noHello = await connectChannel(pipe);
    noHello.send({ type: 'call', id: 1, name: 'solline_context', args: {} });
    expect(await noHello.next()).toEqual({ type: 'error', message: 'unauthorized' });
    await noHello.closed;
    const garbage = await connectChannel(pipe);
    garbage.destroy();
    const bad = await connectChannel(pipe);
    bad.send('isto não é um objeto');
    expect(await bad.next()).toEqual({ type: 'error', message: 'bad message' });
  });

  it('uma ligação que nunca diz quem é fecha sozinha', async () => {
    const { brain } = brainOf();
    const { pipe } = launchEnv(await stdioBinding(brain, session('a')));
    const silent = await connectChannel(pipe);
    expect(await silent.next()).toEqual({ type: 'error', message: 'unauthorized' });
    await silent.closed;
  });

  it('uma sessão fechada deixa de valer, a ligação aberta cai e o hello novo é recusado', async () => {
    const { brain, channel } = brainOf();
    const binding = await stdioBinding(brain, session('a'));
    const { pipe, token } = launchEnv(binding);
    const live = await connectChannel(pipe);
    live.send({ type: 'hello', token });
    await live.next();
    expect(channel.activeTokens).toBe(1);
    binding.revoke();
    await live.closed;
    expect(channel.activeTokens).toBe(0);
    expect(await hello(pipe, token)).toEqual({ type: 'error', message: 'unauthorized' });
  });

  it('o token revogado mesmo com a chamada a meio não devolve o resultado', async () => {
    let release: () => void = () => undefined;
    const slow = defineBrainTool({
      name: 'lenta',
      description: 'x',
      input: {},
      readOnly: true,
      handler: () => new Promise((resolve) => (release = () => resolve('tarde'))),
    });
    const channel = new BrainChannel();
    const brain = new Brain({
      tools: [slow],
      channel,
      shim: sourceShimPath(),
      node: () => process.execPath,
    });
    closers.push(() => brain.dispose());
    const binding = await brain.bind(session('a'), 'stdio');
    const { pipe, token } = launchEnv(binding);
    const client = await connectChannel(pipe);
    client.send({ type: 'hello', token });
    await client.next();
    client.send({ type: 'call', id: 1, name: 'lenta', args: {} });
    await vi.waitFor(() => expect(release).not.toBe(undefined));
    binding.revoke();
    release();
    await client.closed;
    expect(client.isClosed()).toBe(true);
  });

  it('mensagens grandes demais são recusadas, com ou sem fim de linha', async () => {
    const channel = new BrainChannel({ maxMessageBytes: 2048, helloTimeoutMs: 300 });
    const { brain } = brainOf({ channel });
    const { pipe, token } = launchEnv(await stdioBinding(brain, session('a')));
    const withLine = await connectChannel(pipe);
    withLine.send({ type: 'hello', token: 'x'.repeat(4096) });
    expect(await withLine.next()).toEqual({ type: 'error', message: 'message too large' });
    const streaming = await connectChannel(pipe);
    streaming.send({ type: 'hello', token });
    await streaming.next();
    streaming.send({
      type: 'call',
      id: 1,
      name: 'solline_context',
      args: { lixo: 'y'.repeat(4096) },
    });
    expect(await streaming.next()).toEqual({ type: 'error', message: 'message too large' });
    await streaming.closed;
    // Uma linha que nunca acaba também não enche a memória.
    const endless = await connectChannel(pipe);
    endless.raw('a'.repeat(1500));
    endless.raw('a'.repeat(1500));
    expect(await endless.next()).toEqual({ type: 'error', message: 'message too large' });
    await endless.closed;
  });

  it('o número de ligações por token tem limite', async () => {
    const { brain } = brainOf();
    const { pipe, token } = launchEnv(await stdioBinding(brain, session('a')));
    const open = [];
    for (let i = 0; i < 8; i++) {
      const c = await connectChannel(pipe);
      c.send({ type: 'hello', token });
      expect(await c.next()).toMatchObject({ type: 'ready' });
      open.push(c);
    }
    expect(await hello(pipe, token)).toEqual({ type: 'error', message: 'unauthorized' });
    for (const c of open) c.destroy();
  });

  it('fechar o canal fecha as ligações e acaba com os tokens', async () => {
    const { brain, channel } = brainOf();
    const { pipe, token } = launchEnv(await stdioBinding(brain, session('a')));
    const client = await connectChannel(pipe);
    client.send({ type: 'hello', token });
    await client.next();
    await channel.close();
    await client.closed;
    expect(channel.activeTokens).toBe(0);
    await expect(channel.listen()).rejects.toThrow('fechado');
  });
});

/** Um cliente MCP por stdio, como o Codex o é para o shim. */
function mcpShim(env: Record<string, string>) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [sourceShimPath()], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  closers.push(() => void child.kill());
  let out = '';
  let err = '';
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString();
    for (;;) {
      const end = out.indexOf('\n');
      if (end < 0) return;
      const message = JSON.parse(out.slice(0, end)) as Record<string, unknown>;
      out = out.slice(end + 1);
      waiting.get(message.id as number)?.(message);
    }
  });
  let id = 0;
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return {
    stderr: () => err,
    exited,
    request: (method: string, params?: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const mine = ++id;
        waiting.set(mine, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`);
      }),
    notify: (method: string) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    close: () => child.stdin.end(),
  };
}

describe('o shim MCP por stdio, com um canal a sério', () => {
  it('initialize, tools/list e tools/call de ponta a ponta', async () => {
    const { brain } = brainOf();
    const binding = await stdioBinding(brain, session('a', 'Titulo no shim'));
    const { pipe, token } = launchEnv(binding);
    const shim = mcpShim({ [BRAIN_PIPE_ENV]: pipe, [BRAIN_TOKEN_ENV]: token });

    const init = await shim.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'teste', version: '1' },
    });
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'solline' },
    });
    shim.notify('notifications/initialized');
    expect((await shim.request('ping')).result).toEqual({});

    const list = await shim.request('tools/list');
    expect(list.result).toEqual({
      tools: [
        {
          name: 'solline_context',
          description: expect.stringContaining('Solline session'),
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
        },
      ],
    });

    const call = await shim.request('tools/call', { name: 'solline_context', arguments: {} });
    const content = (call.result as { content: { text: string }[]; isError: boolean }).content[0]!;
    expect(JSON.parse(content.text)).toMatchObject({
      project: 'projeto-a',
      session: 'Titulo no shim',
      agent: 'codex',
    });
    expect((call.result as { isError: boolean }).isError).toBe(false);

    const bad = await shim.request('tools/call', { name: 'solline_context', arguments: { x: 1 } });
    expect((bad.result as { isError: boolean }).isError).toBe(true);
    expect((await shim.request('nao/existe')).error).toMatchObject({ code: -32601 });
    expect((await shim.request('resources/list')).result).toEqual({ resources: [] });

    // Revogada a sessão, o shim diz que já não há Solline em vez de se pendurar.
    binding.revoke();
    await vi.waitFor(async () => {
      const after = await shim.request('tools/call', { name: 'solline_context', arguments: {} });
      expect((after.result as { isError: boolean }).isError).toBe(true);
    });
    // O token nunca sai do shim, nem para o stderr.
    expect(shim.stderr()).not.toContain(token);
    shim.close();
    expect(await shim.exited).toBe(0);
  }, 20_000);

  it('com um token errado responde ao MCP sem ferramentas, em vez de falhar o arranque do agente', async () => {
    const { brain } = brainOf();
    const { pipe } = launchEnv(await stdioBinding(brain, session('a')));
    const shim = mcpShim({ [BRAIN_PIPE_ENV]: pipe, [BRAIN_TOKEN_ENV]: 'token-errado' });
    expect(
      (await shim.request('initialize', { protocolVersion: '2025-06-18' })).result,
    ).toMatchObject({
      serverInfo: { name: 'solline' },
    });
    expect((await shim.request('tools/list')).result).toEqual({ tools: [] });
    const call = await shim.request('tools/call', { name: 'solline_context', arguments: {} });
    expect((call.result as { isError: boolean }).isError).toBe(true);
    expect(shim.stderr()).toContain('unauthorized');
    expect(shim.stderr()).not.toContain('token-errado');
    shim.close();
  }, 20_000);

  it('sem as variáveis de ambiente também responde, sem ferramentas', async () => {
    const shim = mcpShim({ [BRAIN_PIPE_ENV]: '', [BRAIN_TOKEN_ENV]: '' });
    expect((await shim.request('tools/list')).result).toEqual({ tools: [] });
    shim.close();
  }, 20_000);
});

describe('como a autorização mostra as ferramentas da Solline', () => {
  it('o Claude chama-lhes "Solline · nome"', () => {
    expect(toolSummary('mcp__solline__solline_context', {})).toBe('Solline · solline_context');
    expect(toolSummary('mcp__rea__run', {})).toBe('rea: run');
    expect(brainToolLabel('x')).toBe('Solline · x');
  });

  it('o Codex também', () => {
    const approval = mcpToolApproval({
      threadId: 't',
      turnId: null,
      serverName: 'solline',
      mode: 'form',
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'solline_context', persist: [] },
      message: 'Allow?',
      requestedSchema: { type: 'object', properties: {} },
    } as never);
    expect(approval?.title).toBe('Solline · solline_context');
  });
});
