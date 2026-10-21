import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeManager, slug } from '../src/worktrees/worktrees.ts';

let root: string;
let project: string;
let manager: WorktreeManager;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solline-wt-'));
  project = path.join(root, 'project');
  await mkdir(project);
  git(project, 'init', '--quiet', '-b', 'main');
  git(project, 'config', 'user.email', 'teste@solline.local');
  git(project, 'config', 'user.name', 'Teste');
  git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, 'a.txt'), 'um\n');
  git(project, 'add', '-A');
  git(project, 'commit', '--quiet', '-m', 'início');
  manager = new WorktreeManager({ root: path.join(root, 'data', 'worktrees') });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('worktrees das sessões', { timeout: 30_000 }, () => {
  it('o nome do branch vem da primeira mensagem', () => {
    expect(slug('Corrige o login do Ângelo, por favor!')).toBe('corrige-o-login-do');
    expect(slug('???')).toBe('sessao');
  });

  it('cria a worktree fora do projeto, conta as mudanças e traz por merge', async () => {
    const wt = (await manager.create(project, 'p1'))!;
    expect(wt.path.startsWith(manager.root)).toBe(true);
    expect(git(project, 'branch', '--list', wt.branch)).toContain(wt.branch);

    const named = await manager.rename(wt, 'Muda o ficheiro a');
    expect(named.branch).toBe(`solline/muda-o-ficheiro-a-${wt.suffix}`);

    await writeFile(path.join(named.cwd, 'a.txt'), 'dois\n');
    await writeFile(path.join(named.cwd, 'b.txt'), 'novo\n');
    expect(await manager.stats(named)).toEqual({ files: 2, additions: 2, deletions: 1 });
    // O projeto não mudou enquanto a sessão trabalha na worktree.
    expect(await readFile(path.join(project, 'a.txt'), 'utf8')).toBe('um\n');

    const { result, wt: brought } = await manager.bring(named, 'Solline: muda o a');
    expect(result).toEqual({ merged: true, conflicts: [], into: 'main' });
    expect(await readFile(path.join(project, 'a.txt'), 'utf8')).toBe('dois\n');
    expect(await manager.stats(brought)).toEqual({ files: 0, additions: 0, deletions: 0 });

    await manager.remove(brought, true);
    expect(await exists(brought.path)).toBe(false);
    expect(git(project, 'branch', '--list', brought.branch)).toBe('');
  });

  it('com conflitos não mexe no projeto e devolve os ficheiros', async () => {
    const wt = (await manager.create(project, 'p1'))!;
    await writeFile(path.join(wt.cwd, 'a.txt'), 'da sessão\n');
    await writeFile(path.join(project, 'a.txt'), 'do projeto\n');
    git(project, 'commit', '--quiet', '-am', 'no projeto');
    const { result } = await manager.bring(wt, 'Solline: conflito');
    expect(result).toEqual({ merged: false, conflicts: ['a.txt'], into: 'main' });
    expect(await readFile(path.join(project, 'a.txt'), 'utf8')).toBe('do projeto\n');
    expect(git(project, 'status', '--porcelain')).toBe('');
  });

  it('pasta sem git não tem worktree; as que ficaram aparecem como órfãs', async () => {
    const plain = path.join(root, 'sem-git');
    await mkdir(plain);
    expect(await manager.create(plain, 'p2')).toBeNull();

    const wt = (await manager.create(project, 'p1'))!;
    expect(await manager.orphans(new Set([wt.path]))).toEqual([]);
    const orphans = await manager.orphans(new Set());
    expect(orphans.map((o) => o.branch)).toEqual([wt.branch]);
  });

  it('uma subpasta do repositório trabalha na mesma subpasta da worktree', async () => {
    const sub = path.join(project, 'app');
    await mkdir(sub);
    await writeFile(path.join(sub, 'x.txt'), 'x\n');
    git(project, 'add', '-A');
    git(project, 'commit', '--quiet', '-m', 'app');
    const wt = (await manager.create(sub, 'p1'))!;
    expect(wt.cwd).toBe(path.join(wt.path, 'app'));
    expect(await readFile(path.join(wt.cwd, 'x.txt'), 'utf8')).toBe('x\n');
  });
});
