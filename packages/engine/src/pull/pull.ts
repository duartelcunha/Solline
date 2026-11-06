import path from 'node:path';
import { PullRequest, type CiCheck, type CiResult, type PullState } from '@solline/protocol';
import { resolveGh, runGh } from './gh.ts';
import type { GhRun } from './issues.ts';

export type { GhRun };

interface Opened {
  sessionId: string;
  cwd: string;
  number: number;
}

/** Os PR abertos nesta execução. A CI só os lê por id. */
export class PullService {
  #opened = new Map<string, Opened>();
  constructor(private readonly options: { gh?: string | null; run?: GhRun } = {}) {}

  remember(pr: { id: string; sessionId: string; cwd: string; number: number }): void {
    this.#opened.set(pr.id, { sessionId: pr.sessionId, cwd: pr.cwd, number: pr.number });
  }

  async open(input: {
    cwd: string;
    branch: string;
    sessionId: string;
    title: string;
    body: string;
  }): Promise<PullRequest> {
    const gh = this.#gh();
    if (!gh) throw new Error('Não encontrei o gh.');
    const run = this.options.run ?? runGh;
    const created = await run(
      gh,
      ['pr', 'create', '--title', input.title, '--body', input.body, '--head', input.branch],
      input.cwd,
    );
    const opened =
      created.code === 0
        ? { number: numberFrom(created.stdout), state: 'open' as const }
        : /already exists/i.test(`${created.stderr}\n${created.stdout}`)
          ? await this.#existing(gh, run, input.cwd, input.branch)
          : null;
    if (!opened?.number) {
      const detail = (created.stderr || created.stdout).trim();
      if (/auth login|not logged|gh auth|HTTP 401|authentication/i.test(detail)) {
        throw new Error('O gh não tem sessão.');
      }
      throw new Error(detail || 'O gh não abriu o PR.');
    }
    const pr = PullRequest.parse({
      id: `gh-pr-${opened.number}`,
      sessionId: input.sessionId,
      key: String(opened.number),
      title: input.title,
      state: opened.state,
    });
    this.remember({ id: pr.id, sessionId: input.sessionId, cwd: input.cwd, number: opened.number });
    return pr;
  }

  async checks(prId: string): Promise<CiResult> {
    const known = this.#opened.get(prId);
    if (!known) throw new Error('Este PR não está nesta sessão.');
    const gh = this.#gh();
    if (!gh) throw new Error('Não encontrei o gh.');
    const run = this.options.run ?? runGh;
    const result = await run(
      gh,
      ['pr', 'checks', String(known.number), '--json', 'name,state,bucket,description'],
      known.cwd,
    );
    const text = `${result.stderr}\n${result.stdout}`;
    if (/auth login|not logged|gh auth|HTTP 401|authentication/i.test(text)) {
      throw new Error('O gh não tem sessão.');
    }
    const raw = result.stdout.trim();
    if (!raw.startsWith('[')) {
      if (/no checks/i.test(text)) return { prId, checks: [] };
      throw new Error(result.stderr.trim() || 'O gh não leu os checks.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('O gh devolveu checks inválidos.');
    }
    if (!Array.isArray(parsed)) throw new Error('O gh devolveu checks inválidos.');
    return { prId, checks: mapChecks(parsed) };
  }

  #gh(): string | null {
    const gh = this.options.gh === undefined ? resolveGh() : this.options.gh;
    return gh && path.isAbsolute(gh) ? gh : null;
  }

  async #existing(
    gh: string,
    run: GhRun,
    cwd: string,
    branch: string,
  ): Promise<{ number: number; state: PullState } | null> {
    const viewed = await run(
      gh,
      ['pr', 'view', '--json', 'number,title,state', '--head', branch],
      cwd,
    );
    if (viewed.code !== 0) return null;
    try {
      const parsed = JSON.parse(viewed.stdout) as { number?: unknown; state?: unknown };
      if (typeof parsed.number !== 'number' || !Number.isInteger(parsed.number) || parsed.number < 1) {
        return null;
      }
      const state = typeof parsed.state === 'string' ? pullState(parsed.state) : 'open';
      return { number: parsed.number, state };
    } catch {
      return null;
    }
  }
}

function numberFrom(stdout: string): number | null {
  const match = stdout.match(/\/pull\/(\d+)\b/);
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function mapChecks(items: readonly unknown[]): CiCheck[] {
  const used = new Set<string>();
  const checks: CiCheck[] = [];
  for (const item of items) {
    const check = mapCheck(item, used);
    if (check) checks.push(check);
    if (checks.length >= 100) break;
  }
  return checks;
}

function mapCheck(item: unknown, used: Set<string>): CiCheck | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as { name?: unknown; state?: unknown; bucket?: unknown; description?: unknown };
  if (typeof row.name !== 'string' || !row.name.trim()) return null;
  const name = row.name.trim().slice(0, 200);
  const summary = typeof row.description === 'string' ? row.description.trim().slice(0, 8_000) : '';
  const id = checkId(name, used);
  const state = checkState(row.bucket, row.state);
  const parsed = {
    id,
    name,
    state,
    summary,
  };
  return parsed.id ? parsed : null;
}

function checkState(bucket: unknown, state: unknown): CiCheck['state'] {
  const kind = `${typeof bucket === 'string' ? bucket : ''} ${typeof state === 'string' ? state : ''}`
    .toLowerCase();
  if (/\bfail|\berror|\btimed_out|\bcancel|\baction_required/.test(kind)) return 'failed';
  if (/\bskip/.test(kind)) return 'skipped';
  if (/\bpass|\bsuccess|\bneutral/.test(kind)) return 'passed';
  return 'pending';
}

function checkId(name: string, used: Set<string>): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const base = `ci-${slug || 'check'}`;
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base.slice(0, 58)}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

export function pullState(value: string): PullState {
  const state = value.toLowerCase();
  if (state === 'open' || state === 'merged' || state === 'closed') return state;
  throw new Error('Estado de PR desconhecido.');
}
