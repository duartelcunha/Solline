import type {
  Finding,
  Quality,
  QualityStats,
  ReviewTrigger,
  ReviewerInfo,
} from '@solline/protocol';
import { projectFindings, type ReviewInput, type Reviewer } from './reviewer.ts';

export const NO_REVIEW: Quality['review'] = {
  state: 'idle',
  turnId: null,
  findings: [],
  error: null,
};

const NO_STATS: QualityStats = { fixed: 0, dismissed: 0, total: 0 };

/** Quem reviu e porquê: vai para o resultado da revisão. */
export interface ReviewMeta {
  trigger?: ReviewTrigger | undefined;
  reviewer?: ReviewerInfo | undefined;
}

/**
 * A segunda opinião de uma sessão: liga e desliga, revê um turno de cada vez (um turno novo
 * cancela a revisão do anterior) e avisa sempre que o estado muda.
 */
export class SessionQuality {
  #state: Quality;
  #running: AbortController | null = null;
  readonly #reviewer: Reviewer | undefined;
  readonly #emit: (quality: Quality) => void;

  constructor(options: {
    /** O revisor por omissão; cada revisão pode trazer o seu (o do fabricante oposto). */
    reviewer?: Reviewer | undefined;
    emit: (quality: Quality) => void;
    enabled: boolean;
    recovery?: Quality;
  }) {
    this.#reviewer = options.reviewer;
    this.#emit = options.emit;
    this.#state = options.recovery ?? {
      available: true,
      enabled: options.enabled,
      review: NO_REVIEW,
      stats: NO_STATS,
    };
  }

  get state(): Quality {
    return this.#state;
  }

  setEnabled(enabled: boolean): Quality {
    if (enabled) {
      this.#set({ ...this.#state, enabled });
    } else {
      // Uma revisão a meio deixa de valer: não fica "a rever" para sempre.
      this.#running?.abort();
      this.#set({ ...this.#state, enabled, review: NO_REVIEW });
    }
    return this.#state;
  }

  /** Esquece o que foi revisto (o turno saiu da conversa ou os ficheiros voltaram atrás). */
  reset(): void {
    this.#running?.abort();
    if (this.#state.review !== NO_REVIEW) this.#set({ ...this.#state, review: NO_REVIEW });
  }

  /**
   * Revê um turno. A vaga fica reservada logo (um turno mais novo cancela este, mesmo que o
   * diff ainda esteja a chegar); prepare devolve null quando não há nada para rever.
   */
  async review(
    turnId: string,
    prepare: () => Promise<Omit<ReviewInput, 'signal'> | null>,
    meta: ReviewMeta = {},
    reviewer: Reviewer | undefined = this.#reviewer,
  ): Promise<void> {
    const who = {
      ...(meta.trigger ? { trigger: meta.trigger } : {}),
      ...(meta.reviewer ? { reviewer: meta.reviewer } : {}),
    };
    this.#running?.abort();
    const abort = new AbortController();
    this.#running = abort;
    this.#set({
      ...this.#state,
      review: { state: 'running', turnId, findings: [], error: null, ...who },
    });
    try {
      const input = await prepare();
      if (abort.signal.aborted) return;
      if (!input) {
        this.#set({ ...this.#state, review: NO_REVIEW });
        return;
      }
      if (!reviewer) throw new Error('Não há revisor disponível');
      const found = projectFindings(
        await reviewer({ ...input, signal: abort.signal }),
        input.cwd,
        input.diff,
      );
      if (abort.signal.aborted) return;
      const findings = found.map((f, i): Finding => ({
        ...f,
        id: `${turnId}-${i + 1}`,
        status: 'open',
      }));
      this.#set({
        ...this.#state,
        review: { state: 'done', turnId, findings, error: null, ...who },
        stats: { ...this.#state.stats, total: this.#state.stats.total + findings.length },
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#set({
        ...this.#state,
        review: { state: 'error', turnId, findings: [], error: message, ...who },
      });
    } finally {
      if (this.#running === abort) this.#running = null;
    }
  }

  /** Os achados com estes ids, pela ordem do revisor. */
  pick(ids: readonly string[]): Finding[] {
    const wanted = new Set(ids);
    return this.#state.review.findings.filter((f) => wanted.has(f.id));
  }

  /**
   * Marca achados como corrigidos ou descartados e conta o que mudou de facto (um achado já
   * resolvido não conta duas vezes). Devolve o estado novo.
   */
  resolve(ids: readonly string[], status: 'fixed' | 'dismissed'): Quality {
    const wanted = new Set(ids);
    const stats = { ...this.#state.stats };
    let changed = false;
    const findings = this.#state.review.findings.map((f) => {
      if (!wanted.has(f.id) || f.status === status) return f;
      changed = true;
      stats[status]++;
      if (f.status !== 'open') stats[f.status]--;
      return { ...f, status };
    });
    if (!changed) return this.#state;
    this.#set({ ...this.#state, review: { ...this.#state.review, findings }, stats });
    return this.#state;
  }

  dispose(): void {
    this.#running?.abort();
  }

  #set(next: Quality): void {
    this.#state = next;
    this.#emit(next);
  }
}

const LABEL: Record<Finding['severity'], string> = { bug: 'erro', risk: 'risco', slop: 'ruído' };

/** A mensagem que segue para o agente quando pedes para corrigir achados. */
export function fixMessage(findings: readonly Finding[]): string {
  const items = findings.map((f, i) => {
    const where = f.line ? `${f.path}:${f.line}` : f.path;
    return `${i + 1}. [${LABEL[f.severity]}] ${where}: ${f.title}${f.detail ? `\n   ${f.detail}` : ''}`;
  });
  return [
    'Um revisor leu o teu último turno e encontrou isto. Corrige o que fizer sentido; se discordares de algum, diz porquê numa frase.',
    '',
    ...items,
  ].join('\n');
}
