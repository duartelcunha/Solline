import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { Project } from '@solline/protocol';

const ProjectsFile = z.object({ version: z.literal(1), projects: z.array(Project) });

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
      const parsed = ProjectsFile.safeParse(JSON.parse(await readFile(this.#file, 'utf8')));
      this.#cache = parsed.success ? parsed.data.projects : [];
    } catch {
      this.#cache = [];
    }
    return this.#cache;
  }

  async get(id: string): Promise<Project | undefined> {
    return (await this.list()).find((p) => p.id === id);
  }

  /** Junta uma pasta; se já lá estiver, devolve a que existe. */
  async add(folder: string): Promise<Project> {
    const path = resolve(folder);
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
    };
    this.#cache = [...projects, project];
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(this.#file, JSON.stringify({ version: 1, projects: this.#cache }, null, 2));
    return project;
  }
}
