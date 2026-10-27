import type { EngineEvent, Race } from '@solline/protocol';

/**
 * O registo das corridas e das repartições: um só sítio onde vivem, se gravam e se anunciam
 * (`race.state`). Os dois gestores escrevem aqui, cada um nas suas; `race.get`, a recuperação e
 * o fecho não distinguem uma de outra.
 */
export class RaceRegistry {
  readonly #races = new Map<string, Race>();
  readonly #emit: (event: EngineEvent) => void;

  constructor(emit: (event: EngineEvent) => void) {
    this.#emit = emit;
  }

  add(race: Race): void {
    this.#races.set(race.id, race);
  }

  get(raceId: string): Race {
    const race = this.#races.get(raceId);
    if (!race) throw new Error('Corrida desconhecida');
    return race;
  }

  all(): Race[] {
    return [...this.#races.values()];
  }

  /** Cópia para gravar: o que se grava nunca muda por baixo. */
  recovery(): Race[] {
    return structuredClone(this.all());
  }

  /** Anuncia o estado atual (uma cópia: quem ouve não mexe no registo). */
  changed(race: Race): void {
    this.#emit({ kind: 'event', type: 'race.state', race: structuredClone(race) });
  }
}
