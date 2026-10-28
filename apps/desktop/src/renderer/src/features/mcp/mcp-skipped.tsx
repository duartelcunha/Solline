import { Info } from 'lucide-react';
import { useSession } from '../../stores/app.ts';
import { useMcpCatalog } from '../../stores/mcp-catalog.ts';
import { openCatalog } from './mcp-project.tsx';
import { skippedLine } from './mcp-model.ts';

/**
 * Os servidores MCP que o projeto escolheu e esta sessão não recebeu, numa linha calma por baixo
 * do cabeçalho. A sessão abriu na mesma: isto só diz porque faltam.
 */
export function McpSkippedNote({ sessionId }: { sessionId: string }) {
  const skipped = useSession(sessionId, (s) => s.info.mcpSkipped);
  const servers = useMcpCatalog((s) => s.data.servers);
  if (!skipped?.length) return null;
  const labelOf = (id: string) => servers.find((s) => s.id === id)?.spec.label ?? id;
  return (
    <div
      role="status"
      data-testid="mcp-skipped"
      className="flex shrink-0 items-center gap-2.5 border-b border-line/50 px-5 py-2 text-[12px] text-muted"
    >
      <Info size={13} className="shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">{skippedLine(skipped, labelOf)}</p>
      <button
        type="button"
        onClick={openCatalog}
        className="sl-press shrink-0 rounded-sm font-medium text-fg hover:underline"
        data-testid="mcp-skipped-open"
      >
        Abrir o catálogo
      </button>
    </div>
  );
}
