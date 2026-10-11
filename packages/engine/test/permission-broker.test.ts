import { describe, expect, it } from 'vitest';
import { AsyncQueue, PermissionBroker, sanitizedEnv } from '../src/index.ts';

describe('PermissionBroker', () => {
  it('entrega a resposta a quem espera', async () => {
    const broker = new PermissionBroker();
    const waiting = broker.wait('r1');
    expect(broker.answer('r1', { decision: 'allow-once' })).toBe(true);
    await expect(waiting).resolves.toEqual({ decision: 'allow-once' });
    expect(broker.answer('r1', { decision: 'deny' })).toBe(false);
  });

  it('respeita o signal do agente', async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    const waiting = broker.wait('r1', controller.signal);
    controller.abort();
    await expect(waiting).resolves.toEqual({ decision: 'cancelled', reason: 'aborted' });
    expect(broker.answer('r1', { decision: 'allow-once' })).toBe(false);
  });

  it('cancelAll fecha todos os pedidos', async () => {
    const broker = new PermissionBroker();
    const a = broker.wait('a');
    const b = broker.wait('b');
    expect(broker.cancelAll('interrupt')).toEqual(['a', 'b']);
    await expect(Promise.all([a, b])).resolves.toEqual([
      { decision: 'cancelled', reason: 'interrupt' },
      { decision: 'cancelled', reason: 'interrupt' },
    ]);
  });

  it('recusa ids repetidos', async () => {
    const broker = new PermissionBroker();
    void broker.wait('r1');
    await expect(broker.wait('r1')).rejects.toThrow('repetido');
  });
});

describe('AsyncQueue', () => {
  it('entrega por ordem, espera quando vazia e termina no close', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    const seen: number[] = [];
    const reading = (async () => {
      for await (const item of queue) seen.push(item);
    })();
    queue.push(2);
    await new Promise((r) => setTimeout(r, 5));
    queue.push(3);
    queue.close();
    await reading;
    expect(seen).toEqual([1, 2, 3]);
    expect(() => queue.push(4)).toThrow();
  });
});

describe('sanitizedEnv', () => {
  it('tira as variáveis herdadas de uma sessão anfitriã e identifica a Solline', () => {
    const env = sanitizedEnv({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/c',
      ANTHROPIC_API_KEY: 'k',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_AGENT_SDK_VERSION: '1',
      ANTHROPIC_BASE_URL: 'http://localhost',
      CLAUDE_PID: '1',
      USE_LOCAL_OAUTH: '1',
    });
    expect(env).toEqual({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/c',
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'solline',
    });
  });
});
