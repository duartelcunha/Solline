import type { KernelModule } from '../kernel/kernel.ts';
import { IssueService, openListedIssue } from '../pull/issues.ts';
import { PullService } from '../pull/pull.ts';
import {
  ENGINE_RUNTIME,
  ISSUE_SERVICE,
  PULL_SERVICE,
  SESSION_MANAGER,
  SPACES_MANAGER,
} from './tokens.ts';

export function pullModule(): KernelModule {
  return {
    manifest: {
      id: 'pull',
      version: '1.0.0',
      dependsOn: ['spaces', 'sessions'],
      commands: ['issues.list', 'issues.open', 'pr.preview', 'pr.create', 'ci.read'],
      events: [],
      critical: false,
      toggleable: true,
    },
    init(ctx) {
      const rt = ctx.inject(ENGINE_RUNTIME);
      const spaces = ctx.inject(SPACES_MANAGER);
      const sessions = ctx.inject(SESSION_MANAGER);
      const issues = ctx.tryInject(ISSUE_SERVICE) ?? rt.options.issues ?? new IssueService();
      const pulls = ctx.tryInject(PULL_SERVICE) ?? rt.options.pulls ?? new PullService();
      if (!ctx.tryInject(ISSUE_SERVICE)) ctx.provide(ISSUE_SERVICE, issues);
      if (!ctx.tryInject(PULL_SERVICE)) ctx.provide(PULL_SERVICE, pulls);

      ctx.registerCommand('issues.list', async (p) => {
        const project = spaces.project(p.projectId);
        if (!project) throw new Error('Projeto desconhecido');
        return issues.list(project.path, project.id);
      });
      ctx.registerCommand('issues.open', async (p) => {
        const project = spaces.project(p.projectId);
        if (!project) throw new Error('Projeto desconhecido');
        const list = await issues.list(project.path, project.id);
        return openListedIssue({
          project,
          issueId: p.issueId,
          list,
          start: (payload) => sessions.create(payload).then((created) => created.session.id),
          send: (sessionId, text) => sessions.send(sessionId, text).then(() => undefined),
        });
      });
      ctx.registerCommand('pr.preview', (p) => sessions.pullTarget(p.sessionId));
      ctx.registerCommand('pr.create', async (p) => {
        const pushed = await sessions.pushPull(p.sessionId);
        return pulls.open({
          cwd: pushed.cwd,
          branch: pushed.branch,
          sessionId: p.sessionId,
          title: p.title,
          body: p.body,
        });
      });
      ctx.registerCommand('ci.read', async (p) => {
        const state = await pulls.state(p.prId);
        if (state === 'merged') {
          const sessionId = pulls.sessionOf(p.prId);
          if (sessionId) sessions.archive(sessionId);
        }
        return pulls.checks(p.prId);
      });
    },
  };
}
