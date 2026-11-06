import { z } from 'zod';

/**
 * Do pedido ao PR. A interface manda ids e texto que escreveu.
 * Não há URL, dono do repositório, nem comando: um campo a mais é recusado.
 */

const ProjectId = z.string().min(1).max(128);
const SessionId = z.string().min(1).max(128);
/** Id nosso, curto. Um URL ou um caminho não cabe. */
const Ref = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/);
/** O que se lê na lista: `123` ou `ENG-14`, não um endereço. */
const Key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/);

export const IssueProvider = z.enum(['github', 'linear']);
export type IssueProvider = z.infer<typeof IssueProvider>;

export const Issue = z
  .object({
    id: Ref,
    projectId: ProjectId,
    provider: IssueProvider,
    key: Key,
    title: z.string().trim().min(1).max(300),
    body: z.string().max(20_000),
  })
  .strict();
export type Issue = z.infer<typeof Issue>;

export const IssueList = z
  .object({
    issues: z.array(Issue).max(100),
    /** null: não há issues. missing: sem gh. logged-out: o gh não tem sessão. */
    unavailable: z.enum(['missing', 'logged-out']).nullable(),
  })
  .strict();
export type IssueList = z.infer<typeof IssueList>;

export const PullState = z.enum(['open', 'merged', 'closed']);
export type PullState = z.infer<typeof PullState>;

export const PullRequest = z
  .object({
    id: Ref,
    sessionId: SessionId,
    key: Key,
    title: z.string().trim().min(1).max(300),
    state: PullState,
  })
  .strict();
export type PullRequest = z.infer<typeof PullRequest>;

export const CheckState = z.enum(['pending', 'passed', 'failed', 'skipped']);
export type CheckState = z.infer<typeof CheckState>;

export const CiCheck = z
  .object({
    id: Ref,
    name: z.string().trim().min(1).max(200),
    state: CheckState,
    summary: z.string().max(8_000),
  })
  .strict();
export type CiCheck = z.infer<typeof CiCheck>;

export const CiResult = z
  .object({
    prId: Ref,
    checks: z.array(CiCheck).max(100),
  })
  .strict();
export type CiResult = z.infer<typeof CiResult>;

const CommitResult = z
  .object({
    /** null: não havia nada para gravar. */
    sha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .nullable(),
  })
  .strict();

export const pullCommandSchemas = {
  /** Issues do projeto aberto. */
  'issues.list': {
    payload: z.object({ projectId: ProjectId }).strict(),
    result: IssueList,
  },
  /** Abre uma sessão a partir de uma issue. A pasta resolve-se no main, mais tarde. */
  'issues.open': {
    payload: z.object({ projectId: ProjectId, issueId: Ref }).strict(),
    result: z.object({ sessionId: SessionId }).strict(),
  },
  /** Grava a worktree com a mensagem escrita. Sem merge e sem push. */
  'commit.save': {
    payload: z
      .object({
        sessionId: SessionId,
        message: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    result: CommitResult,
  },
  /** Abre o PR da sessão. Título e corpo são texto teu. */
  'pr.open': {
    payload: z
      .object({
        sessionId: SessionId,
        title: z.string().trim().min(1).max(300),
        body: z.string().max(20_000),
      })
      .strict(),
    result: PullRequest,
  },
  /** Checks de um PR. Só lê. */
  'ci.read': {
    payload: z.object({ prId: Ref }).strict(),
    result: CiResult,
  },
} as const;
