import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectProject } from '../src/spaces/context.ts';
import { gitCommitExists } from '../src/memory/evidence.ts';

const git = vi.hoisted(() => ({
  resolve: vi.fn(),
  exec: vi.fn(),
  execAsync: vi.fn(),
}));
vi.mock('../src/checkpoints/git.ts', () => ({ resolveGit: git.resolve }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(git.exec, { [promisify.custom]: git.execAsync }),
}));

let root: string;
const executable = path.resolve('trusted-tools', process.platform === 'win32' ? 'git.exe' : 'git');
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), 'solline-git-resolution-'));
  await writeFile(path.join(root, 'main.ts'), 'export const value = 1;');
  git.resolve.mockReturnValue(executable);
  git.execAsync.mockResolvedValue({ stdout: 'main.ts\0', stderr: '' });
  git.exec.mockImplementation((_file, _args, _options, callback) => callback(null));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('collects context with the resolved executable instead of a repository-local git', async () => {
  const result = await collectProject({
    id: 'p',
    path: root,
    name: 'P',
    trusted: true,
    addedAt: 0,
  });
  expect(result.sources.map((source) => source.id)).toEqual(['p:main.ts']);
  expect(git.execAsync).toHaveBeenCalledWith(
    executable,
    expect.arrayContaining(['ls-files']),
    expect.objectContaining({ cwd: await realpath(root) }),
  );
});

it('falls back to file collection without launching a bare git when resolution fails', async () => {
  git.resolve.mockReturnValue(null);
  const result = await collectProject({
    id: 'p',
    path: root,
    name: 'P',
    trusted: true,
    addedAt: 0,
  });
  expect(result.sources.map((source) => source.id)).toEqual(['p:main.ts']);
  expect(git.execAsync).not.toHaveBeenCalled();
});

it('checks commit evidence with the resolved executable instead of a repository-local git', async () => {
  await expect(gitCommitExists(root, 'abc1234')).resolves.toBe(true);
  expect(git.exec).toHaveBeenCalledWith(
    executable,
    ['cat-file', '-e', 'abc1234^{commit}'],
    expect.objectContaining({ cwd: root }),
    expect.any(Function),
  );
});

it('rejects commit evidence without launching a bare git when resolution fails', async () => {
  git.resolve.mockReturnValue(null);
  await expect(gitCommitExists(root, 'abc1234')).resolves.toBe(false);
  expect(git.exec).not.toHaveBeenCalled();
});

it('rejects commit evidence when the resolved git reports an error', async () => {
  git.exec.mockImplementation((_file, _args, _options, callback) => callback(new Error('missing')));
  await expect(gitCommitExists(root, 'abc1234')).resolves.toBe(false);
});
