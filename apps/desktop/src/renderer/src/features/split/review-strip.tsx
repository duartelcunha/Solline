import { useState } from 'react';
import { ArrowRight, FileWarning } from 'lucide-react';
import type { SplitReview } from '@solline/protocol';
import {
  chainSentence,
  chains,
  joinLetters,
  letter,
  visibleWarnings,
  zeroRunsFirst,
} from './plan-model.ts';

/**
 * A conferência do plano, ao vivo e sem gastar nada: que partes esperam por outras, os ficheiros
 * que mais de uma pode tocar e os avisos. Os grupos que correm em fila vêm como uma seta curta.
 */
export function ReviewStrip({
  review,
  zeroFirst,
}: {
  review: SplitReview | null;
  /** A primeira parte é a zero. Só se diz que corre sozinha se ela de facto se lança. */
  zeroFirst: boolean;
}) {
  const [all, setAll] = useState(false);
  if (!review) return null;
  const waiting = chains(review);
  const warnings = visibleWarnings(review);
  const shown = all ? warnings : warnings.slice(0, 3);
  const nothing = waiting.length === 0 && review.hubs.length === 0 && warnings.length === 0;
  const zeroRuns = zeroRunsFirst(review, zeroFirst);
  return (
    <div className="flex flex-col gap-2 text-[12.5px]" data-testid="split-review">
      {zeroRuns ? (
        <p className="text-muted" data-testid="split-review-zero">
          A parte A corre primeiro e sozinha; as outras começam quando ela acabar.
        </p>
      ) : null}
      {waiting.map((group) => (
        <div
          key={group.join('-')}
          className="flex flex-wrap items-center gap-x-3 gap-y-1"
          data-testid="split-chain"
        >
          <span className="inline-flex items-center gap-1.5 font-medium" aria-hidden>
            {group.map((index, i) => (
              <span key={index} className="inline-flex items-center gap-1.5">
                {i > 0 ? <ArrowRight size={12} className="text-subtle" /> : null}
                <span className="grid size-5 place-items-center rounded-full bg-surface-sunken text-[11px]">
                  {letter(index)}
                </span>
              </span>
            ))}
          </span>
          <span className="text-muted">{chainSentence(group)}</span>
        </div>
      ))}
      {review.hubs.map((hub) => (
        <p
          key={hub.path}
          className="inline-flex items-start gap-1.5 text-muted"
          data-testid="split-hub"
        >
          <FileWarning size={13} className="mt-px shrink-0 text-accent-text" aria-hidden />
          <span>
            <span className="font-mono text-[11.5px] text-fg">{hub.path}</span> pode ser tocado por{' '}
            {joinLetters(hub.parts)}.
          </span>
        </p>
      ))}
      {shown.map((warning) => (
        <p key={warning} className="text-muted" data-testid="split-warning-text">
          {warning}
        </p>
      ))}
      {!all && warnings.length > shown.length ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          aria-label={
            warnings.length - shown.length === 1
              ? 'Mostrar mais um aviso'
              : `Mostrar mais ${warnings.length - shown.length} avisos`
          }
          className="sl-press self-start rounded-md px-1.5 py-0.5 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
        >
          +{warnings.length - shown.length}
        </button>
      ) : null}
      {nothing && !zeroRuns ? (
        <p className="text-muted">As partes não se tocam: correm ao mesmo tempo.</p>
      ) : null}
    </div>
  );
}
