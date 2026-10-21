import type { Finding, Quality } from '@solline/protocol';
import type { ReviewInput, Reviewer } from './reviewer.ts';

export const NO_REVIEW: Quality['review'] = {
  state: 'idle',
  turnId: null,
  findings: [],
  error: null,
};

/**
 * A segunda opinião de uma sessão: liga e desliga, revê um turno de cada vez (um turno novo
 * cancela a revisão do anterior) e avisa sempre que o estado muda.
 */
export class SessionQuality {
  #state: Quality;
  #running: AbortController | null = null;
  readonly #reviewer: Reviewer;
  readonly #emit: (quality: Quality) => void;

  constructor(options: { reviewer: Reviewer; emit: (quality: Quality) => void; enabled: boolean }) {
    this.#reviewer = options.reviewer;
    this.#emit = options.emit;
    this.#state = { enabled: options.enabled, review: NO_REVIEW };
  }

  get state(): Quality {
    return this.#state;
  }

  setEnabled(enabled: boolean): Quality {
    if (!enabled) this.#running?.abort();
    this.#set({ ...this.#state, enabled });
    return this.#state;
  }

  async review(turnId: string, input: Omit<ReviewInput, 'signal'>): Promise<void> {
    this.#running?.abort();
    const abort = new AbortController();
    this.#running = abort;
    this.#set({
      ...this.#state,
      review: { state: 'running', turnId, findings: [], error: null },
    });
    try {
      const found = await this.#reviewer({ ...input, signal: abort.signal });
      if (abort.signal.aborted) return;
      const findings = found.map((f, i): Finding => ({ ...f, id: `${turnId}-${i + 1}` }));
      this.#set({ ...this.#state, review: { state: 'done', turnId, findings, error: null } });
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#set({
        ...this.#state,
        review: { state: 'error', turnId, findings: [], error: message },
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
