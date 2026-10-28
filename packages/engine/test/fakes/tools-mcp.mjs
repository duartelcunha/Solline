/**
 * Um servidor MCP por stdio, sem dependências, para a sonda do catálogo. As ferramentas vêm do
 * ficheiro FAKE_TOOLS_FILE (JSON) se existir. FAKE_MODE: fail (sai com erro que ecoa FAKE_SECRET),
 * hang (nunca responde), invalid (devolve uma lista inválida), noisy (escreve lixo no stdout).
 */
import { readFileSync } from 'node:fs';

const mode = process.env.FAKE_MODE ?? '';
if (mode === 'fail') {
  process.stderr.write(`erro de arranque com a chave ${process.env.FAKE_SECRET ?? ''}\n`);
  process.exit(3);
}

const tools = () =>
  process.env.FAKE_TOOLS_FILE
    ? JSON.parse(readFileSync(process.env.FAKE_TOOLS_FILE, 'utf8'))
    : [{ name: 'echo', description: 'Devolve o texto.', inputSchema: { type: 'object' } }];
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

if (mode === 'noisy') process.stdout.write('A arrancar o servidor...\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line || mode === 'hang') continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === 'initialize')
      send({
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1.0.0' },
        },
      });
    else if (message.method === 'tools/list') {
      if (mode === 'invalid') send({ id: message.id, result: { tools: 'x' } });
      else if (mode === 'paged' && !message.params?.cursor)
        send({ id: message.id, result: { tools: tools().slice(0, 1), nextCursor: 'p2' } });
      else if (mode === 'paged') send({ id: message.id, result: { tools: tools().slice(1) } });
      else send({ id: message.id, result: { tools: tools() } });
    } else send({ id: message.id, error: { code: -32601, message: 'sem método' } });
  }
});
process.stdin.on('end', () => process.exit(0));
