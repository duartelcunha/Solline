import { createHash } from 'node:crypto';
import type { RaceCandidate, RaceProposal, RaceProposalFile, RaceSlot } from '@solline/protocol';
import { hunkPatch, type RawFile, type RawHunk } from '../checkpoints/unified-diff.ts';
import { changedLines } from './rank.ts';

/**
 * Montar o resultado a partir de várias pistas, pedaço a pedaço. Cada pedaço (hunk) de cada pista
 * cai numa zona do ficheiro; pedaços que se tocam na base são alternativas (só um entra), e os
 * que não se tocam somam-se. Pedaços iguais em várias pistas (sem contar espaços) são um só
 * candidato com mais votos. A escolha de partida é a mais votada, ou a da pista melhor ordenada.
 */

export interface AssemblyLane {
  sessionId: string;
  /** 1 é a melhor (a ordem do veredicto). */
  rank: number;
  files: readonly RawFile[];
}

/** Um pedaço pronto a aplicar: o patch em bytes, tal como o git o escreveu. */
export interface Part {
  id: string;
  slot: string;
  path: string;
  oldStart: number;
  patch: Buffer;
  label: string;
}

export interface Assembly {
  proposal: RaceProposal;
  parts: ReadonlyMap<string, Part>;
}

interface Entry {
  lane: AssemblyLane;
  file: RawFile;
  raw: RawHunk;
  start: number;
  end: number;
  key: string;
}

const digest = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);

export function propose(lanes: readonly AssemblyLane[]): Assembly {
  const bestRank = Math.min(...lanes.map((l) => l.rank));
  const byPath = new Map<string, Entry[]>();
  const skipped = new Map<string, { path: string; reason: string }>();
  const skip = (path: string, reason: string) =>
    skipped.set(`${path}\0${reason}`, { path, reason });

  for (const lane of lanes) {
    for (const file of lane.files) {
      const { path } = file.diff;
      if (file.diff.binary) skip(path, 'Ficheiro binário');
      else if (file.diff.truncated) skip(path, 'Grande demais para montar pedaço a pedaço');
      else if (file.hunks.length === 0) skip(path, 'Só mudou o modo');
      else
        for (const raw of file.hunks) {
          const entries = byPath.get(path) ?? [];
          entries.push({
            lane,
            file,
            raw,
            start: raw.hunk.oldStart,
            end: raw.hunk.oldStart + raw.hunk.oldLines,
            key: digest(`${file.diff.status}\0${changedLines(raw.hunk).join('\n')}`),
          });
          byPath.set(path, entries);
        }
    }
  }

  const parts = new Map<string, Part>();
  const files: RaceProposalFile[] = [];
  for (const path of [...byPath.keys()].sort()) {
    const slots: RaceSlot[] = [];
    for (const cluster of clusters(byPath.get(path) ?? [])) {
      const start = Math.min(...cluster.map((e) => e.start));
      const slot = `${path}:${start}`;
      // Os candidatos: o mesmo conteúdo escrito por várias pistas é um só.
      const candidates = new Map<string, Entry[]>();
      for (const entry of [...cluster].sort((a, b) => a.lane.rank - b.lane.rank))
        candidates.set(entry.key, [...(candidates.get(entry.key) ?? []), entry]);
      const ranked = [...candidates.values()].map((entries) => ({
        entries,
        lanes: [...new Set(entries.map((e) => e.lane.sessionId))],
        rank: Math.min(...entries.map((e) => e.lane.rank)),
      }));
      const winner = [...ranked].sort(
        (a, b) => b.lanes.length - a.lanes.length || a.rank - b.rank,
      )[0];
      const built: RaceCandidate[] = ranked
        .sort((a, b) => a.rank - b.rank)
        .map((candidate) => {
          const first = candidate.entries[0] as Entry;
          const id = `${slot}:${first.key}`;
          parts.set(id, {
            id,
            slot,
            path,
            oldStart: first.start,
            patch: hunkPatch(first.file, first.raw),
            label: `${path} (linha ${first.start})`,
          });
          return {
            id,
            lanes: candidate.lanes,
            hunk: first.raw.hunk,
            // Entra de partida o que várias pistas repetem ou o que a melhor pista escreveu.
            preferred:
              candidate === winner && (candidate.lanes.length >= 2 || candidate.rank === bestRank),
          };
        });
      slots.push({ id: slot, candidates: built });
    }
    const status = (byPath.get(path) as Entry[])[0]?.file.diff.status ?? 'modified';
    files.push({ path, status, slots });
  }
  return { proposal: { files, skipped: [...skipped.values()] }, parts };
}

/** Pedaços que se tocam (contando o contexto) ficam na mesma zona. */
function clusters(entries: readonly Entry[]): Entry[][] {
  const out: Entry[][] = [];
  let end = -1;
  for (const entry of [...entries].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && entry.start <= end) {
      last.push(entry);
      end = Math.max(end, entry.end);
    } else {
      out.push([entry]);
      end = entry.end;
    }
  }
  return out;
}

/**
 * Os patches das escolhas, prontos a aplicar. Uma escolha só por zona. De baixo para cima em
 * cada ficheiro: aplicar um pedaço não desloca os que ficam acima dele.
 */
export function chosenPatches(
  assembly: Assembly,
  picks: readonly string[],
): { label: string; patch: Buffer }[] {
  const bySlot = new Map<string, Part>();
  for (const id of new Set(picks)) {
    const part = assembly.parts.get(id);
    if (!part)
      throw new Error('Uma escolha já não existe: as pistas mudaram. Abre a montagem outra vez.');
    if (bySlot.has(part.slot)) throw new Error(`Duas escolhas na mesma zona de ${part.path}.`);
    bySlot.set(part.slot, part);
  }
  if (bySlot.size === 0) throw new Error('Escolhe pelo menos um pedaço para montar.');
  return [...bySlot.values()]
    .sort((a, b) => a.path.localeCompare(b.path) || b.oldStart - a.oldStart)
    .map(({ label, patch }) => ({ label, patch }));
}
