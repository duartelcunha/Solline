import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectStore, newCommands } from './projects.ts';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'solline-projects-'));
  file = join(dir, 'projects.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ProjectStore', () => {
  it('os projetos da versão 1 ficam de confiança, como já se comportavam', async () => {
    const old = { id: 'a', path: join(dir, 'app'), name: 'app', addedAt: 1 };
    await writeFile(file, JSON.stringify({ version: 1, projects: [old] }));
    const store = new ProjectStore(file);
    expect(await store.list()).toEqual([{ ...old, trusted: true }]);
  });

  it('um projeto novo guarda a confiança escolhida e grava na versão 2', async () => {
    const store = new ProjectStore(file);
    const project = await store.add(join(dir, 'novo'), false);
    expect(project.trusted).toBe(false);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number };
    expect(saved.version).toBe(2);
    expect(await new ProjectStore(file).list()).toEqual([project]);
  });

  it('mudar a confiança grava e devolve o projeto atualizado', async () => {
    const store = new ProjectStore(file);
    const project = await store.add(join(dir, 'novo'), false);
    expect(await store.setTrusted(project.id, true)).toEqual({ ...project, trusted: true });
    expect((await new ProjectStore(file).get(project.id))?.trusted).toBe(true);
    await expect(store.setTrusted('nao-existe', true)).rejects.toThrow('Projeto desconhecido');
  });

  it('encontra a mesma pasta sem distinguir maiúsculas no Windows', async () => {
    const store = new ProjectStore(file);
    const project = await store.add(join(dir, 'App'), true);
    const found = await store.find(join(dir, process.platform === 'win32' ? 'APP' : 'App'));
    expect(found?.id).toBe(project.id);
  });
});

describe('verificações do projeto', () => {
  const check = (command: string, enabled = true) => ({
    id: command.replace(/\W/g, ''),
    label: 'x',
    command,
    enabled,
  });

  it('só um comando novo pede confirmação; ligar ou desligar não', () => {
    const before = [check('pnpm lint'), check('pnpm test', false)];
    expect(newCommands(before, [check('pnpm lint', false), check('pnpm test')])).toEqual([]);
    expect(newCommands(before, [check('pnpm lint'), check('rm -rf .')])).toEqual(['rm -rf .']);
  });

  it('a lista guarda-se por projeto e volta a null', async () => {
    const store = new ProjectStore(file);
    const project = await store.add(dir, true);
    await store.setChecks(project.id, [check('pnpm lint')]);
    const again = new ProjectStore(file);
    expect((await again.get(project.id))?.checks).toEqual([check('pnpm lint')]);
    await again.setChecks(project.id, null);
    expect((await new ProjectStore(file).get(project.id))?.checks).toBeNull();
  });
});

describe('ProjectStore.add: pastas de rede e de dispositivo', () => {
  it.each([
    '\\\\servidor\\partilha\\app',
    '\\\\?\\C:\\code',
    '\\\\.\\PhysicalDrive0',
    '//servidor/app',
  ])('não guarda %s como projeto', async (path) => {
    const store = new ProjectStore(file);
    await expect(store.add(path, false)).rejects.toThrow('rede ou de dispositivo');
    expect(await store.list()).toEqual([]);
  });
});
