import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { launchArgs } from '../win-launch.ts';

export interface SpawnAgentOptions {
  /** Caminho absoluto do executável. */
  command: string;
  args: readonly string[];
  env: Record<string, string | undefined>;
  cwd: string;
}

/**
 * Arranca o processo de um agente. Só caminhos absolutos e nunca shell: no Windows um nome
 * solto é procurado primeiro na pasta atual, e um repositório podia plantar um codex.exe.
 */
export function spawnAgent(options: SpawnAgentOptions): ChildProcessWithoutNullStreams {
  if (!path.isAbsolute(options.command)) {
    throw new Error(`O executável do agente tem de ser um caminho absoluto: ${options.command}`);
  }
  const launched = launchArgs(options.command, options.args);
  return spawn(launched.file, launched.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: launched.verbatim,
    shell: false,
  });
}

/** Mata o processo e os filhos (no Windows o taskkill /T; noutros, o próprio processo). */
export function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve();
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // já tinha saído
    }
    return Promise.resolve();
  }
  const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise((resolve) => {
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}
