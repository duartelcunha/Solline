import {
  rankFindings,
  type Finding,
  type FindingPriority,
  type Quality,
  type QualityReview,
  type QualityStats,
  type ReviewScope,
  type ReviewTrigger,
} from '@solline/protocol';

/** Os achados em modelo puro: o que se mostra, o que fica dobrado e como se lê cada coisa. */

/** Os achados por decidir: os descartados nunca se mostram. */
export function openFindings<T extends { status?: Finding['status'] }>(
  findings: readonly T[],
): T[] {
  return findings.filter((f) => (f.status ?? 'open') !== 'dismissed');
}

/** À vista (no máximo 5, os mais seguros e graves) e dobrados (o resto, por abrir). */
export function groupFindings<T extends Finding>(
  findings: readonly T[],
): { shown: T[]; folded: T[] } {
  return rankFindings(findings);
}

/** "3 corrigidos · 1 dispensado"; null quando ainda não houve nenhum. */
export function statsLabel(stats: Pick<QualityStats, 'fixed' | 'dismissed'>): string | null {
  const parts: string[] = [];
  if (stats.fixed > 0)
    parts.push(`${stats.fixed} ${stats.fixed === 1 ? 'corrigido' : 'corrigidos'}`);
  if (stats.dismissed > 0)
    parts.push(`${stats.dismissed} ${stats.dismissed === 1 ? 'dispensado' : 'dispensados'}`);
  return parts.length ? parts.join(' · ') : null;
}

/** "N achados menos certos" (o texto do dobrado). */
export function foldLabel(count: number): string {
  return count === 1 ? '1 achado menos certo' : `${count} achados menos certos`;
}

export const TRIGGER_LABEL: Record<ReviewTrigger, string> = {
  turn: 'depois do turno',
  bring: 'antes de trazer',
  manual: 'a pedido',
};

/** P0 é o mais grave, P3 o menos. */
export function priorityLabel(priority: FindingPriority): string {
  return `P${priority}`;
}

/** A confiança do revisor como percentagem inteira, em pt-PT ("90 %"). */
export function confidenceLabel(confidence: number): string {
  return `${Math.round(Math.min(Math.max(confidence, 0), 1) * 100)} %`;
}

/** O nome de um fornecedor para a interface: o do agente conhecido, ou o próprio texto. */
export function vendorName(
  vendor: string,
  agents: readonly { id: string; label: string }[] = [],
): string {
  const found = agents.find((a) => a.id === vendor)?.label;
  if (found) return found;
  return vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : 'revisor';
}

export interface ReviewByline {
  /** "Revisto por Codex · gpt-5.5". */
  by: string;
  /** Quando foi pedida: "depois do turno", "antes de trazer", "a pedido". */
  when: string | null;
  /** O revisor é do mesmo fabricante que escreveu: a segunda opinião vale menos. */
  sameVendor: boolean;
}

/** Quem reviu e porquê, para o cabeçalho do resultado; null se o motor não o disse. */
export function reviewByline(
  review: Pick<QualityReview, 'reviewer' | 'trigger'>,
  agents: readonly { id: string; label: string }[] = [],
): ReviewByline | null {
  const { reviewer, trigger } = review;
  if (!reviewer) return null;
  const name = vendorName(reviewer.vendor, agents);
  return {
    by: `Revisto por ${name}${reviewer.model ? ` · ${reviewer.model}` : ''}`,
    when: trigger ? TRIGGER_LABEL[trigger] : null,
    sameVendor: reviewer.sameVendor,
  };
}

export type ReviewPhase = 'unavailable' | 'off' | 'idle' | 'running' | 'error' | 'clean' | 'found';

/** O estado do revisor numa palavra. 'clean' também vale quando só há achados dobrados. */
export function reviewPhase(quality: Quality | null): ReviewPhase {
  if (!quality?.available) return 'unavailable';
  const { review } = quality;
  if (review.state === 'running') return 'running';
  if (review.state === 'error') return 'error';
  if (review.state === 'done') {
    const shown = groupFindings(review.findings).shown.length;
    // Com o revisor desligado e nada a mostrar, é o desligado que se lê (não um "limpo").
    if (!quality.enabled && shown === 0) return 'off';
    return shown > 0 ? 'found' : 'clean';
  }
  return quality.enabled ? 'idle' : 'off';
}

/** Pode pedir-se já uma segunda opinião? Senão, porquê (para o título do botão desligado). */
export function secondOpinionGate(
  quality: Quality | null,
  options: { busy: boolean; hasFinishedTurn: boolean },
): { enabled: boolean; reason: string | null } {
  if (!quality?.available) return { enabled: false, reason: 'O revisor não está disponível' };
  if (quality.review.state === 'running')
    return { enabled: false, reason: 'Já há uma revisão a decorrer' };
  if (options.busy) return { enabled: false, reason: 'O agente ainda está a trabalhar' };
  if (!options.hasFinishedTurn)
    return { enabled: false, reason: 'Ainda não há nenhum turno acabado' };
  return { enabled: true, reason: null };
}

export const SCOPE_CHOICES: { scope: ReviewScope; title: string; description: string }[] = [
  { scope: 'turn', title: 'Este turno', description: 'Só o que o último turno mudou' },
  { scope: 'session', title: 'Toda a sessão', description: 'Tudo o que a sessão mudou até agora' },
];

/** O resumo de uma frase de uma revisão, para quando não há achados à vista. */
export function reviewHeadline(quality: Quality): {
  tone: 'calm' | 'progress' | 'error' | 'found' | 'idle';
  text: string;
} {
  const { review } = quality;
  const folded = groupFindings(review.findings).folded.length;
  switch (reviewPhase(quality)) {
    case 'running':
      return { tone: 'progress', text: 'A rever…' };
    case 'error':
      return { tone: 'error', text: `A revisão falhou: ${review.error ?? 'sem detalhe'}` };
    case 'clean':
      return {
        tone: 'calm',
        text: folded > 0 ? 'Sem achados certos' : 'Sem achados',
      };
    case 'found': {
      const n = groupFindings(review.findings).shown.length;
      return { tone: 'found', text: n === 1 ? '1 achado' : `${n} achados` };
    }
    case 'off':
      return { tone: 'idle', text: 'Revisor desligado' };
    default:
      return { tone: 'idle', text: 'Ainda sem revisão' };
  }
}
