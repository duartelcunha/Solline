import { tmpdir } from 'node:os';
import { z } from 'zod';
import { killTree, spawnAgent } from '../rpc/spawn.ts';
import { cleanText, redact, toolPrint, toolsFingerprint, type ToolPrint } from './spec.ts';

/**
 * A sonda: arranca o servidor uma vez, faz `initialize` e `tools/list` por stdio e fecha-o. O
 * que ele anuncia (nomes, descrições, esquemas) é dado não confiável: valida-se, limita-se e só
 * se guarda texto limpo mais uma impressão. O servidor corre com o mínimo do ambiente e só as
 * variáveis que o utilizador lhe deu; nunca com as chaves dos agentes.
 */
export interface ProbeTarget {
  command: string;
  args: readonly string[];
  /** As variáveis do servidor, já com os segredos (só vivem nesta chamada). */
  env: Readonly<Record<string, string>>;
}

export interface ProbeResult {
  tools: ToolPrint[];
  hash: string;
}

export type ProbeFn = (
  target: ProbeTarget,
  options?: { timeoutMs?: number; secrets?: readonly string[] },
) => Promise<ProbeResult>;

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_TOOLS = 200;
const MAX_PAGES = 10;
const STDERR_TAIL = 600;
export const PROBE_TIMEOUT_MS = 60_000;

/** O mínimo do ambiente para um servidor arrancar (rede, pastas do utilizador, proxies). */
const BASE_ENV = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'USERPROFILE',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERNAME',
  'LANG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const Tool = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(20_000).optional(),
    inputSchema: z.unknown().optional(),
    annotations: z.unknown().optional(),
  })
  .passthrough();

const ListResult = z
  .object({
    tools: z.array(z.unknown()).max(1000),
    nextCursor: z.string().max(500).optional(),
  })
  .passthrough();

interface Reply {
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: { message?: unknown };
}

export const probeMcpServer: ProbeFn = async (target, options = {}) => {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const secrets = options.secrets ?? [];
  const child = spawnAgent({
    command: target.command,
    args: target.args,
    env: { ...baseEnv(), ...target.env },
    cwd: tmpdir(),
  });
  let stderr = '';
  let buffer = '';
  let received = 0;
  let nextId = 1;
  const waiting = new Map<number, (reply: Reply) => void>();
  let fail: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failed.catch(() => undefined);

  const send = (message: object) => {
    if (child.stdin.writable)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const request = (method: string, params: object): Promise<Reply> => {
    const id = nextId++;
    return new Promise<Reply>((resolve) => {
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  };

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    received += chunk.length;
    if (received > MAX_OUTPUT) {
      fail(new Error('O servidor enviou demasiados dados'));
      return;
    }
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let reply: Reply;
      try {
        reply = JSON.parse(line) as Reply;
      } catch {
        continue; // Texto solto no stdout (um aviso de arranque): não é uma mensagem.
      }
      if (reply && typeof reply === 'object' && typeof reply.method === 'string') {
        // Pedidos do servidor ao cliente: só o ping tem resposta; o resto fica sem resposta.
        if (reply.method === 'ping' && reply.id !== undefined) send({ id: reply.id, result: {} });
        continue;
      }
      if (typeof reply?.id === 'number') waiting.get(reply.id)?.(reply);
    }
  });
  child.on('error', (error) => fail(new Error(`Não arrancou: ${error.message}`)));
  child.on('exit', (code) =>
    fail(new Error(`O servidor terminou antes de responder (código ${code ?? '?'})`)),
  );

  const timer = setTimeout(
    () => fail(new Error(`O servidor não respondeu em ${Math.round(timeoutMs / 1000)} s`)),
    timeoutMs,
  );
  let failure: Error | undefined;
  try {
    const run = async (): Promise<ProbeResult> => {
      const init = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'solline', version: '0.0.1' },
      });
      if (init.error) throw new Error('O servidor recusou o arranque do protocolo');
      send({ method: 'notifications/initialized' });
      const prints: ToolPrint[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const reply = await request('tools/list', cursor ? { cursor } : {});
        if (reply.error) throw new Error('O servidor não listou as ferramentas');
        const list = ListResult.safeParse(reply.result);
        if (!list.success) throw new Error('A lista de ferramentas do servidor é inválida');
        for (const raw of list.data.tools) {
          const tool = Tool.safeParse(raw);
          if (!tool.success) throw new Error('Uma ferramenta do servidor é inválida');
          prints.push(toolPrint(tool.data));
        }
        if (prints.length > MAX_TOOLS) throw new Error('O servidor tem ferramentas a mais');
        cursor = list.data.nextCursor;
        if (!cursor) break;
      }
      const names = new Set(prints.map((t) => t.name));
      if (names.size !== prints.length) throw new Error('O servidor repete nomes de ferramentas');
      return { tools: prints, hash: toolsFingerprint(prints) };
    };
    return await Promise.race([run(), failed]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const tail = cleanText(stderr, 300);
    // Sem `cause`: o erro original podia trazer valores que o servidor ecoou.
    failure = new Error(redact(tail ? `${reason} (${tail})` : reason, secrets));
  } finally {
    clearTimeout(timer);
    child.removeAllListeners('exit');
    child.stdin.end();
    await killTree(child.pid);
  }
  throw failure ?? new Error('A sonda falhou');
};
