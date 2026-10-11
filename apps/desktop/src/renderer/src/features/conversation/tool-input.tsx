/** Mostra o input de uma ferramenta da forma mais legível para essa ferramenta. */

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function DiffLines({ oldText, newText, max }: { oldText: string; newText: string; max?: number }) {
  const removed = oldText.split('\n');
  const added = newText.split('\n');
  const cut = (lines: string[]) =>
    max && lines.length > max ? [...lines.slice(0, max), '…'] : lines;
  return (
    <pre className="overflow-x-auto font-mono text-[12px] leading-[1.6]">
      {cut(removed).map((line, i) => (
        <div key={`r${i}`} className="diff-del">
          <span aria-hidden className="select-none pr-2 opacity-60">
            −
          </span>
          {line}
        </div>
      ))}
      {cut(added).map((line, i) => (
        <div key={`a${i}`} className="diff-add">
          <span aria-hidden className="select-none pr-2 opacity-60">
            +
          </span>
          {line}
        </div>
      ))}
    </pre>
  );
}

export function ToolInput({
  name,
  input,
  compact = false,
}: {
  name: string;
  input: unknown;
  compact?: boolean;
}) {
  const file = field(input, 'file_path') ?? field(input, 'notebook_path');
  const lines = compact ? 12 : undefined;
  if (name === 'Bash') {
    return (
      <pre className="overflow-x-auto font-mono text-[12px] leading-[1.6] whitespace-pre-wrap">
        <span aria-hidden className="text-subtle select-none">
          ${' '}
        </span>
        {field(input, 'command') ?? ''}
      </pre>
    );
  }
  if (
    name === 'Edit' &&
    (field(input, 'old_string') !== undefined || field(input, 'new_string') !== undefined)
  ) {
    return (
      <div>
        {file ? <div className="mb-1.5 font-mono text-[11.5px] text-muted">{file}</div> : null}
        <DiffLines
          oldText={field(input, 'old_string') ?? ''}
          newText={field(input, 'new_string') ?? ''}
          {...(lines ? { max: lines } : {})}
        />
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
