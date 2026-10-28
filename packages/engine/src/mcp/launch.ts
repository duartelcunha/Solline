import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Porque um servidor do catálogo não arranca: needs-approval (ainda não foi aprovado, ou mudou o
 * que se aprovou), changed (as ferramentas mudaram), unavailable (falta o programa) ou error (a
 * sonda falhou).
 */
export class McpLaunchError extends Error {
  readonly reason: 'needs-approval' | 'changed' | 'unavailable' | 'error';
  constructor(reason: McpLaunchError['reason'], message: string) {
    super(message);
    this.name = 'McpLaunchError';
    this.reason = reason;
  }
}

const isWindows = () => process.platform === 'win32';
const SCRIPTS = /\.(cmd|bat|ps1|vbs)$/i;

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Um programa do PATH (só pastas absolutas). No Windows só `.exe` e `.com`: um `.cmd` ou `.bat`
 * precisava de uma shell, e a Solline nunca arranca nada por shell.
 */
export function findExecutable(
  name: string,
  pathEnv: string = process.env.PATH ?? '',
): string | null {
  const names = isWindows()
    ? /\.(exe|com)$/i.test(name)
      ? [name]
      : [`${name}.exe`, `${name}.com`]
    : [name];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      if (!isFile(file)) continue;
      if (!isWindows()) {
        try {
          accessSync(file, constants.X_OK);
        } catch {
          continue;
        }
      }
      return file;
    }
  }
  return null;
}

/** O npx-cli.js que vem com o npm junto do Node (o npx.cmd precisava de uma shell). */
export function findNpxCli(node: string): string | null {
  const dir = path.dirname(node);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  const link = path.join(dir, 'npx');
  try {
    if (existsSync(link)) candidates.push(realpathSync(link));
  } catch {
    // Sem ligação legível: ficam os caminhos habituais.
  }
  return candidates.find(isFile) ?? null;
}

export interface Resolved {
  command: string;
  args: string[];
}

/**
 * O comando aprovado como se arranca de verdade: caminho absoluto e sem shell. `npx` corre-se
 * pelo Node do sistema (o mesmo `findNode` do catálogo); o resto procura-se no PATH. Os
 * argumentos são os aprovados, sem mais nem menos.
 */
export function resolveCommand(
  spec: { command: string; args: readonly string[] },
  options: { node: () => string | null; pathEnv?: string },
): Resolved {
  const { command, args } = spec;
  if (command === 'npx') {
    const node = options.node();
    if (!node)
      throw new McpLaunchError('unavailable', 'Falta o Node.js no PATH (o servidor corre por npx)');
    const cli = findNpxCli(node);
    if (!cli) throw new McpLaunchError('unavailable', 'Falta o npx junto do Node.js do sistema');
    return { command: node, args: [cli, ...args] };
  }
  if (isWindows() && SCRIPTS.test(command))
    throw new McpLaunchError(
      'unavailable',
      'Um .cmd, .bat ou script precisa de shell: aponta para o executável (.exe)',
    );
  if (path.isAbsolute(command)) {
    if (!isFile(command)) throw new McpLaunchError('unavailable', `Não encontro ${command}`);
    return { command, args: [...args] };
  }
  if (/[\\/]/.test(command))
    throw new McpLaunchError('unavailable', 'O comando é um nome do PATH ou um caminho absoluto');
  const found = findExecutable(command, options.pathEnv);
  if (!found) throw new McpLaunchError('unavailable', `Não encontro ${command} no PATH`);
  return { command: found, args: [...args] };
}
