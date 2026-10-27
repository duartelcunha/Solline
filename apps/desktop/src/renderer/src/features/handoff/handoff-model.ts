import type { SessionInfo, SessionOrigin, SessionState } from '@solline/protocol';

/** A passagem de testemunho em modelo puro: o diálogo, o cabeçalho e o que a sessão pode fazer. */

export interface HandoffDraftResult {
  text: string;
  drafted: 'model' | 'mechanical';
  warning?: string | undefined;
  cost: number | null;
}

/** form: escolher e dizer o objetivo · drafting: a escrever · edit: rever o rascunho · sending */
export type HandoffStep = 'form' | 'drafting' | 'edit' | 'sending';

export interface HandoffState {
  step: HandoffStep;
  /** A escolha de agente e modelo (a chave de laneOptions); null até haver uma. */
  choice: string | null;
  effort: string | null;
  goal: string;
  text: string;
  drafted: HandoffDraftResult['drafted'] | null;
  warning: string | null;
  cost: number | null;
  /** O que correu mal, em calmo; vazio quando está tudo bem. */
  error: string | null;
}

export type HandoffEvent =
  | { type: 'choose'; choice: string | null }
  | { type: 'effort'; effort: string | null }
  | { type: 'goal'; goal: string }
  | { type: 'draft' }
  | { type: 'drafted'; result: HandoffDraftResult }
  | { type: 'draftFailed'; error: string | null }
  | { type: 'cancelDraft' }
  | { type: 'edit'; text: string }
  | { type: 'back' }
  | { type: 'send' }
  | { type: 'sendFailed'; error: string | null };

export function initialHandoff(choice: string | null = null): HandoffState {
  return {
    step: 'form',
    choice,
    effort: null,
    goal: '',
    text: '',
    drafted: null,
    warning: null,
    cost: null,
    error: null,
  };
}

/** Pode pedir-se o rascunho? Senão, o que falta. */
export function draftGate(state: HandoffState): { ok: boolean; reason: string | null } {
  if (!state.choice) return { ok: false, reason: 'Escolhe o agente' };
  if (!state.goal.trim()) return { ok: false, reason: 'Diz o que o agente deve fazer' };
  return { ok: true, reason: null };
}

/** Pode enviar-se? O texto não pode ficar vazio. */
export function sendGate(state: HandoffState): { ok: boolean; reason: string | null } {
  if (!state.choice) return { ok: false, reason: 'Escolhe o agente' };
  if (!state.text.trim()) return { ok: false, reason: 'O rascunho está vazio' };
  return { ok: true, reason: null };
}

/**
 * A máquina de estados do diálogo. Cada evento só vale no passo certo (um rascunho que chega
 * depois de cancelar, por exemplo, não muda nada).
 */
export function handoffReducer(state: HandoffState, event: HandoffEvent): HandoffState {
  switch (event.type) {
    case 'choose':
      // Mudar de agente depois do rascunho já não serve o mesmo texto: volta ao formulário.
      if (state.step !== 'form' && state.step !== 'edit') return state;
      return {
        ...state,
        choice: event.choice,
        effort: null,
        ...(state.step === 'edit' ? { step: 'form', text: '', drafted: null, warning: null } : {}),
        error: null,
      };
    case 'effort':
      return state.step === 'form' || state.step === 'edit'
        ? { ...state, effort: event.effort }
        : state;
    case 'goal':
      return state.step === 'form' ? { ...state, goal: event.goal, error: null } : state;
    case 'draft':
      if (state.step !== 'form' || !draftGate(state).ok) return state;
      return { ...state, step: 'drafting', error: null };
    case 'drafted':
      if (state.step !== 'drafting') return state;
      return {
        ...state,
        step: 'edit',
        text: event.result.text,
        drafted: event.result.drafted,
        warning: event.result.warning ?? null,
        cost: event.result.cost,
        error: null,
      };
    case 'draftFailed':
      if (state.step !== 'drafting') return state;
      return { ...state, step: 'form', error: event.error };
    case 'cancelDraft':
      return state.step === 'drafting' ? { ...state, step: 'form', error: null } : state;
    case 'edit':
      return state.step === 'edit' ? { ...state, text: event.text } : state;
    case 'back':
      return state.step === 'edit' ? { ...state, step: 'form', error: null } : state;
    case 'send':
      if (state.step !== 'edit' || !sendGate(state).ok) return state;
      return { ...state, step: 'sending', error: null };
    case 'sendFailed':
      return state.step === 'sending' ? { ...state, step: 'edit', error: event.error } : state;
  }
}

