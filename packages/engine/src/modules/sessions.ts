import { detectChecks } from '../checks/detect.ts';
import { draftHandoff } from '../handoff/drafter.ts';
import type { KernelModule } from '../kernel/kernel.ts';
import { summaryOf } from '../review.ts';
import { SessionManager } from '../session-manager.ts';
import { detectSetup } from '../workspace/setup.ts';
import {
  AGENT_REGISTRY,
  BRAIN_SERVICE,
  COMBINED_MCP,
  CONSULT_MANAGER,
  ENGINE_RUNTIME,
  MEMORY_SERVICE,
  RULES_MANAGER,
  SESSION_MANAGER,
} from './tokens.ts';

export function sessionsModule(): KernelModule {
  return {
    manifest: {
      id: 'sessions',
      version: '1.0.0',
      dependsOn: ['agents', 'mcp', 'brain', 'rules', 'memory'],
      commands: [
        'session.start',
        'session.resume',
        'session.send',
        'session.reorder',
        'session.resumeQueue',
        'session.bring',
        'session.interrupt',
        'session.setMode',
        'session.setModel',
        'session.setEffort',
        'session.rewind',
        'session.fork',
        'session.taskState',
        'permission.answer',
        'review.timeline',
        'review.diff',
        'review.apply',
        'review.undo',
        'review.comment',
        'quality.get',
        'quality.setEnabled',
        'quality.review',
        'quality.fix',
        'quality.dismiss',
        'checks.get',
        'checks.run',
        'checks.fix',
        'ledger.get',
        'ledger.budget',
        'repair.set',
        'repair.cancel',
        'handoff.draft',
        'handoff.cancelDraft',
        'handoff.start',
        'handoff.resume',
        'worktrees.list',
        'worktrees.bring',
        'worktrees.discardNow',
        'projects.trustChanged',
        'projects.detectChecks',
        'projects.detectSetup',
        'projects.setupChanged',
        'projects.checksChanged',
        'setup.retry',
        'commit.save',
      ],
      events: [
        'session.event',
        'session.state',
        'session.queue',
        'session.timeline',
        'session.quality',
        'session.checks',
        'session.ledger',
        'session.repair',
        'session.setup',
        'session.workspace',
        'session.handoff',
        'session.archived',
        'permission.request',
      ],
      critical: true,
      toggleable: false,
    },
    init(ctx) {
      const rt = ctx.inject(ENGINE_RUNTIME);
      const registry = ctx.inject(AGENT_REGISTRY);
      const mcp = ctx.inject(COMBINED_MCP);
      const brain = ctx.inject(BRAIN_SERVICE);
      const consult = ctx.tryInject(CONSULT_MANAGER);
      const rules = ctx.inject(RULES_MANAGER);
      const memories = ctx.inject(MEMORY_SERVICE);
      const s = new SessionManager({
        beforeEffect: (command, sessionId, text) =>
          rt.beforeEffect(command, { sessionId, ...(text ? { text } : {}) }),
        emit: rt.emitAll,
        registry,
        mcp,
        brain,
        consult,
        rules,
        memories,
        checkpoints: rt.checkpoints,
        keysFor: (agent) => rt.settings.keys(agent),
        ...rt.reviewing.manager,
        worktrees: rt.worktrees,
        circuits: ctx.circuits,
        checks:
          rt.options.checks === false
            ? undefined
            : (rt.options.checks ?? (rt.options.isolated ? undefined : {})),
      });
      consult?.attach(s);
      ctx.provide(SESSION_MANAGER, s);

      const ok = {} as Record<string, never>;
      const definitionOf = (id: string) => {
        const found = registry.get(id);
        if (!found) throw new Error(`Agente desconhecido: ${id}`);
        return found;
      };

      ctx.registerCommand('session.start', (p) => s.create(p));
      ctx.registerCommand('session.resume', (p) => s.resume(p.sessionId));
      ctx.registerCommand('session.send', (p) => s.send(p.sessionId, p.text, p.how));
      ctx.registerCommand('session.reorder', async (p) => (s.reorder(p.sessionId, p.ids), ok));
      ctx.registerCommand('session.resumeQueue', async (p) => (s.resumeQueue(p.sessionId), ok));
      ctx.registerCommand('session.bring', (p) => s.bring(p.sessionId));
      ctx.registerCommand('session.interrupt', async (p) => (await s.interrupt(p.sessionId), ok));
      ctx.registerCommand('session.setMode', async (p) => (await s.setMode(p.sessionId, p.mode), ok));
      ctx.registerCommand('session.setModel', async (p) => (await s.setModel(p.sessionId, p.model), ok));
      ctx.registerCommand('session.setEffort', async (p) => (await s.setEffort(p.sessionId, p.effort), ok));
      ctx.registerCommand('session.rewind', (p) =>
        s.rewind(p.sessionId, p.turnId, { files: p.files, conversation: p.conversation }),
      );
      ctx.registerCommand('session.fork', (p) => s.fork(p.sessionId, p.turnId));
      ctx.registerCommand('session.taskState', async (p) => s.taskState(p.sessionId));
      ctx.registerCommand('permission.answer', async (p) => (s.answer(p.sessionId, p.requestId, p.answer), ok));
      ctx.registerCommand('review.timeline', (p) => s.timeline(p.sessionId));
      ctx.registerCommand('review.diff', async (p) => ({ files: await s.diff(p.sessionId, p.scope) }));
      ctx.registerCommand('review.apply', (p) => s.review(p.sessionId, p.action, p.path, p.hunkId));
      ctx.registerCommand('review.undo', (p) => s.undo(p.sessionId));
      ctx.registerCommand('review.comment', async (p) => ({
        turnId: await s.comment(p.sessionId, p.comments, p.note),
      }));
      ctx.registerCommand('quality.get', async (p) => s.quality(p.sessionId));
      ctx.registerCommand('quality.setEnabled', async (p) => s.setQualityEnabled(p.sessionId, p.enabled));
      ctx.registerCommand('quality.review', (p) => s.reviewNow(p.sessionId, p));
      ctx.registerCommand('quality.fix', async (p) => ({ turnId: await s.fix(p.sessionId, p.ids) }));
      ctx.registerCommand('quality.dismiss', async (p) => s.dismiss(p.sessionId, p.ids));
      ctx.registerCommand('checks.get', async (p) => s.checks(p.sessionId));
      ctx.registerCommand('checks.run', (p) => s.runChecks(p.sessionId));
      ctx.registerCommand('checks.fix', async (p) => ({ turnId: await s.fixCheck(p.sessionId, p.id) }));
      ctx.registerCommand('ledger.get', async (p) => s.ledger(p.sessionId));
      ctx.registerCommand('ledger.budget', async (p) =>
        s.setBudget(p.sessionId, { maxTurns: p.maxTurns, maxMinutes: p.maxMinutes }),
      );
      ctx.registerCommand('repair.set', async (p) => s.setRepair(p.sessionId, p.enabled));
      ctx.registerCommand('repair.cancel', async (p) => s.cancelRepair(p.sessionId));
      ctx.registerCommand('worktrees.list', async () => ({ orphans: await s.orphans() }));
      ctx.registerCommand('worktrees.bring', (p) => s.bringOrphan(p.id));
      ctx.registerCommand('worktrees.discardNow', async (p) => (await s.discardOrphan(p.id), ok));
      ctx.registerCommand('projects.trustChanged', async (p) => (s.setProjectTrust(p.projectId, p.trusted), ok));
      ctx.registerCommand('projects.detectChecks', async (p) => ({ checks: await detectChecks(p.cwd) }));
      ctx.registerCommand('projects.detectSetup', async (p) => ({ setup: await detectSetup(p.cwd) }));
      ctx.registerCommand('projects.setupChanged', async (p) => (s.setProjectSetup(p.projectId, p.setup), ok));
      ctx.registerCommand('setup.retry', async (p) => (await s.retrySetup(p.sessionId), ok));
      ctx.registerCommand('projects.checksChanged', async (p) => (await s.setProjectChecks(p.projectId, p.checks), ok));
      ctx.registerCommand('commit.save', (p) => s.saveCommit(p.sessionId, p.message));

      ctx.registerCommand('handoff.draft', async (p) => {
        const target = definitionOf(p.agent);
        const source = await s.handoffSource(p.sessionId);
        rt.drafts.get(p.sessionId)?.abort();
        const abort = new AbortController();
        rt.drafts.set(p.sessionId, abort);
        try {
          const drafted = await draftHandoff(rt.drafter, {
            cwd: source.cwd,
            goal: p.goal,
            source: { label: source.label, title: source.title },
            target: { label: target.label, model: p.model },
            transcript: summaryOf(
              source.turns,
              'A conversa da sessão anterior, por ordem (as mensagens mais antigas podem ter ficado de fora):',
            ),
            lastRequest: source.lastRequest,
            files: source.files,
            signal: abort.signal,
          });
          const warning = [drafted.warning, source.filesNote].filter(Boolean).join(' ');
          return {
            text: drafted.text,
            drafted: drafted.drafted,
            ...(warning ? { warning } : {}),
            cost: drafted.cost,
          };
        } finally {
          if (rt.drafts.get(p.sessionId) === abort) rt.drafts.delete(p.sessionId);
        }
      });
      ctx.registerCommand('handoff.cancelDraft', async (p) => {
        const draft = rt.drafts.get(p.sessionId);
        draft?.abort();
        return { cancelled: draft !== undefined };
      });
      ctx.registerCommand('handoff.start', (p) =>
        s.handoff(p.sessionId, {
          agent: p.agent,
          model: p.model,
          effort: p.effort,
          text: p.text,
          goal: p.goal,
          draftedBy: p.draftedBy,
        }),
      );
      ctx.registerCommand('handoff.resume', (p) => s.resumeHere(p.sessionId));
    },
    async dispose(ctx) {
      await ctx.tryInject(SESSION_MANAGER)?.disposeAll(true);
    },
  };
}
