import os from 'node:os';
import { agentEnv, CODEX_ENV_POLICY } from '../env.ts';
import { JsonRpcPeer, StderrTail } from '../rpc/json-rpc.ts';
import { withTimeout } from '../adapters/shared/turns.ts';
import { openCodexAccount } from '../adapters/codex/account.ts';
import { REVIEWED_CODEX_VERSION, resolveCodexExecutable } from '../adapters/codex/executable.ts';
import { initializeCodex, spawnCodex, type CodexTransport } from '../adapters/codex/transport.ts';
import type { CodexExecutable } from '../adapters/codex/executable.ts';
import type { GetAccountResponse } from '../adapters/codex/protocol/v2/GetAccountResponse';
import type { ModelListResponse } from '../adapters/codex/protocol/v2/ModelListResponse';
import type { ThreadStartParams } from '../adapters/codex/protocol/v2/ThreadStartParams';
import type { ThreadStartResponse } from '../adapters/codex/protocol/v2/ThreadStartResponse';
import type { TurnError } from '../adapters/codex/protocol/v2/TurnError';
import type { TurnStartParams } from '../adapters/codex/protocol/v2/TurnStartParams';
import type { TurnStartResponse } from '../adapters/codex/protocol/v2/TurnStartResponse';
import type { WindowsSandboxReadinessResponse } from '../adapters/codex/protocol/v2/WindowsSandboxReadinessResponse';
import {
  OUTPUT,
  RULES,
  SCHEMA,
  promptFor,
  type ReviewInput,
  type ReviewedFinding,
  type Reviewer,
} from './reviewer.ts';

/** Uma revisão que demore mais do que isto foi-se: o processo morre e o erro fica à vista. */
export const REVIEW_TIMEOUT_MS = 10 * 60_000;
const START_TIMEOUT_MS = 60_000;
const CONTROL_TIMEOUT_MS = 30_000;
const PROBE_BUDGET_MS = 20_000;
/** Quanto tempo vale a resposta sobre o Codex estar pronto (instalado, com login, com sandbox). */
const AVAILABILITY_TTL_MS = 60_000;

export const CODEX_REVIEW_LOGIN_MESSAGE =
  'O Codex não tem sessão iniciada, por isso não pôde dar a segunda opinião. Entra com o ChatGPT no seletor de agentes.';
const QUOTA_MESSAGE =
  'O Codex atingiu o limite da subscrição, por isso não pôde dar a segunda opinião. Tenta mais tarde.';

export interface CodexReviewerOptions {
  /** Caminho absoluto do codex.exe. */
  executable?: string | undefined;
  /** Para testes: liga a outro transporte em vez de arrancar o codex.exe (recebe a pasta). */
  transport?: ((cwd: string) => CodexTransport) | undefined;
  model?: string | undefined;
  /** Esforço de raciocínio; sem isto, o do modelo. */
  effort?: string | undefined;
  timeoutMs?: number | undefined;
}

/** O nome do tipo de erro do Codex: 'usageLimitExceeded' ou a chave de { httpConnectionFailed: … }. */
function errorKind(error: TurnError | null | undefined): string {
  const info = error?.codexErrorInfo;
  if (typeof info === 'string') return info;
  return info && typeof info === 'object' ? (Object.keys(info)[0] ?? '') : '';
}

/** Um erro do Codex numa frase que se perceba (quota e login primeiro). */
export function codexFailure(error: TurnError | null | undefined, fallback = ''): string {
  const kind = errorKind(error);
  const message = error?.message ?? fallback;
  if (
    ['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'].includes(kind) ||
    /usage limit|quota|rate limit/i.test(message)
  ) {
    return QUOTA_MESSAGE;
  }
  if (kind === 'unauthorized' || /not logged in|unauthori[sz]ed|sign in/i.test(message)) {
    return CODEX_REVIEW_LOGIN_MESSAGE;
  }
  return `O Codex não conseguiu rever: ${message || 'erro desconhecido'}`;
}

/** O Codex às vezes embrulha o JSON numa cerca de código mesmo com esquema. */
function jsonOf(text: string): unknown {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(body);
}

/**
 * Um revisor Codex só de leitura. Arranca um codex app-server por revisão, abre uma thread
 * efémera sem sandbox de escrita nem pedidos de aprovação (tudo o que pedir é recusado),
 * dá-lhe o prompt com o esquema de saída e lê a última mensagem. Mata sempre o processo.
 */
