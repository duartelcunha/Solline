import type { RaceLaneVerdict, RaceVerdict } from '@solline/protocol';
import type { RawFile } from '../checkpoints/unified-diff.ts';
import type { Verdict } from '../verify/judge.ts';
import { failures, type CheckVerdict } from '../verify/verify.ts';

/**
 * Ordenar uma corrida pela execução primeiro: pistas sem mudanças vão para o fim, depois menos
 * verificações partidas pela mudança, depois o consenso (quantas pistas chegaram ao mesmo patch).
 * Só o que fica empatado no topo, em soluções diferentes, vai ao juiz cego.
 */

export interface LaneOutcome {
  sessionId: string;
  files: readonly RawFile[];
  checks: readonly CheckVerdict[];
}

/** O patch sem o que não muda o comportamento (espaços nas pontas, linhas vazias, ordem dos ficheiros). */
export function patchKey(files: readonly RawFile[]): string {
  return [...files]
    .sort((a, b) => a.diff.path.localeCompare(b.diff.path))
    .map((f) => {
      const lines = f.diff.hunks.flatMap((h) =>
        h.lines
          .filter((l) => l.kind !== 'context' && l.text.trim() !== '')
          .map((l) => `${l.kind === 'add' ? '+' : '-'}${l.text.trim()}`),
      );
      return `${f.diff.path}\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

interface Scored {
  outcome: LaneOutcome;
  key: string;
  empty: boolean;
  failures: number;
  group: number;
  support: number;
}

function score(outcomes: readonly LaneOutcome[]): Scored[] {
  const keys = outcomes.map((o) => patchKey(o.files));
  const groups = new Map<string, number>();
  const support = new Map<string, number>();
  for (const key of keys) {
    if (!groups.has(key)) groups.set(key, groups.size);
    support.set(key, (support.get(key) ?? 0) + 1);
  }
  return outcomes.map((outcome, i) => {
    const key = keys[i] ?? '';
    return {
      outcome,
      key,
      empty: outcome.files.length === 0,
      failures: failures(outcome.checks),
      group: groups.get(key) ?? 0,
      support: support.get(key) ?? 1,
    };
  });
}

const compare = (a: Scored, b: Scored) =>
  Number(a.empty) - Number(b.empty) || a.failures - b.failures || b.support - a.support;

/**
 * As pistas que o juiz tem de desempatar: no topo pela execução, mas com soluções diferentes
 * (uma por grupo). Vazio ou uma só: a execução chegou.
 */
export function needsJudge(outcomes: readonly LaneOutcome[]): LaneOutcome[] {
  const scored = score(outcomes).sort(compare);
  const top = scored[0];
  if (!top || top.empty) return [];
  const tied = scored.filter((s) => compare(s, top) === 0);
  const perGroup = new Map<number, Scored>();
  for (const s of tied) if (!perGroup.has(s.group)) perGroup.set(s.group, s);
  return perGroup.size > 1 ? [...perGroup.values()].map((s) => s.outcome) : [];
}

/**
 * O veredicto: a ordem pela execução, com os empates do topo resolvidos pelo juiz. Sem juiz (ou
 * com o juiz em erro), o empate fica marcado: decides tu.
 */
export function rankLanes(
  outcomes: readonly LaneOutcome[],
  judged?: { verdict: Verdict } | { error: string },
): RaceVerdict {
  const scored = score(outcomes);
  const judgeOrder = judged && 'verdict' in judged ? judged.verdict.order : [];
  const judgePos = (s: Scored) => {
    // Uma pista herda a posição do representante do seu grupo que o juiz viu.
    const seen = scored.find(
      (o) => o.group === s.group && judgeOrder.includes(o.outcome.sessionId),
    );
    const at = seen ? judgeOrder.indexOf(seen.outcome.sessionId) : -1;
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  const ordered = [...scored].sort((a, b) => compare(a, b) || judgePos(a) - judgePos(b));
  const notes = judged && 'verdict' in judged ? judged.verdict.notes : {};
  const lanes: RaceLaneVerdict[] = ordered.map((s, i) => {
    const note =
      notes[s.outcome.sessionId] ??
      Object.entries(notes).find(([id]) =>
        scored.some((o) => o.outcome.sessionId === id && o.group === s.group),
      )?.[1];
    return {
      sessionId: s.outcome.sessionId,
      rank: i + 1,
      failures: s.failures,
      checks: s.outcome.checks.map((c) => ({
        label: c.label,
        state: c.state,
        preexisting: c.preexisting,
      })),
      group: s.group,
      empty: s.empty,
      best: note?.best ?? null,
      worst: note?.worst ?? null,
    };
  });
  const verdict = judged && 'verdict' in judged ? judged.verdict : null;
  const tied = needsJudge(outcomes).map((o) => o.sessionId);
  return {
    lanes,
    tie: verdict ? verdict.tie : tied.length ? tied : null,
    judged: verdict !== null,
    judgeError: judged && 'error' in judged ? judged.error : null,
  };
}
