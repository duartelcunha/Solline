import type { LedgerView } from '@solline/protocol';

/** Nunca mostra um valor em falta como zero. */
export function shownAmount(value: number | null, format: (value: number) => string): string {
  return value === null ? 'desconhecido' : format(value);
}

/** Há um número reportado, incluindo zero. Tudo null não é uma leitura. */
export function hasReading(ledger: LedgerView | null): boolean {
  if (!ledger) return false;
  const numbers = [
    ledger.total,
    ...ledger.executions.flatMap((item) => [item.last, item.spent]),
  ];
  return numbers.some((snapshot) =>
    [snapshot.freshInput, snapshot.cachedInput, snapshot.output, snapshot.costUsd].some(
      (value) => value !== null,
    ),
  );
}