export function codexReviewer(options: CodexReviewerOptions): Reviewer {
  const review = async (input: ReviewInput): Promise<ReviewedFinding[]> => {
    if (input.signal?.aborted) throw new Error('Revisão cancelada');
    const stderr = new StderrTail();
    const transport = options.transport
      ? options.transport(input.cwd)
      : spawnCodex({
          executable: options.executable ?? requireExecutable(),
          env: agentEnv(CODEX_ENV_POLICY),
          cwd: input.cwd,
          stderr,
        });
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    const peer = new JsonRpcPeer({
      input: transport.input,
      output: transport.output,
      jsonrpc: false,
    });

    const seen: {
      answer: string;
      failure: TurnError | null;
      threadId: string | null;
      turnId: string | null;
      completed: boolean;
    } = { answer: '', failure: null, threadId: null, turnId: null, completed: false };
    let settle: (error: Error | null) => void = () => undefined;
    const finished = new Promise<Error | null>((resolve) => (settle = resolve));

    // Nada pede autorização a um revisor: tudo o que o Codex pedir é recusado.
    for (const method of [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
    ]) {
      peer.onRequest(method, () => ({ decision: 'decline' }));
    }
    for (const method of ['execCommandApproval', 'applyPatchApproval']) {
      peer.onRequest(method, () => ({ decision: { denied: { rejection: 'O revisor só lê' } } }));
    }
    peer.onRequest('mcpServer/elicitation/request', () => ({
      action: 'decline',
      content: null,
      _meta: null,
    }));
    peer.onRequest('item/tool/requestUserInput', () => ({ answers: {} }));

    peer.onNotification((method, params) => {
      if (method === 'item/completed') {
        const item = (params as { item?: { type?: string; text?: string; phase?: string | null } })
          .item;
        if (item?.type === 'agentMessage' && typeof item.text === 'string') {
          // Os comentários a meio do trabalho não são a resposta.
          if (item.phase !== 'commentary') seen.answer = item.text;
        }
      } else if (method === 'error') {
        const note = params as { error?: TurnError; willRetry?: boolean };
        if (note.error && !note.willRetry) seen.failure = note.error;
      } else if (method === 'turn/completed') {
        const turn = (
          params as { turn?: { id?: string; status?: string; error?: TurnError | null } }
        ).turn;
        if (seen.turnId && turn?.id && turn.id !== seen.turnId) return;
        seen.completed = true;
        if (turn?.status === 'failed') {
          settle(new Error(codexFailure(turn.error ?? seen.failure)));
        } else if (turn?.status === 'interrupted') settle(new Error('Revisão cancelada'));
        else settle(null);
      }
    });
    void peer.closed.then(() => {
      const tail = stderr.tail();
      settle(new Error(`O Codex fechou antes de acabar a revisão${tail ? `\n${tail}` : ''}`));
    });

    const timer = setTimeout(
      () =>
        settle(new Error(`A revisão do Codex demorou mais de ${timeoutMinutes(options)} minutos`)),
      options.timeoutMs ?? REVIEW_TIMEOUT_MS,
    );
    const onAbort = () => settle(new Error('Revisão cancelada'));
    input.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const run = async (): Promise<void> => {
        await initializeCodex(peer, START_TIMEOUT_MS);
        const account = await peer.request<GetAccountResponse>(
          'account/read',
          {},
          CONTROL_TIMEOUT_MS,
        );
        if (!account.account && account.requiresOpenaiAuth) {
          throw new Error(CODEX_REVIEW_LOGIN_MESSAGE);
        }
        const thread: ThreadStartParams = {
          cwd: input.cwd,
          ...(options.model ? { model: options.model } : {}),
          approvalPolicy: 'never',
          sandbox: 'read-only',
          developerInstructions: RULES,
          ephemeral: true,
        };
        const started = await peer.request<ThreadStartResponse>(
          'thread/start',
          thread,
          START_TIMEOUT_MS,
        );
        seen.threadId = started.thread.id;
        const turn: TurnStartParams = {
          threadId: seen.threadId,
          input: [{ type: 'text', text: promptFor(input), text_elements: [] }],
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          ...(options.effort ? { effort: options.effort } : {}),
          outputSchema: SCHEMA,
        };
        const response = await peer.request<TurnStartResponse>(
          'turn/start',
          turn,
          CONTROL_TIMEOUT_MS,
        );
        seen.turnId = response.turn.id;
      };
      // Quem acabar primeiro: a revisão a arrancar, ou o cancelamento, o tempo ou a queda.
      const started = run().then(
        () => null,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      const early = await Promise.race([started, finished]);
      if (early) throw withStderr(early, stderr);
      const error = await finished;
      if (error) throw error;
      if (!seen.answer) throw new Error('O revisor parou sem resposta');
      let json: unknown;
      try {
        json = jsonOf(seen.answer);
      } catch {
        throw new Error('O revisor respondeu num formato inesperado');
      }
      const parsed = OUTPUT.safeParse(json);
      if (!parsed.success) throw new Error('O revisor respondeu num formato inesperado');
      return parsed.data.findings;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      // Parar o turno com jeito (se ainda corre), mas sem esperar muito: a seguir mata-se tudo.
      if (seen.threadId && seen.turnId && !seen.completed) {
        await withTimeout(
          peer.request('turn/interrupt', { threadId: seen.threadId, turnId: seen.turnId }),
          2_000,
          'Interromper',
        ).catch(() => undefined);
      }
      peer.close();
      transport.output.end();
      await transport.kill();
    }
  };
  return Object.assign(review, {
    vendor: 'codex',
    ...(options.model ? { model: options.model } : {}),
  });
}

