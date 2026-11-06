import path from 'node:path';
import {
  Issue,
  type IssueList,
  type Project,
  type SessionStartPayload,
} from '@solline/protocol';
import { resolveGh, runGh, type GhResult } from './gh.ts';

/** O corpo que segue na primeira mensagem. O resto fica no GitHub. */
const BODY_LIMIT = 8_000;

export type GhRun = (executable: string, args: string[], cwd: string) => Promise<GhResult>;

export function issuePrompt(issue: Pick<Issue, 'key' | 'title' | 'body'>): string {
  const title = issue.title.trim();
  const body = issue.body.trim().slice(0, BODY_LIMIT);
  const head = `#${issue.key} ${title}`.trim();
  return body ? `${head}\n\n${body}` : head;
}

export function sessionTitle(title: string): string {
  const clean = title.trim().replace(/\s+/g, ' ');
  return (clean || 'Issue').slice(0, 80);
}

export class IssueService {
  constructor(private readonly options: { gh?: string | null; run?: GhRun } = {}) {}

  list(cwd: string, projectId: string): Promise<IssueList> {
    const gh = this.options.gh === undefined ? resolveGh() : this.options.gh;
    return listGithubIssues({
      cwd,
      projectId,
      gh,
      ...(this.options.run ? { run: this.options.run } : {}),
    });
  }
}

export async function listGithubIssues(options: {
  cwd: string;
  projectId: string;
  gh: string | null;
  run?: GhRun;
}): Promise<IssueList> {
  if (!options.gh || !path.isAbsolute(options.gh)) return { issues: [], unavailable: 'missing' };
  const run = options.run ?? runGh;
  const result = await run(
    options.gh,
    ['issue', 'list', '--json', 'number,title,body', '--limit', '100'],
    options.cwd,
  );
  if (result.code !== 0) {
    const text = `${result.stderr}\n${result.stdout}`;
    if (/auth login|not logged|gh auth|HTTP 401|authentication/i.test(text)) {
      return { issues: [], unavailable: 'logged-out' };
    }
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(detail || 'O gh não conseguiu listar as issues.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('O gh devolveu uma lista inválida.');
  }
  if (!Array.isArray(parsed)) throw new Error('O gh devolveu uma lista inválida.');
  const issues = parsed.flatMap((item) => {
    const issue = mapIssue(item, options.projectId);
    return issue ? [issue] : [];
  });
  return { issues, unavailable: null };
}

function mapIssue(item: unknown, projectId: string): Issue | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as { number?: unknown; title?: unknown; body?: unknown };
  if (typeof row.number !== 'number' || !Number.isInteger(row.number) || row.number < 1) return null;
  const key = String(row.number);
  const title = typeof row.title === 'string' ? row.title.trim().slice(0, 300) : '';
  if (!title) return null;
  const raw = typeof row.body === 'string' ? row.body.trim() : '';
  const body = raw.length > BODY_LIMIT ? `${raw.slice(0, BODY_LIMIT - 1)}…` : raw;
  const parsed = Issue.safeParse({
    id: `gh-${key}`,
    projectId,
    provider: 'github',
    key,
    title,
    body,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Abre a sessão da issue. O agente é o Claude: o comando só traz ids, e o Claude é o primeiro
 * agente da app. A pasta e a confiança vêm do projeto que o main sincronizou.
 */
export async function openListedIssue(input: {
  project: Project;
  issueId: string;
  list: IssueList;
  start(payload: SessionStartPayload): Promise<string>;
  send(sessionId: string, text: string): Promise<void>;
}): Promise<{ sessionId: string }> {
  if (input.list.unavailable === 'missing') throw new Error('Não encontrei o gh.');
  if (input.list.unavailable === 'logged-out') {
    throw new Error('O gh não tem sessão. Entra com gh auth login.');
  }
  const issue = input.list.issues.find((item) => item.id === input.issueId);
  if (!issue) throw new Error('Esta issue já não está na lista.');
  const sessionId = await input.start({
    projectId: input.project.id,
    agent: 'claude',
    cwd: input.project.path,
    trusted: input.project.trusted,
    checks: input.project.checks ?? null,
    setup: input.project.setup ?? null,
    title: sessionTitle(issue.title),
    worktree: 'always',
  });
  await input.send(sessionId, issuePrompt(issue));
  return { sessionId };
}
