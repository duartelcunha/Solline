/**
 * Um servidor MCP mínimo por stdio, sem dependências: uma ferramenta "echo" que devolve o
 * texto. Para provar que um servidor ligado a uma sessão chega ao agente.
 * Uso: node test/fakes/echo-mcp.ts
 */
let buffer = '';
const send = (msg: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...(msg as object) })}\n`);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let i = buffer.indexOf('\n');
  while (i !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    i = buffer.indexOf('\n');
    if (!line) continue;
    const msg = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (msg.id === undefined) continue;
    switch (msg.method) {
      case 'initialize':
        send({
          id: msg.id,
          result: {
            protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'echo', version: '1.0.0' },
          },
        });
        break;
      case 'tools/list':
        send({
          id: msg.id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Returns the given text unchanged.',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
              },
            ],
          },
        });
        break;
      case 'tools/call': {
        const args = (msg.params?.arguments ?? {}) as { text?: string };
        send({
          id: msg.id,
          result: { content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }] },
        });
        break;
      }
      default:
        send({ id: msg.id, result: {} });
    }
  }
});
