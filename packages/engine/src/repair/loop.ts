import type { RepairView } from '@solline/protocol';

export const MAX_FIXES = 3;

export interface CheckRound {
  id: string;
  state: 'pending' | 'running' | 'passed' | 'failed' | 'timeout';
  tail: string | null;
}

export interface RoundInput {
  turnId: string | null;
  outcomes: readonly CheckRound[];
}

const INFRA = /command not found|não encontrei|ENOENT|spawn /i;

function fingerprint(failed: readonly CheckRound[]): string {
  return failed.map((item) => `${item.id}\n${item.tail ?? ''}`).join('\n---\n');
}

function infra(item: CheckRound): boolean {
  return item.state === 'timeout' || INFRA.test(item.tail ?? '');
}

/** Ciclo opt-in. Não faz push e não declara feito sem uma ronda verde. */
export class RepairLoop {
  #enabled = false;
  #fixes = 0;
  #equivalent = 0;
  #state: RepairView['state'] = 'off';
  #reason: string | null = null;
  #proofTurnId: string | null = null;
  #last: string | null = null;
  #baseline: string | null = null;

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    this.#fixes = 0;
    this.#equivalent = 0;
    this.#last = null;
    this.#baseline = null;
    this.#proofTurnId = null;
    this.#state = enabled ? 'watching' : 'off';
    this.#reason = enabled ? null : 'Desligado.';
  }

  cancel(): void {
    this.#enabled = false;
    this.#state = 'stopped';
    this.#reason = 'Paraste o ciclo. Não houve push.';
  }

  /**
   * Olha para uma ronda já terminada. Não conta a correção: isso é `markSent`,
   * depois de a mensagem ter seguido.
   */
  see(input: RoundInput): { fixId: string | null } {
    if (!this.#enabled || this.#state === 'stopped' || this.#state === 'done' || this.#state === 'off') {
      return { fixId: null };
    }
    if (input.outcomes.some((item) => item.state === 'running' || item.state === 'pending')) {
      return { fixId: null };
    }
    const failed = input.outcomes.filter((item) => item.state === 'failed' || item.state === 'timeout');
    if (failed.some(infra)) {
      this.#state = 'stopped';
      this.#reason = 'Falha de infraestrutura. Não repito a mesma correção.';
      return { fixId: null };
    }
    if (failed.length === 0) {
      this.#state = 'done';
      this.#proofTurnId = input.turnId;
      this.#reason = 'As verificações passaram neste turno. Não houve push.';
      return { fixId: null };
    }
    const print = fingerprint(failed);
    if (this.#baseline === null) this.#baseline = print;
    this.#equivalent = print === this.#last ? this.#equivalent + 1 : 1;
    this.#last = print;
    if (this.#equivalent >= 2) {
      this.#state = 'stopped';
      this.#reason = 'A mesma falha voltou duas vezes, sem progresso.';
      return { fixId: null };
    }
    if (this.#fixes >= MAX_FIXES) {
      this.#state = 'stopped';
      this.#reason = 'Já houve 3 correções. O ciclo para.';
      return { fixId: null };
    }
    this.#state = 'fixing';
    this.#reason = `Correção ${this.#fixes + 1} de 3. Não faz push.`;
    return { fixId: failed[0]?.id ?? null };
  }

  markSent(): void {
    if (this.#state !== 'fixing') return;
    this.#fixes += 1;
  }

  view(): RepairView {
    return {
      enabled: this.#enabled,
      fixes: this.#fixes,
      equivalent: this.#equivalent,
      state: this.#state,
      reason: this.#reason,
      proofTurnId: this.#proofTurnId,
    };
  }
}
