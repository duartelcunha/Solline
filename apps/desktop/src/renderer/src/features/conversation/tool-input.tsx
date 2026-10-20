import type { ToolContent } from '@solline/protocol';

/**
 * Mostra o que uma ferramenta vai fazer pelo conteúdo estruturado (diffs, patches, comandos)
 * que o motor tira de qualquer agente. Sem conteúdo, mostra o input em JSON.
 */

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function cut(lines: string[], max?: number): string[] {
  return max && lines.length > max ? [...lines.slice(0, max), '…'] : lines;
}

function Line({ kind, children }: { kind: 'add' | 'del' | 'ctx'; children: string }) {
  const sign = kind === 'add' ? '+' : kind === 'del' ? '−' : ' ';
  return (
    <div className={kind === 'add' ? 'diff-add' : kind === 'del' ? 'diff-del' : undefined}>
      <span aria-hidden className="select-none pr-2 opacity-60">
        {sign}
      </span>
      {children}
    </div>
  );
}

/** oldText null: ficheiro novo, só linhas acrescentadas. */
function DiffLines({
  oldText,
  newText,
  max,
}: {
  oldText: string | null;
  newText: string;
  max?: number | undefined;
}) {
  const removed = oldText === null ? [] : oldText.split('\n');
  const added = newText.split('\n');
  return (
    <pre className="overflow-x-auto font-mono text-[12px] leading-[1.6]">
      {cut(removed, max).map((line, i) => (
        <Line key={`r${i}`} kind="del">
          {line}
        </Line>
      ))}
      {cut(added, max).map((line, i) => (
        <Line key={`a${i}`} kind="add">
          {line}
        </Line>
      ))}
    </pre>
  );
}

/** Um diff unificado (o Codex manda patches assim): cores por linha, cabeçalhos discretos. */
function UnifiedDiff({ unified, max }: { unified: string; max?: number | undefined }) {
  const lines = cut(unified.replace(/\n$/, '').split('\n'), max);
  return (
    <pre className="overflow-x-auto font-mono text-[12px] leading-[1.6]">
      {lines.map((line, i) =>
        line.startsWith('+') && !line.startsWith('+++') ? (
          <Line key={i} kind="add">
            {line.slice(1)}
          </Line>
        ) : line.startsWith('-') && !line.startsWith('---') ? (
          <Line key={i} kind="del">
            {line.slice(1)}
          </Line>
        ) : (
          <div key={i} className="text-subtle">
            {line}
          </div>
        ),
      )}
    </pre>
  );
}

function ContentView({ item, max }: { item: ToolContent; max?: number | undefined }) {
  switch (item.type) {
    case 'command':
      return (
        <pre className="overflow-x-auto font-mono text-[12px] leading-[1.6] whitespace-pre-wrap">
          <span aria-hidden className="text-subtle select-none">
            ${' '}
          </span>
          {item.command}
        </pre>
      );
    case 'diff':
      return (
        <div>
          <div className="mb-1.5 font-mono text-[11.5px] text-muted">{item.path}</div>
          <DiffLines oldText={item.oldText} newText={item.newText} max={max} />
        </div>
      );
    case 'patch':
      return (
        <div>
          <div className="mb-1.5 font-mono text-[11.5px] text-muted">{item.path}</div>
          <UnifiedDiff unified={item.unified} max={max} />
        </div>
      );
    case 'text':
      return (
        <pre className="overflow-x-auto font-mono text-[12px] leading-[1.6] whitespace-pre-wrap">
          {cut(item.text.split('\n'), max).join('\n')}
        </pre>
      );
  }
}

export function ToolInput({
  content,
  input,
  compact = false,
}: {
  content?: readonly ToolContent[] | undefined;
  input: unknown;
  compact?: boolean;
}) {
  const lines = compact ? 12 : undefined;
  if (content && content.length > 0) {
    return (
      <div className="space-y-3">
        {content.map((item, i) => (
          <ContentView key={i} item={item} max={lines} />
        ))}
      </div>
    );
  }
  const json = prettyJson(input);
  const shown = lines ? json.split('\n').slice(0, lines).join('\n') : json;
  return (
    <pre className="overflow-x-auto font-mono text-[12px] leading-[1.6]">
      {shown}
      {shown !== json ? '\n…' : ''}
    </pre>
  );
}
