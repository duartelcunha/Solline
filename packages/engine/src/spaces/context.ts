import { lstat, readdir, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project } from '@solline/protocol';
import { digest } from './manager.ts';
import { resolveGit } from '../checkpoints/git.ts';

export interface ContextSource {
  id: string;
  projectId: string | null;
  text: string;
}
const exec = promisify(execFile);
const BLOCKED =
  /(^|[/\\])(?:\.git|\.env[^/\\]*|\.ssh|\.codex|\.claude|node_modules|dist|out|release|coverage|qa-evidence|\.cache|\.pnpm|vendor|build|.*(?:secret|credential|password|token).*|\.npmrc|\.pypirc)(?:[/\\]|$)/i;
const EXTENSION =
  /\.(?:[cm]?[jt]sx?|json|md|css|html|py|rs|go|java|kt|swift|vue|svelte|toml|ya?ml)$/i;
const MAX_FILES = 200;
export function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      '[chave privada omitida]',
    )
    .split('\n')
    .map((line) =>
      /(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]+|github_pat_|AIza[a-zA-Z0-9_-]+|AKIA[A-Z0-9]+|-----BEGIN .*PRIVATE KEY|[\w-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[\w-]*["']?\s*[:=]\s*["'][^"']+["'])/i.test(
        line,
      )
        ? '[linha omitida: possível segredo]'
        : line,
    )
    .join('\n');
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
async function fallback(root: string, relative = '', entries: string[] = []): Promise<string[]> {
  if (relative.split(path.sep).length > 8 || entries.length >= 1000) return entries;
  const children = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, child.name);
    if (BLOCKED.test(name) || child.isSymbolicLink()) continue;
    if (child.isDirectory()) await fallback(root, name, entries);
    else if (child.isFile()) entries.push(name);
    if (entries.length >= 1000) break;
  }
  return entries;
}
export async function collectProject(
  project: Project,
): Promise<{ sources: ContextSource[]; files: Record<string, string> }> {
  if (!project.trusted) throw new Error('A análise só lê projetos autorizados e de confiança.');
  const root = await realpath(project.path);
  let names: string[];
  try {
    const git = resolveGit();
    if (!git) throw new Error('Git is unavailable');
    const result = await exec(
      git,
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        'ls-files',
        '-co',
        '--exclude-standard',
        '-z',
      ],
      {
        cwd: root,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 2_000_000,
      },
    );
    names = result.stdout.split('\0').filter(Boolean);
  } catch {
    names = await fallback(root);
  }
  const sources: ContextSource[] = [];
  const files: Record<string, string> = {};
  for (const name of [...new Set(names)].sort()) {
    if (sources.length >= MAX_FILES) break;
    if (BLOCKED.test(name) || !EXTENSION.test(name) || name.includes('lock.')) continue;
    const candidate = path.resolve(root, name);
    if (!inside(root, candidate)) continue;
    try {
      const stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) continue;
      const canonical = await realpath(candidate);
      if (!inside(root, canonical)) continue;
      const text = await readFile(canonical, 'utf8');
      if (text.includes('\0') || !inside(root, await realpath(candidate))) continue;
      const id = `${project.id}:${name.replaceAll('\\', '/')}`;
      files[id] = digest(text);
      sources.push({ id, projectId: project.id, text: redact(text).slice(0, 24_000) });
    } catch {
      /* A removed/unreadable file is absent from this context snapshot. */
    }
  }
  return { sources, files };
}
