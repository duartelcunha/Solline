import { stat } from 'node:fs/promises';
import type { CommandPayload, Project, SessionStartPayload } from '@solline/protocol';

export interface ProjectLookup {
  get(id: string): Promise<Project | undefined>;
}

type IsDirectory = (path: string) => Promise<boolean>;

const isDirectory: IsDirectory = (path) =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );

/**
 * Troca o projeto pedido pela interface pela pasta guardada. A interface nunca escolhe
 * a pasta de uma sessão: um projeto desconhecido ou uma pasta apagada param aqui.
 */
export async function resolveSessionStart(
  store: ProjectLookup,
  payload: CommandPayload<'session.create'>,
  exists: IsDirectory = isDirectory,
): Promise<SessionStartPayload> {
  const project = await store.get(payload.projectId);
  if (!project) throw new Error('Projeto desconhecido');
  if (!(await exists(project.path))) throw new Error('A pasta do projeto já não existe');
  return { ...payload, cwd: project.path };
}
