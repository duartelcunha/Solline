import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StderrTail } from '../rpc/json-rpc.ts';
import { killTree, spawnAgent, type SpawnAgentOptions } from '../rpc/spawn.ts';
import type { LoginFlow } from './login.ts';

/**
 * Login pelo próprio CLI do fabricante (por exemplo `claude auth login`). O CLI fala com o
 * browser e guarda as credenciais onde costuma; a Solline só lê o endereço que ele escreve,
 * mostra o código de dispositivo se houver, passa o código que colares e espera que saia.
 */
export interface CliLoginSpec extends SpawnAgentOptions {
  /** Hosts onde o endereço de login pode estar (o primeiro https que bater certo). */
  hosts: readonly string[];
  /** Código de dispositivo na saída, no primeiro grupo (por exemplo ABCD-1234). */
  codePattern?: RegExp;
  /** O CLI pede para colar um código vindo do browser. */
  acceptsCode?: boolean;
  /** O CLI abre o browser sozinho (o main não o abre outra vez). */
  openedByAgent?: boolean;
  /** Quanto se espera pelo endereço. */
  urlTimeoutMs?: number;
}

const ANSI = new RegExp(String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007`, 'g');
const URL_IN_TEXT = /https:\/\/[^\s"'<>`]+/g;

/** O primeiro endereço https da saída num dos hosts, ou null. */
export function findLoginUrl(text: string, hosts: readonly string[]): string | null {
  for (const match of text.replace(ANSI, '').matchAll(URL_IN_TEXT)) {
    // Pontuação no fim de uma frase não faz parte do endereço.
    const raw = match[0].replace(/[).,;:!?]+$/, '');
    try {
      const url = new URL(raw);
      if (!url.username && !url.password && !url.port && hosts.includes(url.hostname)) return raw;
    } catch {
      // não é um endereço
    }
  }
  return null;
}

export async function startCliLogin(
  spec: CliLoginSpec,
  spawn: (options: SpawnAgentOptions) => ChildProcessWithoutNullStreams = spawnAgent,
): Promise<LoginFlow> {
  const child = spawn(spec);
  const tail = new StderrTail();
  let output = '';
  let exited: { code: number | null } | null = null;

  let settleExit: (code: number | null) => void = () => undefined;
  const exit = new Promise<number | null>((resolve) => (settleExit = resolve));
  child.on('error', (error) => {
    tail.push(Buffer.from(String(error)));
    settleExit(null);
  });
  child.on('close', (code) => settleExit(code));
  void exit.then((code) => (exited = { code }));

  let found: (value: { url: string; code?: string }) => void = () => undefined;
  const ready = new Promise<{ url: string; code?: string }>((resolve) => (found = resolve));
  const read = (chunk: Buffer) => {
    tail.push(chunk);
    output = (output + chunk.toString('utf8')).slice(-16_000);
    const url = findLoginUrl(output, spec.hosts);
    if (!url) return;
    const plain = output.replace(ANSI, '');
    const code = spec.codePattern ? spec.codePattern.exec(plain)?.[1] : undefined;
    // Com código de dispositivo, espera também por ele (às vezes vem na linha seguinte).
    if (spec.codePattern && !code) return;
    found(code ? { url, code } : { url });
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);

  const stop = async () => {
    if (exited) return;
    child.stdin.end();
    await killTree(child.pid);
  };
  const reason = () => {
    const last = tail.tail().replace(ANSI, '').trim();
    return last ? `: ${last.split('\n').slice(-3).join(' ')}` : '';
  };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('O agente não deu um endereço de login a tempo')),
      spec.urlTimeoutMs ?? 30_000,
    );
  });
  let started: { url: string; code?: string };
  try {
    started = await Promise.race([
      ready,
      exit.then((code) => {
        throw new Error(`O login fechou antes de começar (saída ${code ?? '?'})${reason()}`);
      }),
      timeout,
    ]);
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let cancelled = false;
  const done = exit.then((code) => {
    if (cancelled) throw new Error('Login cancelado');
    if (code !== 0) throw new Error(`O login não acabou bem${reason()}`);
  });
  done.catch(() => undefined);
  return {
    url: started.url,
    ...(started.code ? { code: started.code } : {}),
    acceptsCode: spec.acceptsCode === true,
    openedByAgent: spec.openedByAgent === true,
    submit: spec.acceptsCode
      ? async (code: string) => {
          if (exited) throw new Error('O login já acabou');
          child.stdin.write(`${code}\n`);
        }
      : undefined,
    done,
    cancel: async () => {
      cancelled = true;
      await stop();
      await done.catch(() => undefined);
    },
  };
}
