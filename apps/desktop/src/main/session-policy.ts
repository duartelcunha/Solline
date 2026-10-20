import { realpath, stat } from 'node:fs/promises';
import type { CommandPayload, Project, SessionStartPayload } from '@solline/protocol';

export interface ProjectLookup {
  get(id: string): Promise<Project | undefined>;
}

/** Devolve o caminho real da pasta (junções e links resolvidos) ou undefined se não for pasta. */
type RealDirectory = (path: string) => Promise<string | undefined>;

const realDirectory: RealDirectory = async (path) => {
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Uma sessão só abre numa pasta local com caminho absoluto. Caminhos de rede (\\servidor\...)
 * e de dispositivo (\\?\..., \\.\...) ficam de fora: começam todos por duas barras.
 */
export function assertLocalFolder(
  path: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (path.includes('\0')) throw new Error('Caminho de pasta inválido');
  if (/^[\\/]{2}/.test(path)) {
    throw new Error('Pastas de rede ou de dispositivo não podem ser projetos');
  }
  const absolute = platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith('/');
  if (!absolute) throw new Error('A pasta do projeto tem de ser um caminho absoluto');
}

/**
 * Troca o projeto pedido pela interface pela pasta guardada. A interface nunca escolhe
 * a pasta de uma sessão: um projeto desconhecido, uma pasta apagada ou uma pasta que,
 * resolvida, aponta para a rede ou para um dispositivo param aqui.
 */
export async function resolveSessionStart(
  store: ProjectLookup,
  payload: CommandPayload<'session.create'>,
  resolveDirectory: RealDirectory = realDirectory,
  platform: NodeJS.Platform = process.platform,
): Promise<SessionStartPayload> {
  const project = await store.get(payload.projectId);
  if (!project) throw new Error('Projeto desconhecido');
  assertLocalFolder(project.path, platform);
  const cwd = await resolveDirectory(project.path);
  if (!cwd) throw new Error('A pasta do projeto já não existe');
  // Uma junção ou um link na pasta guardada pode apontar para fora: vale o destino.
  assertLocalFolder(cwd, platform);
  return {
    ...payload,
    cwd,
    trusted: project.trusted,
    checks: project.checks ?? null,
    setup: project.setup ?? null,
  };
}
