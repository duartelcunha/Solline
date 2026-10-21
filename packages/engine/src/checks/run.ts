import { spawn } from 'node:child_process';
import { agentEnv } from '../env.ts';

export const CHECK_TIMEOUT_MS = 3 * 60_000;
const TAIL_LINES = 40;
const TAIL_CHARS = 6_000;
/** Guarda só o fim da saída enquanto corre: um teste barulhento não enche a memória. */
const KEEP_CHARS = 64_000;

export interface CommandOutcome {
  state: 'passed' | 'failed' | 'timeout';
  /** O fim da saída, sem cores; null quando passou. */
  tail: string | null;
  durationMs: number;
}

export type RunCommand = (
  command: string,
  options: { cwd: string; signal: AbortSignal; timeoutMs?: number },
) => Promise<CommandOutcome>;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

/** As últimas linhas, sem cores nem linhas vazias no fim. */
export function tailOf(output: string): string {
  const lines = output.replace(ANSI, '').replace(/\r\n?/g, '\n').trimEnd().split('\n');
  const tail = lines.slice(-TAIL_LINES).join('\n').replace(/^\s*\n/, '');
  return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

/** Mata o comando e os filhos (o pnpm lança o tsc, que não morre sozinho no Windows). */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => undefined,
    );
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Já tinha acabado.
    }
  }
}

/**
 * Corre um comando do projeto na pasta, sem os segredos do ambiente da Solline. Rejeita se
 * for cancelado; passar o limite conta como timeout, não como falha do código.
 */
export const runCommand: RunCommand = (command, { cwd, signal, timeoutMs = CHECK_TIMEOUT_MS }) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...agentEnv({ base: 'no-secrets' }), FORCE_COLOR: '0', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const keep = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > KEEP_CHARS) output = output.slice(-KEEP_CHARS);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    const onAbort = () => {
      if (child.pid) killTree(child.pid);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => {
      finish();
      if (signal.aborted) reject(new Error('cancelled'));
      else resolve({ state: 'failed', tail: tailOf(String(error.message)), durationMs: 0 });
    });
    child.on('close', (code) => {
      finish();
      const durationMs = Date.now() - started;
      if (signal.aborted) reject(new Error('cancelled'));
      else if (timedOut) resolve({ state: 'timeout', tail: tailOf(output), durationMs });
      else if (code === 0) resolve({ state: 'passed', tail: null, durationMs });
      else resolve({ state: 'failed', tail: tailOf(output), durationMs });
    });
  });
