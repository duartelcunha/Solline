import type { SplitPart, SplitReview } from '@solline/protocol';
import { globToRegExp, normalize, zoneOf, zonesOverlap, type Zone } from './zones.ts';

/**
 * A revisão de um plano de repartição, antes de lançar nada e sem gastar nada: que partes se
 * tocam (e por isso correm uma a seguir à outra), quais ficam de fora por não terem verificação,
 * que ficheiros-ponto-de-encontro mais do que uma parte pode mexer e quantas vezes os tokens de
 * um agente se vai gastar. Pura: só olha para os contratos das partes.
 */

/** Os ficheiros que quase sempre mais do que uma parte quer mexer (e dão conflito). */
const HUBS = [
  '**/index.{ts,tsx,js}',
  '**/routes.*',
  '**/router.*',
  '**/schema.*',
  '**/*.sql',
  '**/i18n/**',
  '**/locales/**',
  '**/package.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lock',
  '**/bun.lockb',
  '**/*.gen.*',
  '**/generated/**',
].map(globToRegExp);

function isHub(path: string): boolean {
  return HUBS.some((hub) => hub.test(path));
}

/** A zona `allowed` apanha este ponto de encontro? (um ficheiro, ou um glob que o pode cobrir) */
function covers(allowed: Zone, entry: string, hub: Zone): boolean {
  if (hub.glob) return zonesOverlap(allowed, hub);
  if (allowed.glob) return globToRegExp(normalize(entry)).test(normalize(hubPath(hub)));
  // Um caminho certo apanha-o se for o próprio ficheiro ou a pasta onde ele está.
  return allowed.segments.every((s, i) => s === hub.segments[i]);
}

function hubPath(zone: Zone): string {
  return zone.segments.join('/');
}

function dropReason(part: SplitPart, checkIds: ReadonlySet<string>): string | null {
  if (part.check === null) return 'Sem verificação própria: não há como saber se ficou certa.';
  if (!checkIds.has(part.check)) return `A verificação «${part.check}» não existe no projeto.`;
  return null;
}

/** Os grupos de partes que se tocam (componentes ligados), pela ordem original. */
function groups(indexes: readonly number[], zones: ReadonlyMap<number, Zone[]>): number[][] {
  const result: number[][] = [];
  const seen = new Set<number>();
  for (const start of indexes) {
    if (seen.has(start)) continue;
    const group: number[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const current = queue.shift() as number;
      group.push(current);
      for (const other of indexes) {
        if (seen.has(other)) continue;
        const touches = (zones.get(current) ?? []).some((x) =>
          (zones.get(other) ?? []).some((y) => zonesOverlap(x, y)),
        );
        if (!touches) continue;
        seen.add(other);
        queue.push(other);
      }
    }
    result.push(group.sort((a, b) => a - b));
  }
  return result.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

export function reviewPlan(parts: readonly SplitPart[], checkIds: readonly string[]): SplitReview {
  const known = new Set(checkIds);
  const dropped: SplitReview['dropped'] = [];
  const running: number[] = [];
  parts.forEach((part, index) => {
    const reason = dropReason(part, known);
    if (reason) dropped.push({ index, reason });
    else running.push(index);
  });

  const zones = new Map<number, Zone[]>(
    parts.map((part, index) => [index, part.allowed.map(zoneOf)] as const),
  );
  // A parte zero corre sempre sozinha e primeiro; as outras agrupam-se pelo que tocam.
  const zero = running.filter((i) => parts[i]?.zero);
  const rest = running.filter((i) => !parts[i]?.zero);
  const sequential = [...zero.map((i) => [i]), ...groups(rest, zones)];

  const hubs: SplitReview['hubs'] = [];
  const candidates = new Map<string, { shown: string; zone: Zone }>();
  for (const index of running)
    for (const entry of parts[index]?.allowed ?? []) {
      const path = normalize(entry);
      if (isHub(path) && !candidates.has(path))
        candidates.set(path, { shown: entry.trim(), zone: zoneOf(entry) });
    }
  for (const { shown, zone } of candidates.values()) {
    const owners = running.filter((index) =>
      (parts[index]?.allowed ?? []).some((entry) => covers(zoneOf(entry), entry, zone)),
    );
    if (owners.length >= 2) hubs.push({ path: shown, parts: owners });
  }

  const warnings: string[] = [];
  const title = (index: number) => `«${parts[index]?.title ?? index + 1}»`;
  if (parts.length > 3)
    warnings.push('Mais de 3 partes: cada uma gasta tokens e a integração fica mais difícil.');
  for (const { index } of dropped)
    warnings.push(`A parte ${title(index)} não se lança: não tem verificação válida.`);
  if (running.length < 2) warnings.push('Menos de duas partes vão correr: partir não compensa.');
  else if (rest.length >= 2 && sequential.length - zero.length === 1)
    warnings.push(
      'As partes mexem nas mesmas zonas e correm uma a seguir à outra: partir não poupa tempo.',
    );
  for (const hub of hubs)
    warnings.push(
      `${hub.parts.map(title).join(' e ')} podem mexer em ${hub.path}, um ficheiro partilhado: espera conflitos.`,
    );
  for (const index of running)
    if ((parts[index]?.allowed.length ?? 0) === 0)
      warnings.push(`A parte ${title(index)} não diz que ficheiros pode tocar.`);

  return { sequential, dropped, hubs, costMultiplier: running.length, warnings };
}
