'use strict';

/*
 * Servidor MCP por stdio da Solline, para os agentes que não o recebem dentro do processo
 * (Codex e os agentes ACP). Ficheiro único e sem dependências: corre com o Node do sistema,
 * nunca com o executável da app (os fuses tiram-lhe o runAsNode).
 *
 * Não tem lógica própria. Fala MCP (initialize, ping, tools/list, tools/call) com o agente
 * por stdio e passa o resto ao motor da Solline por um canal local (named pipe ou socket
 * Unix), onde o token desta sessão diz quem é o chamador. Ambiente:
 *   SOLLINE_BRAIN_PIPE   endereço do canal local
 *   SOLLINE_BRAIN_TOKEN  token desta sessão (nunca se escreve em stdout, stderr nem ficheiros)
 *
 * Protocolo com o motor: JSON, uma mensagem por linha (ver packages/engine/src/brain/channel.ts).
 */

const net = require('node:net');

const SERVER_NAME = 'solline';
const SERVER_VERSION = '0.1.0';
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE_CHARS = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;

const pipe = process.env.SOLLINE_BRAIN_PIPE;
const token = process.env.SOLLINE_BRAIN_TOKEN;
// Nada que este processo lance a seguir herda o token.
delete process.env.SOLLINE_BRAIN_TOKEN;

function warn(message) {
  process.stderr.write(`[solline-brain] ${message}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

/** Parte um fluxo de texto em linhas, sem passar o limite de tamanho. */
function lineReader(onLine, onTooLong) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) {
        if (buffer.length > MAX_LINE_CHARS) {
          buffer = '';
          onTooLong();
        }
        return;
      }
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.length > MAX_LINE_CHARS) onTooLong();
      else if (line.trim()) onLine(line);
    }
  };
}

/* ---------- o canal para o motor ---------- */

let tools = [];
let link = null;
let nextId = 1;
const pending = new Map();

function failPending() {
  for (const resolve of pending.values()) {
    resolve({ text: 'A ligação à Solline fechou.', isError: true });
  }
  pending.clear();
}

const ready = new Promise((resolve) => {
  if (!pipe || !token) {
    warn('faltam SOLLINE_BRAIN_PIPE ou SOLLINE_BRAIN_TOKEN: sem ferramentas');
    resolve(false);
    return;
  }
  const socket = net.connect(pipe);
  socket.setEncoding('utf8');
  const timer = setTimeout(() => {
    warn('o motor não respondeu a tempo: sem ferramentas');
    socket.destroy();
  }, CONNECT_TIMEOUT_MS);
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ type: 'hello', token })}\n`);
  });
  socket.on(
    'data',
    lineReader(
      (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!message || typeof message !== 'object') return;
        if (message.type === 'ready' && Array.isArray(message.tools)) {
          tools = message.tools;
          link = socket;
          clearTimeout(timer);
          resolve(true);
        } else if (message.type === 'result' && typeof message.id === 'number') {
          const done = pending.get(message.id);
          pending.delete(message.id);
          done?.({ text: String(message.text ?? ''), isError: message.isError === true });
        } else if (message.type === 'error') {
          warn(`o motor recusou a ligação: ${String(message.message)}`);
        }
      },
      () => {
        warn('mensagem do motor demasiado grande');
        socket.destroy();
      },
    ),
  );
  socket.on('error', (error) => warn(`canal com erro: ${error.code ?? error.message}`));
  socket.on('close', () => {
    clearTimeout(timer);
    link = null;
    failPending();
    resolve(false);
  });
});

async function callEngine(name, args) {
  await ready;
  const socket = link;
  if (!socket || socket.destroyed) {
    return { text: 'A Solline não está disponível nesta sessão.', isError: true };
  }
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.write(`${JSON.stringify({ type: 'call', id, name, args })}\n`);
  });
}

/* ---------- MCP por stdio ---------- */

function listedTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly === true },
  };
}

async function handle(message) {
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') return;
  const { id, method, params } = message;
  // Notificações (sem id) não têm resposta.
  if (id === undefined || id === null) return;
  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      send({
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    }
    case 'ping':
      send({ id, result: {} });
      return;
    case 'tools/list':
      await ready;
      send({ id, result: { tools: tools.map(listedTool) } });
      return;
    case 'tools/call': {
      const name = params && params.name;
      if (typeof name !== 'string') {
        send({ id, error: { code: -32602, message: 'Falta o nome da ferramenta' } });
        return;
      }
      const args = params.arguments === undefined ? {} : params.arguments;
      const result = await callEngine(name, args);
      send({
        id,
        result: { content: [{ type: 'text', text: result.text }], isError: result.isError },
      });
      return;
    }
    case 'resources/list':
      send({ id, result: { resources: [] } });
      return;
    case 'resources/templates/list':
      send({ id, result: { resourceTemplates: [] } });
      return;
    case 'prompts/list':
      send({ id, result: { prompts: [] } });
      return;
    default:
      send({ id, error: { code: -32601, message: `Método desconhecido: ${method}` } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on(
  'data',
  lineReader(
    (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: 'JSON inválido' } });
        return;
      }
      for (const one of Array.isArray(message) ? message : [message]) {
        handle(one).catch((error) => {
          warn(`erro a tratar ${one && one.method}: ${error && error.message}`);
          if (one && one.id !== undefined && one.id !== null) {
            send({ id: one.id, error: { code: -32603, message: 'Erro interno' } });
          }
        });
      }
    },
    () => send({ id: null, error: { code: -32700, message: 'Mensagem demasiado grande' } }),
  ),
);
process.stdin.on('end', () => {
  link?.destroy();
  // O agente fechou o stdin: acaba depois de a última resposta sair.
  process.stdout.write('', () => process.exit(0));
});
