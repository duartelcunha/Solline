import { describe, expect, it } from 'vitest';
import type { AskBlock, ConversationDelta, PermissionBlock, SessionState } from '@solline/protocol';
import { SessionShell, checkAnswer } from '../src/adapters/shared/session-shell.ts';

function recorder() {
  const states: SessionState[] = [];
  const errors: (string | undefined)[] = [];
  const deltas: ConversationDelta[] = [];
  const asks: AskBlock[] = [];
  return {
    states,
    errors,
    deltas,
    asks,
    sink: {
      delta: (d: ConversationDelta) => deltas.push(d),
      state: (s: SessionState, error?: string) => {
        states.push(s);
        errors.push(error);
      },
      ask: (_turnId: string, block: AskBlock) => asks.push(block),
    },
  };
}

const permission = (over: Partial<PermissionBlock> = {}): PermissionBlock => ({
  kind: 'permission',
  id: over.id ?? 'p1',
  toolName: 'Edit',
  toolUseId: 't',
  title: 'Editar a.ts',
  input: {},
  canAlwaysAllow: true,
  canAlwaysDeny: false,
  defaultToNo: false,
  status: 'pending',
  ...over,
});

describe('casca da sessão', () => {
  it('um pedido abre "precisa de ti", fecha com o estado certo e volta a "a trabalhar"', async () => {
    const r = recorder();
    const shell = new SessionShell<string>(r.sink);
    shell.turnStarted();
    const outcome = shell.ask('turn', permission(), 'rpc-1');
    expect(r.states.at(-1)).toBe('needs-you');
    expect(shell.answer('p1', { decision: 'allow-always' })).toBe(true);
    expect(await outcome).toEqual({ decision: 'allow-always' });
    expect(r.deltas.at(-1)).toMatchObject({
      type: 'block.upsert',
      block: { id: 'p1', status: 'allowed-always' },
    });
    expect(r.states.at(-1)).toBe('running');
    shell.turnEnded();
    expect(r.states.at(-1)).toBe('idle');
  });

  it('com dois pedidos abertos, continua à espera até ao último', async () => {
    const r = recorder();
    const shell = new SessionShell(r.sink);
    shell.turnStarted();
    const a = shell.ask('turn', permission({ id: 'a' }), undefined);
    const b = shell.ask('turn', permission({ id: 'b' }), undefined);
    shell.answer('a', { decision: 'deny' });
    await a;
    expect(r.states.at(-1)).toBe('needs-you');
    shell.answer('b', { decision: 'allow-once' });
    await b;
    expect(r.states.at(-1)).toBe('running');
  });

  it('a resposta tem de caber no pedido, pela mesma regra em todos os agentes', () => {
    expect(() =>
      checkAnswer(permission({ canAlwaysAllow: false }), { decision: 'allow-always' }),
    ).toThrow('Permitir sempre');
    expect(() => checkAnswer(permission(), { decision: 'deny-always' })).toThrow('Negar sempre');
    expect(() =>
      checkAnswer(permission({ canAlwaysDeny: true }), { decision: 'deny-always' }),
    ).not.toThrow();
    expect(() => checkAnswer(permission(), { decision: 'answer', answers: {} })).toThrow(
      'pergunta',
    );
  });

  it('negar sempre aparece como "Negado sempre" (o Codex perdia este estado)', async () => {
    const r = recorder();
    const shell = new SessionShell(r.sink);
    const outcome = shell.ask('turn', permission({ canAlwaysDeny: true }), undefined);
    shell.answer('p1', { decision: 'deny-always' });
    await outcome;
    expect(r.deltas.at(-1)).toMatchObject({ block: { status: 'denied-always' } });
  });

  it('uma pergunta respondida guarda as respostas no bloco', async () => {
    const r = recorder();
    const shell = new SessionShell(r.sink);
    const question: AskBlock = {
      kind: 'question',
      id: 'q1',
      questions: [],
      status: 'pending',
    } as unknown as AskBlock;
    const outcome = shell.ask('turn', question, undefined);
    shell.answer('q1', { decision: 'answer', answers: { a: 'sim' } });
    await outcome;
    expect(r.deltas.at(-1)).toMatchObject({ block: { status: 'allowed', answers: { a: 'sim' } } });
  });

  it('uma queda cancela os pedidos e fica em erro; fechar primeiro não é queda', async () => {
    const r = recorder();
    const shell = new SessionShell(r.sink);
    shell.turnStarted();
    const outcome = shell.ask('turn', permission(), undefined);
    expect(shell.crash('O Claude caiu')).toBe(true);
    expect(await outcome).toMatchObject({ decision: 'cancelled' });
    expect(r.states.at(-1)).toBe('error');
    expect(r.errors.at(-1)).toBe('O Claude caiu');
    expect(shell.crash('outra vez')).toBe(false);

    const closing = new SessionShell(recorder().sink);
    closing.close();
    expect(closing.crash('caiu ao fechar')).toBe(false);
  });

  it('o agente pode resolver um pedido sozinho; acabar o turno pode cancelar os que restam', async () => {
    const r = recorder();
    const shell = new SessionShell<number>(r.sink);
    const one = shell.ask('turn', permission({ id: 'a' }), 1);
    const two = shell.ask('turn', permission({ id: 'b' }), 2);
    shell.cancelWhere((rpc) => rpc === 1, 'resolved');
    expect(await one).toMatchObject({ decision: 'cancelled', reason: 'resolved' });
    shell.turnEnded({ cancelAsks: true });
    expect(await two).toMatchObject({ decision: 'cancelled' });
    expect(shell.answer('b', { decision: 'allow-once' })).toBe(false);
  });
});
