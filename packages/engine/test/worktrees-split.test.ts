import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeManager } from '../src/worktrees/worktrees.ts';

let root: string;
let project: string;
let manager: WorktreeManager;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'solline-wt-split-'));
  project = path.join(root, 'project');
  await mkdir(project);
  git(project, 'init', '--quiet', '-b', 'main');
  git(project, 'config', 'user.email', 'teste@solline.local');
  git(project, 'config', 'user.name', 'Teste');
  git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, 'a.txt'), 'um\ndois\ntres\n');
  await writeFile(path.join(project, 'b.txt'), 'b\n');
  git(project, 'add', '-A');
  git(project, 'commit', '--quiet', '-m', 'início');
  manager = new WorktreeManager({ root: path.join(root, 'data', 'worktrees') });
}, 30_000);

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('worktrees de repartições', { timeout: 60_000 }, () => {
  it('createAfter grava o trabalho da irmã e parte desse commit, sem mexer na base dela', async () => {
    const first = (await manager.create(project, 'p1'))!;
    await writeFile(path.join(first.cwd, 'novo.txt'), 'da primeira\n');
    await writeFile(path.join(first.cwd, 'a.txt'), 'mudado\n');
    const second = await manager.createAfter(first);

    expect(await readFile(path.join(second.cwd, 'novo.txt'), 'utf8')).toBe('da primeira\n');
    expect(await readFile(path.join(second.cwd, 'a.txt'), 'utf8')).toBe('mudado\n');
    // A base da nova é o commit da irmã; a base da irmã não mudou.
    expect(second.base).toBe(git(first.path, 'rev-parse', 'HEAD'));
    expect(second.base).not.toBe(first.base);
    expect(git(first.path, 'status', '--porcelain')).toBe('');
    expect(await manager.stats(first)).toEqual({ files: 2, additions: 2, deletions: 3 });
    // A nova ainda não mudou nada face à sua base.
    expect(await manager.stats(second)).toEqual({ files: 0, additions: 0, deletions: 0 });
    expect(second.branch).not.toBe(first.branch);

    // Uma irmã limpa não ganha commits: a segunda chamada parte do mesmo commit.
    const third = await manager.createAfter(first);
    expect(third.base).toBe(second.base);
  });

  it('collisions acha o conflito real entre duas worktrees e nada entre as que não se tocam', async () => {
    const one = (await manager.create(project, 'p1'))!;
    const two = (await manager.create(project, 'p1'))!;
    const three = (await manager.create(project, 'p1'))!;
    // Uma e duas mexem na mesma linha de a.txt (por gravar); a três só em b.txt.
    await writeFile(path.join(one.cwd, 'a.txt'), 'um\nda um\ntres\n');
    await writeFile(path.join(two.cwd, 'a.txt'), 'um\nda dois\ntres\n');
    await writeFile(path.join(two.cwd, 'extra.txt'), 'só da dois\n');
    await writeFile(path.join(three.cwd, 'b.txt'), 'b mudado\n');

    const headsBefore = [one, two, three].map((wt) => git(wt.path, 'rev-parse', 'HEAD'));
    expect(await manager.collisions(one, two)).toEqual(['a.txt']);
    expect(await manager.collisions(two, one)).toEqual(['a.txt']);
    expect(await manager.collisions(one, three)).toEqual([]);
    expect(await manager.collisions(two, three)).toEqual([]);

    // Nada mudou nos agentes: os branches estão onde estavam, o índice não ganhou nada e os
    // ficheiros por gravar continuam por gravar.
    expect([one, two, three].map((wt) => git(wt.path, 'rev-parse', 'HEAD'))).toEqual(headsBefore);
    expect(git(two.path, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(two.path, 'status', '--porcelain')).toContain('?? extra.txt');
    expect(await readFile(path.join(one.cwd, 'a.txt'), 'utf8')).toBe('um\nda um\ntres\n');
    expect(git(project, 'branch', '--list').split('\n')).toHaveLength(4);
  });

  it('collisions conta ficheiros novos que se chocam e ignora um merge limpo da mesma linha', async () => {
    const one = (await manager.create(project, 'p1'))!;
    const two = (await manager.create(project, 'p1'))!;
    await writeFile(path.join(one.cwd, 'novo.txt'), 'versão um\n');
    await writeFile(path.join(two.cwd, 'novo.txt'), 'versão dois\n');
    // Linhas diferentes do mesmo ficheiro juntam-se sem conflito.
    await writeFile(path.join(one.cwd, 'a.txt'), 'UM\ndois\ntres\n');
    await writeFile(path.join(two.cwd, 'a.txt'), 'um\ndois\nTRES\n');
    expect(await manager.collisions(one, two)).toEqual(['novo.txt']);
  });
});
