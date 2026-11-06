/** `owner/repo` a partir do origin. Nunca devolve utilizador, token ou URL. */
export function repoFromRemote(remote: string): string | null {
  const cleaned = remote.trim().replace(/\.git$/i, '');
  const ssh = cleaned.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/);
  if (ssh?.[1] && ssh[2]) return pair(ssh[1], ssh[2]);
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null;
  if (url.hostname !== 'github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0];
  const name = parts[1];
  if (!owner || !name) return null;
  return pair(owner, name);
}

function pair(owner: string, name: string): string | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  return `${owner}/${name}`;
}

/** O branch da worktree. Outro nome não se envia. */
export function worktreeBranch(branch: string): boolean {
  return (
    /^solline\/[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(branch) &&
    !branch.includes('..') &&
    !branch.endsWith('.')
  );
}
