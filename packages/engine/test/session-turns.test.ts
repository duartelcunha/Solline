import { describe, expect, it } from 'vitest';
import type { SessionQueue } from '@solline/protocol';
import { SessionTurns } from '../src/session-turns.ts';

/** Um agente de mentira: começa a trabalhar ao receber uma mensagem e para quando o teste mandar. */
function setup(options: { steer?: 'joined' | 'too-late' } = {}) {
  let running = false;
  const started: string[] = [];
  const steered: string[] = [];
  const queues: SessionQueue[] = [];
  const turns = new SessionTurns({
    start: async (text) => {
      started.push(text);
      running = true;
      return `turn-${started.length}`;
    },
    ...(options.steer
      ? {
          steer: async (text: string) => {
            steered.push(text);
            return options.steer as 'joined' | 'too-late';
          },
        }
      : {}),
    running: () => running,
    emit: (q) => queues.push(q),
  });
  /** O agente parou: o dono do turno decide se segue o próximo da fila. */
  const stop = () => {
    running = false;
    return turns.settled();
  };
  return { turns, started, steered, queues, stop, last: () => queues.at(-1) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('o dono do turno', () => {
  it('parado segue logo; ocupado vai para a fila, em ordem, sem parar entre itens', async () => {
    const { turns, started, stop, last } = setup();
    expect(await turns.submit('um')).toEqual({ turnId: 'turn-1', how: 'sent' });
    expect(await turns.submit('dois')).toMatchObject({ how: 'queued' });
    expect(await turns.submit('três')).toMatchObject({ how: 'queued' });
    expect(last()?.items.map((i) => i.text)).toEqual(['dois', 'três']);

    // O agente parou com fila: o próximo segue e a sessão não chega a ficar parada.
    expect(stop()).toBe(true);
    await tick();
    expect(started).toEqual(['um', 'dois']);
    expect(stop()).toBe(true);
    await tick();
    expect(started).toEqual(['um', 'dois', 'três']);
    // Sem fila, parar é parar.
    expect(stop()).toBe(false);
  });

  it('interromper pausa a fila; continuar retoma', async () => {
    const { turns, started, stop, last } = setup();
    await turns.submit('um');
    await turns.submit('dois');
    turns.interrupted();
    expect(last()?.paused).toBe(true);
    expect(stop()).toBe(false);
    expect(started).toEqual(['um']);
    turns.resume();
    await tick();
    expect(started).toEqual(['um', 'dois']);
  });

  it('guiar junta-se ao turno; tarde de mais passa à frente da fila', async () => {
    const joined = setup({ steer: 'joined' });
    await joined.turns.submit('um');
    expect(await joined.turns.submit('olha também isto', 'now')).toMatchObject({ how: 'steered' });
    expect(joined.steered).toEqual(['olha também isto']);
    expect(joined.turns.queue.items).toEqual([]);

    const late = setup({ steer: 'too-late' });
    await late.turns.submit('um');
    await late.turns.submit('depois');
    expect(await late.turns.submit('urgente', 'now')).toMatchObject({ how: 'queued' });
    expect(late.last()?.items.map((i) => i.text)).toEqual(['urgente', 'depois']);
  });

  it('sem steer no agente, "agora" vai para a fila', async () => {
    const { turns } = setup();
    await turns.submit('um');
    expect(await turns.submit('agora', 'now')).toMatchObject({ how: 'queued' });
  });

  it('o que chega durante uma ação exclusiva segue quando ela acaba', async () => {
    const { turns, started } = setup();
    let release: () => void = () => undefined;
    const action = turns.exclusive('trazer', () => new Promise<void>((r) => (release = r)));
    expect(await turns.submit('depois de trazer')).toMatchObject({ how: 'queued' });
    release();
    await action;
    await tick();
    expect(started).toEqual(['depois de trazer']);
  });

  it('um envio da fila que falha preserva o texto e exige retoma explícita', async () => {
    let fail = true;
    const started: string[] = [];
    const turns = new SessionTurns({
      start: async (t) => {
        if (fail) {
          fail = false;
          throw new Error('caiu');
        }
        started.push(t);
        return 'turn';
      },
      running: () => false,
      emit: () => undefined,
    });
    turns.hold();
    await turns.submit('um');
    await turns.submit('dois');
    turns.release();
    await tick();
    await tick();
    expect(started).toEqual([]);
    expect(turns.queue.paused).toBe(true);
    expect(turns.queue.items.map((item) => item.text)).toEqual(['um', 'dois']);
    expect(turns.settled()).toBe(false);
    turns.resume();
    await tick();
    expect(started).toEqual(['um']);
  });

  it('tirar, reordenar e o exclusivo que recusa a meio', async () => {
    const { turns, stop } = setup();
    await turns.submit('um');
    const a = await turns.submit('a');
    const b = await turns.submit('b');
    turns.reorder([b.turnId, a.turnId]);
    expect(turns.queue.items.map((i) => i.text)).toEqual(['b', 'a']);
    turns.unqueue(b.turnId);
    expect(turns.queue.items.map((i) => i.text)).toEqual(['a']);
    await expect(turns.exclusive('rebobinar', async () => 1)).rejects.toThrow(/antes de rebobinar/);
    turns.clear();
    stop();
    expect(await turns.exclusive('rebobinar', async () => 1)).toBe(1);
  });
});
