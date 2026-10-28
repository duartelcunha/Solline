import type { ConsultKind, ConsultRequest } from '@solline/protocol';

/** O que o cartão de «Perguntar a…» e «Delegar» diz, sem tocar em React (testa-se em Node). */
export interface ConsultCopy {
  /** A frase do cartão, como o motor a escreveu: «O Claude quer perguntar ao Codex». */
  title: string;
  /** O que o utilizador está a ler: a pergunta ou a tarefa. */
  textLabel: string;
  /** O que acontece se permitires, numa linha. */
  effect: string;
  /** Avisos que o utilizador tem de ver antes de decidir. */
  notes: string[];
  /** Para delegar: o agente e o modo da sessão nova. */
  facts: { label: string; value: string }[];
}

/** O modo que a sessão delegada vai ter, como o cartão o mostra. */
export function delegateModeLabel(request: ConsultRequest): string {
  return request.mode?.label ?? 'o modo por omissão do agente';
}

export function consultCopy(
  request: ConsultRequest,
  agentLabel: (id: string) => string,
): ConsultCopy {
  const to = agentLabel(request.to);
  if (request.kind === 'ask') {
    return {
      title: request.summary,
      textLabel: `Pergunta do ${agentLabel(request.from)}`,
      effect: 'Abre uma sessão só de leitura, na mesma pasta. Tu vês a conversa e a resposta.',
      notes: request.sameVendor
        ? [
            `Não há outro fabricante pronto: a pergunta vai a ${to}, do mesmo fabricante, por isso não é uma segunda opinião independente.`,
          ]
        : [],
      facts: [],
    };
  }
  return {
    title: request.summary,
    textLabel: 'Tarefa a entregar',
    effect:
      'Abre uma sessão nova, com o seu próprio branch. O resultado só entra no projeto quando o trouxeres.',
    notes: [],
    facts: [
      { label: 'Agente', value: to },
      { label: 'Modo', value: delegateModeLabel(request) },
      ...(request.title ? [{ label: 'Título', value: request.title }] : []),
    ],
  };
}

/** Na mesa só cabem os botões simples: delegar abre sempre a sessão, para ver o modo e o texto. */
export function deskCanAllowDirectly(kind: ConsultKind): boolean {
  return kind === 'ask';
}

/** O pedido mais antigo à espera (a fila de cartões responde-se pela ordem em que chegaram). */
export function firstConsult(consults: readonly ConsultRequest[]): ConsultRequest | null {
  return consults[0] ?? null;
}
