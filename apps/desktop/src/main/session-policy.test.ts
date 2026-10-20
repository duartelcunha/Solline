import { describe, expect, it } from 'vitest';
import type { Project } from '@solline/protocol';
import { assertLocalFolder, resolveSessionStart, type ProjectLookup } from './session-policy.ts';

const project: Project = {
  id: 'p1',
  path: 'C:\\code\\app',
  name: 'app',
  addedAt: 0,
  trusted: false,
};
const storeWith = (p: Project): ProjectLookup => ({
  get: async (id) => (id === p.id ? p : undefined),
});
const store = storeWith(project);
const same = async (path: string) => path;

describe('resolveSessionStart', () => {
  it('a pasta vem sempre do projeto guardado', async () => {
    const start = await resolveSessionStart(
      store,
      { projectId: 'p1', agent: 'claude', mode: 'plan' },
      same,
      'win32',
    );
    expect(start).toEqual({
      projectId: 'p1',
      agent: 'claude',
      mode: 'plan',
      cwd: project.path,
      trusted: false,
      checks: null,
      setup: null,
    });
  });

  it('uma pasta ou confiança que venham no pedido nunca ganham às do projeto', async () => {
    const forged = {
      projectId: 'p1',
      agent: 'claude',
      cwd: 'C:/Windows',
      trusted: true,
    } as unknown as Parameters<typeof resolveSessionStart>[1];
    const start = await resolveSessionStart(store, forged, same, 'win32');
    expect(start.cwd).toBe(project.path);
    expect(start.trusted).toBe(false);
  });

  it('usa o caminho real da pasta', async () => {
    const start = await resolveSessionStart(
      store,
      { projectId: 'p1', agent: 'claude' },
      async () => 'D:\\real\\app',
      'win32',
    );
    expect(start.cwd).toBe('D:\\real\\app');
  });

  it('um projeto desconhecido não abre sessão', async () => {
    await expect(
      resolveSessionStart(store, { projectId: 'outro', agent: 'claude' }, same, 'win32'),
    ).rejects.toThrow('Projeto desconhecido');
  });

  it('uma pasta que já não existe não abre sessão', async () => {
    await expect(
      resolveSessionStart(
        store,
        { projectId: 'p1', agent: 'claude' },
        async () => undefined,
        'win32',
      ),
    ).rejects.toThrow('já não existe');
  });

  it.each([
    '\\\\servidor\\partilha\\app',
    '\\\\?\\C:\\code\\app',
    '\\\\.\\PhysicalDrive0',
    '//servidor/app',
  ])('um projeto guardado em %s não abre sessão', async (path) => {
    await expect(
      resolveSessionStart(
        storeWith({ ...project, path }),
        { projectId: 'p1', agent: 'claude' },
        same,
        'win32',
      ),
    ).rejects.toThrow('rede ou de dispositivo');
  });

  it('uma junção que aponta para a rede não abre sessão', async () => {
    await expect(
      resolveSessionStart(
        store,
        { projectId: 'p1', agent: 'claude' },
        async () => '\\\\servidor\\partilha',
        'win32',
      ),
    ).rejects.toThrow('rede ou de dispositivo');
  });
});

describe('assertLocalFolder', () => {
  it('aceita pastas locais absolutas', () => {
    expect(() => assertLocalFolder('C:\\code\\app', 'win32')).not.toThrow();
    expect(() => assertLocalFolder('/srv/code/app', 'linux')).not.toThrow();
  });

  it('recusa caminhos relativos, sem letra de disco ou com NUL', () => {
    expect(() => assertLocalFolder('code\\app', 'win32')).toThrow('absoluto');
    expect(() => assertLocalFolder('\\code\\app', 'win32')).toThrow('absoluto');
    expect(() => assertLocalFolder('C:app', 'win32')).toThrow('absoluto');
    expect(() => assertLocalFolder('C:\\code\0', 'win32')).toThrow('inválido');
  });
});
