import { describe, expect, it } from 'vitest';
import { commandSchemas, type Issue, type PullRequest } from '@solline/protocol';

const issue: Issue = {
  id: 'gh-42',
  projectId: 'atelier',
  provider: 'github',
  key: '42',
  title: 'O parser rejeita o caminho relativo',
  body: 'Abrir a sessão já com este texto.',
};

const pull: PullRequest = {
  id: 'gh-pr-7',
  sessionId: 'sessao-1',
  key: '7',
  title: 'Corrige o parser',
  state: 'open',
};

describe('contrato do pedido ao PR', () => {
  it('lista issues só com o id do projeto', () => {
    expect(commandSchemas['issues.list'].payload.parse({ projectId: 'atelier' })).toEqual({
      projectId: 'atelier',
    });
    expect(
      commandSchemas['issues.list'].result.parse({ issues: [issue], unavailable: null }),
    ).toMatchObject({ issues: [{ id: 'gh-42', key: '42' }] });
    expect(
      commandSchemas['issues.list'].result.parse({ issues: [], unavailable: 'missing' }).unavailable,
    ).toBe('missing');
  });

  it('abrir uma issue, gravar, abrir o PR e ler a CI mandam ids e texto, nada mais', () => {
    expect(
      commandSchemas['issues.open'].payload.parse({ projectId: 'atelier', issueId: 'gh-42' }),
    ).toEqual({ projectId: 'atelier', issueId: 'gh-42' });
    expect(commandSchemas['issues.open'].result.parse({ sessionId: 'sessao-1' }).sessionId).toBe(
      'sessao-1',
    );

    expect(
      commandSchemas['commit.save'].payload.parse({
        sessionId: 'sessao-1',
        message: 'fix: o parser',
      }).message,
    ).toBe('fix: o parser');
    expect(commandSchemas['commit.save'].result.parse({ sha: null }).sha).toBeNull();
    expect(commandSchemas['commit.save'].result.parse({ sha: 'abc1234' }).sha).toBe('abc1234');

    expect(
      commandSchemas['pr.open'].payload.parse({
        sessionId: 'sessao-1',
        title: 'Corrige o parser',
        body: '',
      }),
    ).toMatchObject({ sessionId: 'sessao-1' });
    expect(commandSchemas['pr.open'].result.parse(pull).state).toBe('open');

    const ci = commandSchemas['ci.read'].result.parse({
      prId: 'gh-pr-7',
      checks: [
        { id: 'ci-typecheck', name: 'typecheck', state: 'failed', summary: 'src/a.ts:1 erro' },
      ],
    });
    expect(commandSchemas['ci.read'].payload.parse({ prId: 'gh-pr-7' })).toEqual({
      prId: 'gh-pr-7',
    });
    expect(ci.checks[0]?.state).toBe('failed');
  });

  it('recusa URL, dono, repositório e comando', () => {
    const extra = { url: 'https://github.com/acme/app/issues/1', owner: 'acme', command: 'gh' };
    expect(() => commandSchemas['issues.list'].payload.parse({ projectId: 'atelier', ...extra })).toThrow();
    expect(() =>
      commandSchemas['issues.open'].payload.parse({
        projectId: 'atelier',
        issueId: 'gh-42',
        repo: 'acme/app',
      }),
    ).toThrow();
    expect(() =>
      commandSchemas['commit.save'].payload.parse({
        sessionId: 'sessao-1',
        message: 'fix',
        command: 'git commit',
      }),
    ).toThrow();
    expect(() =>
      commandSchemas['pr.open'].payload.parse({
        sessionId: 'sessao-1',
        title: 't',
        body: '',
        url: 'https://github.com/acme/app/pull/7',
      }),
    ).toThrow();
    expect(() => commandSchemas['ci.read'].payload.parse({ prId: 'gh-pr-7', repo: 'acme/app' })).toThrow();
    expect(() =>
      commandSchemas['issues.list'].result.parse({
        issues: [{ ...issue, id: 'https://github.com/acme/app/issues/1' }],
        unavailable: null,
      }),
    ).toThrow();
    expect(() => commandSchemas['pr.open'].result.parse({ ...pull, owner: 'acme' })).toThrow();
  });
});
