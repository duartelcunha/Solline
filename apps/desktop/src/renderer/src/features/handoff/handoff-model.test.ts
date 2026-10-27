import { describe, expect, it } from 'vitest';
import {
  draftGate,
  draftNote,
  handedBanner,
  handedReason,
  handoffGate,
  handoffReducer,
  initialHandoff,
  lineageLine,
  resumeHereGate,
  sendGate,
  type HandoffState,
} from './handoff-model.ts';

describe('"Retomar aqui"', () => {
  it('só espera pelo agente a trabalhar; recuperada (em erro) ou parada, retoma', () => {
    for (const state of ['starting', 'running', 'needs-you'] as const)
      expect(resumeHereGate(state), state).toEqual({
        enabled: false,
        reason: 'A sessão ainda está ocupada',
      });
    for (const state of ['idle', 'error'] as const)
      expect(resumeHereGate(state), state).toEqual({ enabled: true, reason: null });
  });
});

const run = (state: HandoffState, ...events: Parameters<typeof handoffReducer>[1][]) =>
  events.reduce(handoffReducer, state);

const result = { text: '## Objetivo\nX', drafted: 'model' as const, cost: 0.02 };

describe('diálogo "Passar a…"', () => {
  it('só se escreve o rascunho com agente e objetivo', () => {
    const empty = initialHandoff(null);
    expect(draftGate(empty).reason).toBe('Escolhe o agente');
    expect(draftGate(initialHandoff('codex:')).reason).toBe('Diz o que o agente deve fazer');
    // Sem condições, pedir o rascunho não muda nada.
    expect(handoffReducer(initialHandoff('codex:'), { type: 'draft' }).step).toBe('form');
    const ready = run(initialHandoff('codex:'), { type: 'goal', goal: '  executa a fase 1 ' });
    expect(draftGate(ready).ok).toBe(true);
  });

  it('formulário, rascunho, edição e envio', () => {
    let s = run(
      initialHandoff('codex:'),
      { type: 'goal', goal: 'executa a fase 1' },
      { type: 'draft' },
    );
    expect(s.step).toBe('drafting');
    s = run(s, { type: 'drafted', result });
    expect(s).toMatchObject({ step: 'edit', text: result.text, drafted: 'model', cost: 0.02 });
    s = run(s, { type: 'edit', text: 'editado' });
    expect(s.text).toBe('editado');
    s = run(s, { type: 'send' });
    expect(s.step).toBe('sending');
  });

  it('cancelar o rascunho volta ao formulário sem erro; um rascunho tardio não conta', () => {
    const drafting = run(initialHandoff('codex:'), { type: 'goal', goal: 'x' }, { type: 'draft' });
    const back = run(drafting, { type: 'cancelDraft' });
    expect(back).toMatchObject({ step: 'form', error: null });
    expect(run(back, { type: 'drafted', result }).step).toBe('form');
  });

  it('uma falha do rascunho ou do envio fica à vista e deixa tentar de novo', () => {
    const drafting = run(initialHandoff('codex:'), { type: 'goal', goal: 'x' }, { type: 'draft' });
    const failed = run(drafting, { type: 'draftFailed', error: 'sem rede' });
    expect(failed).toMatchObject({ step: 'form', error: 'sem rede', goal: 'x' });
    const sending = run(failed, { type: 'draft' }, { type: 'drafted', result }, { type: 'send' });
    const retry = run(sending, { type: 'sendFailed', error: 'ocupado' });
    expect(retry).toMatchObject({ step: 'edit', error: 'ocupado', text: result.text });
  });

  it('não envia com o rascunho vazio', () => {
    const s = run(
      initialHandoff('codex:'),
      { type: 'goal', goal: 'x' },
      { type: 'draft' },
      { type: 'drafted', result },
      { type: 'edit', text: '   ' },
    );
    expect(sendGate(s).reason).toBe('O rascunho está vazio');
    expect(handoffReducer(s, { type: 'send' }).step).toBe('edit');
  });

  it('mudar de agente depois do rascunho volta ao formulário e guarda o objetivo', () => {
    const edit = run(
      initialHandoff('codex:'),
      { type: 'goal', goal: 'x' },
      { type: 'draft' },
      { type: 'drafted', result },
    );
    const other = run(edit, { type: 'choose', choice: 'claude:opus' });
    expect(other).toMatchObject({ step: 'form', goal: 'x', text: '', choice: 'claude:opus' });
  });

  it('a nota calada: mecânico ou aviso, e o custo de um rascunho de modelo', () => {
    expect(draftNote({ drafted: 'mechanical', warning: null, cost: null })).toMatch(/sem modelo/);
    expect(draftNote({ drafted: 'mechanical', warning: 'O modelo falhou.', cost: null })).toBe(
      'O modelo falhou.',
    );
    expect(draftNote({ drafted: 'model', warning: null, cost: 0 })).toBeNull();
    expect(draftNote({ drafted: 'model', warning: null, cost: 0.02 })).toMatch(/custou/);
  });
});

