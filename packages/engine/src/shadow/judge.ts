import type { ShadowAdvice, ShadowFinding } from '@solline/protocol';

export interface ShadowPacket {
  request: string;
  diff: string;
  checks: string;
  rules: string;
}

export type ShadowReader = (packet: ShadowPacket) => Promise<ShadowFinding[]>;

const UNAVAILABLE = 'Sem cliente de modelo. A recomendação fica por fazer.';

function advice(
  verdict: ShadowAdvice['verdict'],
  reason: string,
  findings: ShadowFinding[] = [],
): ShadowAdvice {
  return { verdict, reason, findings, canAuthorize: false };
}

function same(a: readonly ShadowFinding[], b: readonly ShadowFinding[]): boolean {
  const key = (item: ShadowFinding) => `${item.path}:${item.line ?? ''}:${item.proof}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Duas leituras do mesmo pacote. Discordar ou falhar é inconclusivo.
 * Um achado sem prova sai. Não há caminho para autorizar um envio.
 */
export async function advise(packet: ShadowPacket, reader: ShadowReader | null): Promise<ShadowAdvice> {
  if (!reader) return advice('unavailable', UNAVAILABLE);
  let first: ShadowFinding[];
  let second: ShadowFinding[];
  try {
    first = await reader(packet);
    second = await reader(packet);
  } catch {
    return advice('inconclusive', 'O juiz falhou. Isto não é uma aprovação.');
  }
  const proven = first.filter((item) => item.proof.trim().length > 0 && item.path.trim().length > 0);
  if (!same(first, second) || proven.length !== first.length) {
    return advice('inconclusive', 'As duas leituras não coincidem. Isto não é uma aprovação.');
  }
  if (proven.length === 0) {
    return advice('recommend', 'Nada a apontar nesta leitura. Não autoriza push nem merge.', []);
  }
  return advice('recommend', 'Há pontos para veres. Não autoriza push, merge nem apagar.', proven);
}

/** O pacote não leva o que o autor disse de si. */
export function packetFrom(input: {
  request: string;
  diff: string;
  checks: string;
  rules: string;
}): ShadowPacket {
  return {
    request: input.request,
    diff: input.diff,
    checks: input.checks,
    rules: input.rules,
  };
}
