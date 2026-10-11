import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CommandResult } from '@solline/protocol';
import { sanitizedEnv } from './env.ts';

export const SDK_CHECK_PROMPT = 'Reply with the single word: ok';

export interface SdkCheckOptions {
  claudeExecutable?: string | undefined;
  /** Corta a chamada se o SDK não responder a tempo. */
  timeoutMs?: number;
}

/**
 * Prova de vida do SDK: uma única chamada a Haiku, em streaming-input, num
 * diretório temporário e sem ler definições do utilizador.
 */
export async function runSdkCheck(
  options: SdkCheckOptions = {},
): Promise<CommandResult<'engine.sdkCheck'>> {
  // O SDK só existe em ESM: o import dinâmico deixa o bundle do main ficar em CJS.
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const cwd = await mkdtemp(path.join(tmpdir(), 'solline-sdkcheck-'));
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), options.timeoutMs ?? 120_000);

  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: SDK_CHECK_PROMPT },
      parent_tool_use_id: null,
    };
  }

  let model: string | undefined;
  let apiKeySource: string | undefined;
  const stderr: string[] = [];
  try {
    const q = query({
      prompt: prompt(),
      options: {
        model: 'haiku',
        effort: 'low',
        permissionMode: 'default',
        env: sanitizedEnv(),
        settingSources: [],
        maxTurns: 1,
        cwd,
        abortController,
        stderr: (data) => stderr.push(data),
        ...(options.claudeExecutable
          ? { pathToClaudeCodeExecutable: options.claudeExecutable }
          : {}),
      },
    });
    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'init') {
        model = message.model;
        apiKeySource = message.apiKeySource;
      } else if (message.type === 'result') {
        if (message.subtype !== 'success') {
          throw new Error(`O SDK terminou com ${message.subtype}`);
        }
        if (model === undefined || apiKeySource === undefined) {
          throw new Error('O SDK respondeu sem a mensagem system/init');
        }
        return {
          model,
          apiKeySource,
          result: message.result,
          isError: message.is_error,
          totalCostUsd: message.total_cost_usd,
          durationMs: message.duration_ms,
          claudeExecutable: options.claudeExecutable ?? null,
        };
      }
    }
    throw new Error('O SDK fechou sem resultado');
  } catch (error) {
    const tail = stderr.join('').trim().slice(-500);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(tail ? `${reason}\n${tail}` : reason, { cause: error });
  } finally {
    clearTimeout(timer);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