describe('quando se pode passar o testemunho', () => {
  it('parada, sim; a trabalhar ou já passada, não', () => {
    expect(handoffGate({ state: 'idle' })).toEqual({ enabled: true, reason: null });
    expect(handoffGate({ state: 'running' }).reason).toBe('O agente ainda está a trabalhar');
    expect(handoffGate({ state: 'idle', handedTo: 'b' }).reason).toBe(
      'Esta sessão já passou o testemunho',
    );
  });
});

describe('cabeçalho da sessão', () => {
  it('"veio de <título>" numa passagem', () => {
    expect(lineageLine({ kind: 'handoff', sessionId: 'a' }, { id: 'a', title: 'Plano' })).toEqual({
      lead: 'veio de',
      title: 'Plano',
      sessionId: 'a',
    });
  });

  it('"bifurcada do turno N" numa bifurcação', () => {
    expect(
      lineageLine({ kind: 'fork', sessionId: 'a', turnId: 't2' }, { id: 'a', title: 'Plano' }, 2),
    ).toEqual({ lead: 'bifurcada do turno 2 de', title: 'Plano', sessionId: 'a' });
    expect(lineageLine({ kind: 'fork', sessionId: 'a' }, { id: 'a', title: 'Plano' })?.lead).toBe(
      'bifurcada de',
    );
  });

  it('"consulta de" e "delegada por" nas sessões que um agente abriu', () => {
    expect(lineageLine({ kind: 'ask', sessionId: 'a' }, { id: 'a', title: 'Plano' })).toEqual({
      lead: 'consulta de',
      title: 'Plano',
      sessionId: 'a',
    });
    expect(lineageLine({ kind: 'delegate', sessionId: 'a' }, { id: 'a', title: 'Plano' })).toEqual({
      lead: 'delegada por',
      title: 'Plano',
      sessionId: 'a',
    });
    expect(lineageLine({ kind: 'delegate', sessionId: 'x' }, undefined)).toMatchObject({
      title: null,
      sessionId: null,
    });
  });

  it('origem fechada: só se lê, não se abre', () => {
    const line = lineageLine({ kind: 'handoff', sessionId: 'x' }, undefined);
    expect(line).toMatchObject({ title: null, sessionId: null });
    expect(line?.lead).toMatch(/já não está aberta/);
  });

  it('corridas, partes e tarefas não têm linha de origem', () => {
    expect(lineageLine({ kind: 'lane', raceId: 'r' }, undefined)).toBeNull();
    expect(lineageLine(undefined, undefined)).toBeNull();
  });

  it('o aviso de quem passou o testemunho', () => {
    expect(handedBanner(undefined, undefined)).toBeNull();
    const banner = handedBanner('b', { id: 'b', title: 'Fase 1' });
    expect(banner).toEqual({ text: 'Passou o testemunho a Fase 1', targetId: 'b', canOpen: true });
    expect(handedReason(banner)).toMatch(/Retomar aqui/);
    const closed = handedBanner('b', undefined);
    expect(closed).toMatchObject({ canOpen: false, targetId: null });
    expect(handedReason(closed)).toMatch(/Retomar aqui/);
  });
});
