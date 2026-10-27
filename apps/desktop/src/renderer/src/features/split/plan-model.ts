import type { SplitPart, SplitPartSpec, SplitReview } from '@solline/protocol';

/**
 * O plano de uma repartição como se edita no cartão de cada parte: texto solto (uma linha por
 * caminho, por exemplo), que só vira contrato no fim. Tudo puro, para testar sem interface.
 */

export const MIN_PARTS = 2;
export const MAX_PARTS = 4;

export interface PartDraft {
  /** Só para a chave do React: não segue para o motor. */
  id: string;
  title: string;
  agent: string;
  model: string | null;
  /** O id da verificação do projeto (null: sem verificação, a parte não se lança). */
  check: string | null;
  zero: boolean;
  goal: string;
  /** Um caminho ou glob por linha. */
  allowed: string;
  forbidden: string;
  interfaces: string;
  expected: string;
}

export interface Base {
  agent: string;
  model: string | null;
}

let counter = 0;
export const draftId = (): string => `part-${++counter}`;

/** "A", "B", "C", "D": como as partes se nomeiam entre si. */
export const letter = (index: number): string => String.fromCharCode(65 + index);

/** "A", "A e B", "A, B e C": as partes em frase. */
export function joinLetters(indexes: readonly number[]): string {
  const names = indexes.map(letter);
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} e ${names.at(-1) as string}`;
}

/**
 * A parte A corre primeiro e sozinha? Só se é a parte zero e a revisão a deixa lançar: uma zero sem
 * verificação válida cai, e nada corre à frente das outras.
 */
export const zeroRunsFirst = (review: SplitReview, zeroFirst: boolean): boolean =>
  zeroFirst && !review.dropped.some((d) => d.index === 0);

/** O plano mudou face ao que o planeador propôs (ou ao molde)? O `id` só serve ao React. */
export function planEdited(initial: readonly PartDraft[], current: readonly PartDraft[]): boolean {
  const strip = ({ id: _id, ...rest }: PartDraft) => rest;
  return JSON.stringify(initial.map(strip)) !== JSON.stringify(current.map(strip));
}

/** Uma zona com chavetas que não fecham: o motor recusa-a, por isso diz-se antes de lançar. */
export function zoneProblem(drafts: readonly PartDraft[]): string | null {
  const open = (entry: string) => {
    let depth = 0;
    for (const c of entry) {
      if (c === '{') depth++;
      else if (c === '}' && --depth < 0) return true;
    }
    return depth !== 0;
  };
  const bad = drafts.findIndex((d) =>
    [d.allowed, d.forbidden].some((text) => text.split(/\r?\n/).some(open)),
  );
  return bad === -1 ? null : `Na parte ${letter(bad)} há uma zona com chavetas que não fecham.`;
}

export function newDraft(base: Base, check: string | null, id = draftId()): PartDraft {
  return {
    id,
    title: '',
    agent: base.agent,
    model: base.model,
    check,
    zero: false,
    goal: '',
    allowed: '',
    forbidden: '',
    interfaces: '',
    expected: '',
  };
}

/** O ponto de partida de "Partir à mão": duas partes vazias, já com a primeira verificação. */
export function templateDrafts(base: Base, check: string | null): PartDraft[] {
  return [newDraft(base, check), newDraft(base, check)];
}

const text = (lines: readonly string[]) => lines.join('\n');

/** As partes que o planeador propôs, no agente e modelo da sessão (a escolha é tua depois). */
export function draftsFromPlan(parts: readonly SplitPart[], base: Base): PartDraft[] {
  return normalize(
    parts.map((part) => ({
      id: draftId(),
      title: part.title,
      agent: base.agent,
      model: base.model,
      check: part.check,
      zero: part.zero,
      goal: part.goal,
      allowed: text(part.allowed),
      forbidden: text(part.forbidden),
      interfaces: part.interfaces,
      expected: part.expected,
    })),
  );
}

/** A parte zero só pode ser a primeira (e só uma). */
export function normalize(drafts: readonly PartDraft[]): PartDraft[] {
  return drafts.map((d, i) => (d.zero && i !== 0 ? { ...d, zero: false } : d));
}

export function addDraft(drafts: readonly PartDraft[], base: Base, check: string | null) {
  return drafts.length >= MAX_PARTS ? [...drafts] : [...drafts, newDraft(base, check)];
}

export function removeDraft(drafts: readonly PartDraft[], index: number): PartDraft[] {
  if (drafts.length <= MIN_PARTS) return [...drafts];
  // Tirar a primeira leva a parte zero consigo: a seguinte não herda o papel.
  const rest = drafts.filter((_, i) => i !== index);
  return normalize(index === 0 ? rest.map((d, i) => (i === 0 ? { ...d, zero: false } : d)) : rest);
}

export function patchDraft(
  drafts: readonly PartDraft[],
  index: number,
  patch: Partial<Omit<PartDraft, 'id'>>,
): PartDraft[] {
  return normalize(drafts.map((d, i) => (i === index ? { ...d, ...patch } : d)));
}

const lines = (value: string, limit: number): string[] =>
  [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim().slice(0, 500))
        .filter(Boolean),
    ),
  ].slice(0, limit);

/**
 * O contrato de uma parte. Um campo obrigatório vazio não bloqueia a revisão: o título fica
 * "Parte N" e o objetivo, o próprio título.
 */
export function toPart(draft: PartDraft, index: number): SplitPart {
  const title = draft.title.trim().slice(0, 200) || `Parte ${letter(index)}`;
  return {
    title,
    goal: draft.goal.trim().slice(0, 20_000) || title,
    allowed: lines(draft.allowed, 200),
    forbidden: lines(draft.forbidden, 200),
    interfaces: draft.interfaces.trim().slice(0, 20_000),
    expected: draft.expected.trim().slice(0, 20_000),
    check: draft.check,
    zero: index === 0 && draft.zero,
  };
}

/** O que a revisão (split.review) recebe: as partes e as verificações ligadas do projeto. */
export function toReviewPayload(drafts: readonly PartDraft[], checkIds: readonly string[]) {
  return { parts: drafts.map(toPart), checkIds: [...checkIds] };
}

/** O que o split.start recebe: o contrato e quem faz cada parte. */
export function toStartParts(drafts: readonly PartDraft[]): SplitPartSpec[] {
  return drafts.map((draft, index) => ({
    part: toPart(draft, index),
    agent: draft.agent,
    ...(draft.model ? { model: draft.model } : {}),
  }));
}

/** Os grupos de partes que correm uma a seguir à outra, em palavras: "B só começa quando A acaba". */
export function chainSentence(group: readonly number[]): string {
  return group
    .slice(1)
    .map((index, i) => `${letter(index)} só começa quando ${letter(group[i] as number)} acaba`)
    .join('; ');
}

/** Só as cadeias de verdade (mais de uma parte). */
export const chains = (review: SplitReview): number[][] =>
  review.sequential.filter((group) => group.length > 1);

/** Os avisos em texto que não repetem os ficheiros partilhados já mostrados à parte. */
export function visibleWarnings(review: SplitReview): string[] {
  return review.warnings.filter((w) => !review.hubs.some((hub) => w.includes(hub.path)));
}

/** Há alguma coisa a lançar? Sem partes a correr, o botão fica desligado. */
export const launchCount = (review: SplitReview | null): number => review?.costMultiplier ?? 0;
