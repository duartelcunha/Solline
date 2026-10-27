import type { LoginFlow } from '../../agents/login.ts';
import { JsonRpcPeer, StderrTail } from '../../rpc/json-rpc.ts';
import { withTimeout } from '../shared/turns.ts';
import type { AccountLoginCompletedNotification } from './protocol/v2/AccountLoginCompletedNotification';
import type { GetAccountResponse } from './protocol/v2/GetAccountResponse';
import type { LoginAccountParams } from './protocol/v2/LoginAccountParams';
import type { LoginAccountResponse } from './protocol/v2/LoginAccountResponse';
import { initializeCodex, type CodexTransport } from './transport.ts';

const TIMEOUT_MS = 30_000;

/**
 * Um app-server só para a conta, sem sessão nem thread. A Solline pergunta ao Codex se tem
 * sessão e pede-lhe o login; nunca lê as credenciais (o Codex guarda-as onde costuma).
 */
export async function openCodexAccount(transport: CodexTransport): Promise<{
  peer: JsonRpcPeer;
  stderr: StderrTail;
  close: () => Promise<void>;
}> {
  const stderr = new StderrTail();
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const peer = new JsonRpcPeer({
    input: transport.input,
    output: transport.output,
    jsonrpc: false,
  });
  const close = async () => {
    peer.close();
    transport.output.end();
    await withTimeout(transport.exited, 5_000, 'Fechar o Codex').catch(() => undefined);
    await transport.kill();
  };
  try {
    await initializeCodex(peer, TIMEOUT_MS);
  } catch (error) {
    await close();
    const tail = stderr.tail();
    throw new Error(`O Codex não arrancou: ${String(error)}${tail ? `\n${tail}` : ''}`, {
      cause: error,
    });
  }
  return { peer, stderr, close };
}

/** Se o Codex precisa de login. Não pede um token novo (refreshToken: false). */
export async function codexNeedsLogin(transport: CodexTransport): Promise<boolean> {
  const { peer, close } = await openCodexAccount(transport);
  try {
    const account = await peer.request<GetAccountResponse>(
      'account/read',
      { refreshToken: false },
      TIMEOUT_MS,
    );
    return !account.account && account.requiresOpenaiAuth;
  } finally {
    await close();
  }
}

/**
 * "Entrar com ChatGPT": o Codex abre um servidor local para o regresso do browser e devolve o
 * endereço da OpenAI. O processo fica vivo até ao account/login/completed.
 */
export async function startCodexLogin(transport: CodexTransport): Promise<LoginFlow> {
  const { peer, close } = await openCodexAccount(transport);
  let settle: (error: Error | null) => void = () => undefined;
  const finished = new Promise<Error | null>((resolve) => (settle = resolve));
  let loginId: string | null = null;
  peer.onNotification((method, params) => {
    if (method !== 'account/login/completed') return;
    const done = params as AccountLoginCompletedNotification;
    if (done.loginId !== null && loginId !== null && done.loginId !== loginId) return;
    settle(done.success ? null : new Error(done.error ?? 'O login no ChatGPT falhou'));
  });
  void peer.closed.then(() => settle(new Error('O Codex fechou antes de acabar o login')));

  let started: LoginAccountResponse;
  try {
    const params: LoginAccountParams = { type: 'chatgpt' };
    started = await peer.request<LoginAccountResponse>('account/login/start', params, TIMEOUT_MS);
  } catch (error) {
    await close();
    throw new Error(`O Codex não começou o login: ${String(error)}`, { cause: error });
  }
  if (started.type !== 'chatgpt') {
    await close();
    throw new Error('O Codex respondeu ao login de uma forma que a Solline não conhece');
  }
  loginId = started.loginId;
  const id = started.loginId;

  const done = finished.then(async (error) => {
    await close();
    if (error) throw error;
  });
  // Quem chama trata do resultado; isto só evita um aviso de promessa sem catch.
  done.catch(() => undefined);
  return {
    url: started.authUrl,
    done,
    cancel: async () => {
      await withTimeout(
        peer.request('account/login/cancel', { loginId: id }),
        5_000,
        'Cancelar',
      ).catch(() => undefined);
      settle(new Error('Login cancelado'));
      await done.catch(() => undefined);
    },
  };
}
