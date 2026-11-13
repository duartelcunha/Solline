import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Nomes por que o sistema procura o `gh`. No Windows a ordem é a do PATHEXT
 * (`.EXE` antes de `.CMD`, por omissão): um `gh.cmd` do instalador também conta.
 */
export function ghNames(platform: NodeJS.Platform, pathext: string | undefined): string[] {
  if (platform !== 'win32') return ['gh'];
  const raw = pathext?.trim() ? pathext : '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => `gh${ext.startsWith('.') ? ext : `.${ext}`}`);
}

/**
 * O `gh` no PATH, só por pastas absolutas. Uma pasta relativa seria procurada a partir da
 * pasta de trabalho, e no Windows isso começa na pasta do projeto.
 */
export function resolveGh(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  const names = ghNames(process.platform, env.PATHEXT);
  const raw = env.PATH ?? env.Path ?? '';
  for (const dir of raw.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return path.normalize(candidate);
    }
  }
  return null;
}

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Um `.cmd`/`.bat` no Node 22 não arranca com `execFile` direto: o Node responde EINVAL. */
function launchGh(executable: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    const line = [executable, ...args]
      .map((arg) => {
        if (arg.length === 0) return '""';
        return /[\s"&|<>^%]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
      })
      .join(' ');
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
    };
  }
  return { file: executable, args };
}

/** `execFile`, sem shell. O teste troca isto por um programa seu. */
export function runGh(executable: string, args: string[], cwd: string): Promise<GhResult> {
  const launch = launchGh(executable, args);
  return new Promise((resolve, reject) => {
    execFile(
      launch.file,
      launch.args,
      {
        cwd,
        windowsHide: true,
        windowsVerbatimArguments: launch.file !== executable,
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        const code = error && typeof error.code === 'number' ? error.code : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
