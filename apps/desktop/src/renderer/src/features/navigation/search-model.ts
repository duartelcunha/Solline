import type { NavigationTarget } from '@solline/protocol';

export interface NavigationEntry {
  id: string;
  title: string;
  detail: string;
  kind: 'project' | 'task' | 'session' | 'race' | 'destination';
  target: NavigationTarget;
}
const normalize = (text: string) =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-PT').trim();

/** Search only local navigation metadata. No file contents, agent calls or network requests. */
export function findNavigationEntries(entries: readonly NavigationEntry[], query: string) {
  const value = normalize(query.slice(0, 200));
  const words = [...new Set(value.split(/\s+/u).filter(Boolean))];
  const matched = entries
    .flatMap((entry, order) => {
      const title = normalize(entry.title);
      const haystack = `${title} ${normalize(entry.detail)}`;
      if (!words.every((word) => haystack.includes(word))) return [];
      const rank = !value
        ? 3
        : title === value
          ? 0
          : title.startsWith(value)
            ? 1
            : title.includes(value)
              ? 2
              : 3;
      return [{ entry, rank, order }];
    })
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
  return { total: matched.length, entries: matched.slice(0, 40).map((item) => item.entry) };
}
