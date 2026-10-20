import type { ConversationDelta } from '@solline/protocol';

/** A vez de quem escreve, igual para todos os agentes. */
export function userTurnDelta(turnId: string, text: string): ConversationDelta {
  return {
    type: 'turn.start',
    turn: {
      id: turnId,
      role: 'user',
      blocks: [{ kind: 'text', id: `${turnId}:text`, text, parentToolId: null }],
    },
  };
}

/** Aviso calmo para o fim de um turno interrompido. */
export function interruptedNotice(turnId: string): ConversationDelta {
  return {
    type: 'block.upsert',
    turnId,
    block: {
      kind: 'notice',
      id: `${turnId}:interrupted`,
      tone: 'info',
      text: 'Interrompeste aqui.',
    },
  };
}

export function errorNotice(turnId: string, text: string, key = 'error'): ConversationDelta {
  return {
    type: 'block.upsert',
    turnId,
    block: { kind: 'notice', id: `${turnId}:${key}`, tone: 'error', text },
  };
}

export function crashMessage(label: string): string {
  return `A ligação ao ${label} caiu. A conversa está guardada: podes retomar.`;
}

/** Junta um resultado a um tempo limite, com uma mensagem que diz o que ficou sem resposta. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what}: sem resposta em ${ms / 1000} s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
