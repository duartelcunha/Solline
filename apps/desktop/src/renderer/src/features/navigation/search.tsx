import { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowUpRight,
  ClipboardList,
  Folder,
  LayoutGrid,
  MessageSquare,
  Search,
  Trophy,
  X,
} from 'lucide-react';
import type { NavigationTarget } from '@solline/protocol';
import { findNavigationEntries, type NavigationEntry } from './search-model';
import './navigation.css';

const icons = {
  project: Folder,
  task: ClipboardList,
  session: MessageSquare,
  race: Trophy,
  destination: LayoutGrid,
};
export function NavigationSearch({
  readEntries,
  onNavigate,
  enabled = true,
}: {
  readEntries: () => readonly NavigationEntry[];
  onNavigate: (target: NavigationTarget) => void;
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<readonly NavigationEntry[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const pendingTarget = useRef<NavigationTarget | null>(null);
  const listId = useId();
  const results = useMemo(() => findNavigationEntries(entries, query), [entries, query]);
  const current = Math.min(selected, Math.max(0, results.entries.length - 1));
  function changeOpen(next: boolean) {
    if (next) {
      setEntries(readEntries());
      previousFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      pendingTarget.current = null;
      setQuery('');
      setSelected(0);
    }
    setOpen(next);
  }
  useEffect(() => {
    if (!enabled) return;
    const key = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === 'k' &&
        !event.isComposing
      ) {
        if (document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        setEntries(readEntries());
        previousFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setQuery('');
        setSelected(0);
        pendingTarget.current = null;
        setOpen(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [enabled, readEntries]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, current, listId]);
  function choose(entry: NavigationEntry) {
    pendingTarget.current = entry.target;
    setOpen(false);
  }
  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          disabled={!enabled}
          className="navigation-search-trigger"
          data-testid="navigation-search"
        >
          <Search size={15} aria-hidden />
          <span>Pesquisar</span>
          <kbd>Ctrl K</kbd>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="navigation-overlay" />
        <Dialog.Content
          className="navigation-dialog navigation-search-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = pendingTarget.current;
            pendingTarget.current = null;
            if (target) {
              onNavigate(target);
              requestAnimationFrame(() => document.querySelector<HTMLElement>('main')?.focus());
            } else if (previousFocus.current?.isConnected) previousFocus.current.focus();
          }}
        >
          <Dialog.Title className="sr-only">Pesquisar no Solline</Dialog.Title>
          <Dialog.Description className="sr-only">
            Encontra projetos, tarefas e conversas. Usa as setas e Enter para abrir, ou Escape para
            voltar.
          </Dialog.Description>
          <div className="navigation-search-field">
            <Search size={19} aria-hidden />
            <input
              ref={input}
              role="combobox"
              aria-label="Pesquisar projetos, tarefas e conversas"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={results.entries.length ? `${listId}-${current}` : undefined}
              value={query}
              maxLength={200}
              placeholder="Projetos, tarefas e conversas…"
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSelected(results.entries.length ? (current + 1) % results.entries.length : 0);
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSelected(
                    results.entries.length
                      ? (current + results.entries.length - 1) % results.entries.length
                      : 0,
                  );
                } else if (event.key === 'Enter' && results.entries[current]) {
                  event.preventDefault();
                  choose(results.entries[current]);
                }
              }}
            />
            <Dialog.Close asChild>
              <button type="button" className="navigation-icon" aria-label="Fechar pesquisa">
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>
          <div id={listId} role="listbox" aria-label="Resultados" className="navigation-results">
            {results.entries.map((entry, index) => {
              const Icon = icons[entry.kind];
              return (
                <div
                  key={entry.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === current}
                  className="navigation-result"
                  onMouseMove={() => setSelected(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(entry)}
                >
                  <Icon size={17} aria-hidden />
                  <div>
                    <span>{entry.title}</span>
                    <small>{entry.detail}</small>
                  </div>
                  <ArrowUpRight size={15} aria-hidden />
                </div>
              );
            })}
          </div>
          {results.total === 0 ? (
            <p className="navigation-empty">Não encontrámos resultados. Experimenta outro nome.</p>
          ) : null}
          <p className="navigation-search-hint" role="status">
            {results.total > 40
              ? `40 de ${results.total} resultados — escreve mais para filtrar.`
              : `${results.total} ${results.total === 1 ? 'resultado' : 'resultados'} · ↑ ↓ escolher · Enter abrir`}
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
