import { describe, expect, it } from 'vitest';
import type { Project } from '@solline/protocol';
import { resolveSessionStart, type ProjectLookup } from './session-policy.ts';

const project: Project = {
  id: 'p1',
  path: 'C:/code/app',
  name: 'app',
  addedAt: 0,
  trusted: false,
};
const store: ProjectLookup = { get: async (id) => (id === project.id ? project : undefined) };
const exists = async () => true;

describe('resolveSessionStart', () => {
  it('a pasta vem sempre do projeto guardado', async () => {
    const start = await resolveSessionStart(
      store,
      { projectId: 'p1', agent: 'claude', mode: 'plan' },
      exists,
    );
    expect(start).toEqual({
      projectId: 'p1',
      agent: 'claude',
      mode: 'plan',
      cwd: project.path,
      trusted: false,
      checks: null,
    });
  });

  it('uma pasta ou confiança que venham no pedido nunca ganham às do projeto', async () => {
    const forged = {
      projectId: 'p1',
      agent: 'claude',
      cwd: 'C:/Windows',
      trusted: true,
    } as unknown as Parameters<typeof resolveSessionStart>[1];
    const start = await resolveSessionStart(store, forged, exists);
    expect(start.cwd).toBe(project.path);
    expect(start.trusted).toBe(false);
  });

  it('um projeto desconhecido não abre sessão', async () => {
    await expect(
      resolveSessionStart(store, { projectId: 'outro', agent: 'claude' }, exists),
    ).rejects.toThrow('Projeto desconhecido');
  });

  it('uma pasta que já não existe não abre sessão', async () => {
    await expect(
      resolveSessionStart(store, { projectId: 'p1', agent: 'claude' }, async () => false),
    ).rejects.toThrow('já não existe');
  });
});
