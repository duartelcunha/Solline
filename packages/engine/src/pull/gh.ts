import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * O `gh` no PATH, só por pastas absolutas. Uma pasta relativa seria procurada a partir da
 * pasta de trabalho, e no Windows isso começa na pasta do projeto.
 */
export function resolveGh(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const raw = env.PATH ?? env.Path ?? '';
  for (const dir of raw.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (exists(candidate)) return path.normalize(candidate);
  }
  return null;
}

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `execFile`, sem shell. O teste troca isto por um programa seu. */
export function runGh(executable: string, args: string[], cwd: string): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { cwd, windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
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