const money = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** A nota calada por baixo do rascunho: como foi escrito (mecânico ou aviso) e o custo. */
export function draftNote(
  state: Pick<HandoffState, 'drafted' | 'warning' | 'cost'>,
): string | null {
  const parts: string[] = [];
  if (state.warning) parts.push(state.warning);
  else if (state.drafted === 'mechanical')
    parts.push(
      'Rascunho simples, sem modelo: o objetivo, o último pedido e os ficheiros. Edita à vontade.',
    );
  if (state.drafted === 'model' && state.cost !== null && state.cost > 0)
    parts.push(`O rascunho custou ${money.format(state.cost)}.`);
  return parts.length ? parts.join(' ') : null;
}

/** Pode passar-se o testemunho desta sessão agora? Senão, porquê. */
export function handoffGate(session: Pick<SessionInfo, 'state' | 'handedTo'>): {
  enabled: boolean;
  reason: string | null;
} {
  if (session.handedTo) return { enabled: false, reason: 'Esta sessão já passou o testemunho' };
  const busy: SessionState[] = ['starting', 'running', 'needs-you'];
  if (busy.includes(session.state))
    return { enabled: false, reason: 'O agente ainda está a trabalhar' };
  return { enabled: true, reason: null };
}

export interface LineageLine {
  /** O que vem antes do título: "veio de", "bifurcada do turno 2 de". */
  lead: string;
  /** O título da sessão de origem; null quando já não está aberta. */
  title: string | null;
  /** O id para a abrir; null quando já não está aberta. */
  sessionId: string | null;
}

/**
 * "veio de <título> ›" no cabeçalho de uma sessão que nasceu de outra (passagem, bifurcação,
 * consulta ou delegação).
 * `parent` é a sessão de origem se ainda estiver aberta; `turnNumber` o número do turno de onde
 * partiu a bifurcação, se se souber.
 */
export function lineageLine(
  origin: SessionOrigin | undefined,
  parent: Pick<SessionInfo, 'id' | 'title'> | undefined,
  turnNumber?: number | null,
): LineageLine | null {
  if (
    !origin ||
    (origin.kind !== 'handoff' &&
      origin.kind !== 'fork' &&
      origin.kind !== 'ask' &&
      origin.kind !== 'delegate')
  )
    return null;
  if (origin.kind === 'ask' || origin.kind === 'delegate') {
    const lead = origin.kind === 'ask' ? 'consulta de' : 'delegada por';
    return parent
      ? { lead, title: parent.title, sessionId: parent.id }
      : { lead: `${lead} uma sessão que já não está aberta`, title: null, sessionId: null };
  }
  const forked = origin.kind === 'fork';
  const turn = forked && turnNumber ? ` do turno ${turnNumber}` : '';
  if (!parent) {
    return {
      lead: forked
        ? `bifurcada${turn} de uma sessão que já não está aberta`
        : 'veio de uma sessão que já não está aberta',
      title: null,
      sessionId: null,
    };
  }
  return {
    lead: forked ? `bifurcada${turn} de` : 'veio de',
    title: parent.title,
    sessionId: parent.id,
  };
}

export interface HandedBanner {
  text: string;
  /** A sessão para onde passou; null se já não está aberta. */
  targetId: string | null;
  canOpen: boolean;
}

/** O aviso de uma sessão que passou o testemunho; null se não passou. */
export function handedBanner(
  handedTo: string | undefined,
  target: Pick<SessionInfo, 'id' | 'title'> | undefined,
): HandedBanner | null {
  if (!handedTo) return null;
  return target
    ? { text: `Passou o testemunho a ${target.title}`, targetId: target.id, canOpen: true }
    : {
        text: 'Passou o testemunho a uma sessão que já não está aberta',
        targetId: null,
        canOpen: false,
      };
}

/**
 * "Retomar aqui" só espera pelo agente desta sessão quando ele trabalha. Uma sessão recuperada
 * depois de reiniciar (ou com o agente caído) fica em erro e tem de poder retomar a pasta.
 */
export function resumeHereGate(state: SessionState): { enabled: boolean; reason: string | null } {
  const busy: SessionState[] = ['starting', 'running', 'needs-you'];
  return busy.includes(state)
    ? { enabled: false, reason: 'A sessão ainda está ocupada' }
    : { enabled: true, reason: null };
}

/** Porque é que o compositor está desligado numa sessão que passou o testemunho. */
export function handedReason(banner: HandedBanner | null): string | null {
  if (!banner) return null;
  return banner.canOpen
    ? `${banner.text}. Escreve lá, ou carrega em "Retomar aqui".`
    : `${banner.text}. Carrega em "Retomar aqui" para voltar a escrever.`;
}
