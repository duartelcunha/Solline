import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { Project, type CheckSpec, type SetupSpec } from '@solline/protocol';
import { assertLocalFolder } from './session-policy.ts';

/** v1 não tinha confiança: os projetos que já lá estavam ficam de confiança (como antes). */
const ProjectsFileV1 = z.object({
  version: z.literal(1),
  projects: z.array(Project.omit({ trusted: true })),
});
const ProjectsFile = z.object({ version: z.literal(2), projects: z.array(Project) });

function parseFile(raw: unknown): Project[] {
  const v2 = ProjectsFile.safeParse(raw);
  if (v2.success) return v2.data.projects;
  const v1 = ProjectsFileV1.safeParse(raw);
  return v1.success ? v1.data.projects.map((p) => ({ ...p, trusted: true })) : [];
}

/** Os comandos da lista nova que ainda não estavam na antiga: só esses pedem confirmação. */
export function newCommands(before: readonly CheckSpec[], after: readonly CheckSpec[]): string[] {
  const known = new Set(before.map((c) => c.command));
  return [...new Set(after.map((c) => c.command).filter((c) => !known.has(c)))];
}

/** Pastas que o Duarte abriu na Solline, guardadas num JSON na pasta de dados da app. */
export class ProjectStore {
  readonly #file: string;
  #cache: Project[] | undefined;

  constructor(file: string) {
    this.#file = file;
  }

  async list(): Promise<Project[]> {
    if (this.#cache) return this.#cache;
    try {
      this.#cache = parseFile(JSON.parse(await readFile(this.#file, 'utf8')));
    } catch {
      this.#cache = [];
    }
    return this.#cache;
  }

  async get(id: string): Promise<Project | undefined> {
    return (await this.list()).find((p) => p.id === id);
  }

  /** Junta uma pasta local; se já lá estiver, devolve a que existe. Rede e dispositivos não. */
  async add(folder: string, trusted: boolean): Promise<Project> {
    assertLocalFolder(folder);
    const path = resolve(folder);
    assertLocalFolder(path);
    const projects = await this.list();
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    const existing = projects.find(
      (p) => (process.platform === 'win32' ? p.path.toLowerCase() : p.path) === key,
    );
    if (existing) return existing;
    const project: Project = {
      id: randomUUID(),
      path,
      name: basename(path) || path,
      addedAt: Date.now(),
      trusted,
    };
    this.#cache = [...projects, project];
    await this.#save();
    return project;
  }

  /** Procura a pasta entre os projetos guardados (sem maiúsculas no Windows). */
  async find(folder: string): Promise<Project | undefined> {
    const path = resolve(folder);
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    return (await this.list()).find(
      (p) => (process.platform === 'win32' ? p.path.toLowerCase() : p.path) === key,
    );
  }

  async setTrusted(id: string, trusted: boolean): Promise<Project> {
    const projects = await this.list();
    const current = projects.find((p) => p.id === id);
    if (!current) throw new Error('Projeto desconhecido');
    const project = { ...current, trusted };
    this.#cache = projects.map((p) => (p.id === id ? project : p));
    await this.#save();
    return project;
  }

  /** Guarda as verificações do projeto (null: volta às do package.json). */
  async setChecks(id: string, checks: CheckSpec[] | null): Promise<Project> {
    const projects = await this.list();
    const current = projects.find((p) => p.id === id);
    if (!current) throw new Error('Projeto desconhecido');
    const project = { ...current, checks };
    this.#cache = projects.map((p) => (p.id === id ? project : p));
    await this.#save();
    return project;
  }

  /** Guarda como se preparam as worktrees do projeto (null: a sugestão). */
  async setSetup(id: string, setup: SetupSpec | null): Promise<Project> {
    const projects = await this.list();
    const current = projects.find((p) => p.id === id);
    if (!current) throw new Error('Projeto desconhecido');
    const project = { ...current, setup };
    this.#cache = projects.map((p) => (p.id === id ? project : p));
    await this.#save();
    return project;
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(this.#file, JSON.stringify({ version: 2, projects: this.#cache }, null, 2));
  }
}
