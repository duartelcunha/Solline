import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonRpcPeer, RpcError, spawnAgent } from '../src/index.ts';

function pair(jsonrpc = false) {
  const fromAgent = new PassThrough();
  const toAgent = new PassThrough();
  const noise: string[] = [];
  const peer = new JsonRpcPeer({
    input: fromAgent,
    output: toAgent,
    jsonrpc,
    onNoise: (l) => noise.push(l),
  });
  const sent: Record<string, unknown>[] = [];
  let partial = '';
  toAgent.on('data', (chunk: Buffer) => {
    partial += chunk.toString();
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) if (line) sent.push(JSON.parse(line) as Record<string, unknown>);
  });
  const agent = (message: unknown) => fromAgent.write(`${JSON.stringify(message)}\n`);
  return { peer, sent, agent, fromAgent, noise };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('JsonRpcPeer', () => {
  it('pedido e resposta, sem o campo jsonrpc no Codex e com ele no ACP', async () => {
    const codex = pair(false);
    const reply = codex.peer.request('model/list', { limit: 1 });
    await tick();
    expect(codex.sent[0]).toEqual({ id: 1, method: 'model/list', params: { limit: 1 } });
    codex.agent({ id: 1, result: { data: [] } });
    expect(await reply).toEqual({ data: [] });

    const acp = pair(true);
    void acp.peer.request('initialize', {}).catch(() => undefined);
    await tick();
    expect(acp.sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  });

  it('um erro do agente rejeita com RpcError e o código', async () => {
    const { peer, agent } = pair();
    const reply = peer.request('thread/start');
    await tick();
    agent({ id: 1, error: { code: -32602, message: 'cwd inválido' } });
    await expect(reply).rejects.toBeInstanceOf(RpcError);
    await expect(reply).rejects.toMatchObject({ code: -32602 });
  });

  it('um pedido do agente a meio de um nosso é tratado e respondido', async () => {
    const { peer, sent, agent } = pair();
    peer.onRequest('item/commandExecution/requestApproval', async (params) => ({
      decision: (params as { ok: boolean }).ok ? 'accept' : 'decline',
    }));
    const reply = peer.request('turn/start', {});
    await tick();
    agent({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { ok: true } });
    await tick();
    expect(sent.at(-1)).toEqual({ id: 'srv-1', result: { decision: 'accept' } });
    agent({ id: 1, result: { turn: {} } });
    expect(await reply).toEqual({ turn: {} });
  });

  it('um pedido do agente sem quem o trate recebe -32601 logo', async () => {
    const { sent, agent } = pair();
    agent({ id: 7, method: 'attestation/generate', params: {} });
    await tick();
    expect(sent[0]).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it('aguenta CRLF, UTF-8 partido entre pedaços e linhas que não são JSON', async () => {
    const { peer, fromAgent, noise } = pair();
    const seen: unknown[] = [];
    peer.onNotification((method, params) => seen.push([method, params]));
    const bytes = Buffer.from('{"method":"warning","params":{"message":"olá 💡"}}\r\n', 'utf8');
    fromAgent.write('Codex a arrancar…\n');
    fromAgent.write(bytes.subarray(0, 40));
    fromAgent.write(bytes.subarray(40));
    await tick();
    expect(seen).toEqual([['warning', { message: 'olá 💡' }]]);
    expect(noise).toEqual(['Codex a arrancar…']);
  });

  it('quando o agente fecha, tudo o que estava à espera é rejeitado', async () => {
    const { peer, fromAgent } = pair();
    const reply = peer.request('turn/start');
    fromAgent.end();
    await expect(reply).rejects.toThrow('fechou');
    expect(peer.isClosed).toBe(true);
    await expect(peer.request('x')).rejects.toThrow();
  });

  it('um pedido com prazo falha sozinho se não houver resposta', async () => {
    const { peer } = pair();
    await expect(peer.request('initialize', {}, 20)).rejects.toThrow('sem resposta');
  });
});

describe('spawnAgent', () => {
  it('recusa um executável que não seja caminho absoluto', () => {
    expect(() => spawnAgent({ command: 'codex', args: [], env: {}, cwd: tmpdir() })).toThrow(
      'caminho absoluto',
    );
  });

  it('nunca escolhe um executável plantado na pasta do projeto', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'solline-plant-'));
    try {
      await writeFile(path.join(dir, 'codex.exe'), 'não é um exe');
      expect(() => spawnAgent({ command: 'codex.exe', args: [], env: {}, cwd: dir })).toThrow(
        'caminho absoluto',
      );
      const child = spawnAgent({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.cwd())'],
        env: { ...process.env },
        cwd: dir,
      });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      await new Promise((r) => child.on('close', r));
      expect(path.resolve(out).toLowerCase()).toBe(path.resolve(dir).toLowerCase());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