function timeoutMinutes(options: CodexReviewerOptions): number {
  return Math.round((options.timeoutMs ?? REVIEW_TIMEOUT_MS) / 60_000);
}

function requireExecutable(): never {
  throw new Error('Não encontrei o codex.exe');
}

function withStderr(error: Error, stderr: StderrTail): Error {
  const tail = stderr.tail();
  return tail && !error.message.includes(tail)
    ? new Error(`${error.message}\n${tail}`, { cause: error })
    : error;
}

export interface CodexAvailabilityOptions {
  /** Para testes: o codex.exe a usar. */
  resolve?: (() => CodexExecutable | null) | undefined;
  packaged?: boolean | undefined;
  /** Para testes: o app-server do teste de disponibilidade (conta, sandbox e modelos). */
  probeTransport?: (() => CodexTransport) | undefined;
  /** Para testes: o transporte de cada revisão. */
  reviewerTransport?: ((cwd: string) => CodexTransport) | undefined;
  ttlMs?: number | undefined;
  now?: (() => number) | undefined;
  /** Para testes: false trata a plataforma como Windows (onde se confirma o sandbox). */
  platform?: NodeJS.Platform | undefined;
}

/** Os esforços que se aceitam para rever, do preferido para o menos. */
const EFFORTS = ['medium', 'low'];

/**
 * Diz se há um Codex pronto a rever: instalado (e na versão revista), com sessão iniciada e com
 * o sandbox do Windows pronto (sem ele o modo só de leitura não se garante). A resposta, boa ou
 * má, vale um minuto; não se arranca um processo por cada turno. Devolve o revisor, ou null.
 */
export function codexAvailability(
  options: CodexAvailabilityOptions = {},
): () => Promise<Reviewer | null> {
  const resolve =
    options.resolve ?? (() => resolveCodexExecutable({ packaged: options.packaged === true }));
  const ttl = options.ttlMs ?? AVAILABILITY_TTL_MS;
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  let cached: { at: number; reviewer: Promise<Reviewer | null> } | null = null;

  const probe = async (): Promise<Reviewer | null> => {
    const found = resolve();
    if (!found || found.version !== REVIEWED_CODEX_VERSION) return null;
    const transport =
      options.probeTransport?.() ??
      spawnCodex({
        executable: found.path,
        env: agentEnv(CODEX_ENV_POLICY),
        // Na pasta pessoal: o teste não lê a config de nenhum projeto.
        cwd: os.homedir(),
        stderr: new StderrTail(),
      });
    const { peer, close } = await openCodexAccount(transport);
    try {
      const account = await peer.request<GetAccountResponse>(
        'account/read',
        { refreshToken: false },
        CONTROL_TIMEOUT_MS,
      );
      if (!account.account && account.requiresOpenaiAuth) return null;
      if (platform === 'win32') {
        const readiness = await peer
          .request<WindowsSandboxReadinessResponse>(
            'windowsSandbox/readiness',
            undefined,
            CONTROL_TIMEOUT_MS,
          )
          .catch(() => null);
        if (readiness?.status !== 'ready') return null;
      }
      const list = await peer.request<ModelListResponse>('model/list', {}, CONTROL_TIMEOUT_MS);
      const visible = list.data.filter((m) => !m.hidden);
      const model = visible.find((m) => m.isDefault) ?? visible[0];
      const effort = EFFORTS.find((e) =>
        model?.supportedReasoningEfforts.some((s) => s.reasoningEffort === e),
      );
      return codexReviewer({
        executable: found.path,
        transport: options.reviewerTransport,
        model: model?.id,
        effort,
      });
    } finally {
      await close();
    }
  };

  return () => {
    if (!cached || now() - cached.at > ttl) {
      cached = {
        at: now(),
        reviewer: withTimeout(probe(), PROBE_BUDGET_MS, 'Teste do Codex').catch(() => null),
      };
    }
    return cached.reviewer;
  };
}
