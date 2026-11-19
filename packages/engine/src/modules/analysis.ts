import type { KernelModule } from '../kernel/kernel.ts';
import { SpaceAnalysis } from '../spaces/analysis.ts';
import { claudeAnalysis } from '../spaces/claude-analysis.ts';
import {
  AGENT_REGISTRY,
  ANALYSIS_MANAGER,
  ENGINE_RUNTIME,
  SESSION_MANAGER,
  SPACES_MANAGER,
} from './tokens.ts';

export function analysisModule(): KernelModule {
  return {
    manifest: {
      id: 'analysis',
      version: '1.0.0',
      dependsOn: ['spaces', 'sessions', 'agents'],
      commands: ['spaces.analyze', 'spaces.tick'],
      events: [],
      critical: false,
      toggleable: true,
    },
    init(ctx) {
      const rt = ctx.inject(ENGINE_RUNTIME);
      const spaces = ctx.inject(SPACES_MANAGER);
      const sessions = ctx.inject(SESSION_MANAGER);
      const registry = ctx.inject(AGENT_REGISTRY);
      const existing = ctx.tryInject(ANALYSIS_MANAGER);
      const analysis =
        existing ??
        new SpaceAnalysis({
          manager: spaces,
          idle: () =>
            sessions
              .recovery()
              .every((s) => s.view.session.state === 'idle' && !s.view.queue.items.length),
          history: () => {
            const tasks = spaces.snapshot().tasks.map((t) => ({
              id: `task:${t.id}`,
              projectId: t.projectId,
              text: `${t.title}\n${t.description}\nEstado: ${t.status}`,
            }));
            const turns = sessions.recovery().flatMap((s) =>
              s.view.turns
                .filter((t) => t.role === 'user')
                .slice(-10)
                .map((t) => ({
                  id: `chat:${s.view.session.id}:${t.id}`,
                  projectId:
                    s.view.session.projectId === '__general__' ? null : s.view.session.projectId,
                  text: t.blocks
                    .filter((b) => b.kind === 'text')
                    .map((b) => (b.kind === 'text' ? b.text : ''))
                    .join('\n'),
                })),
            );
            return [...tasks.slice(0, 50), ...turns.slice(-50)];
          },
          run: async (input) => {
            const detected = await registry.get(input.agent)?.detect({ refresh: true });
            if (detected?.status !== 'ready')
              throw new Error(
                'O agente de análise precisa de atenção: verifica o login e a disponibilidade.',
              );
            if (rt.options.isolated && !rt.options.spaceAnalyzer)
              throw new Error('A análise real está desligada neste ambiente de teste.');
            return (
              rt.options.spaceAnalyzer ?? claudeAnalysis(rt.options.claudeExecutable)
            )(input);
          },
        });
      if (!existing) ctx.provide(ANALYSIS_MANAGER, analysis);

      ctx.registerCommand('spaces.analyze', () => analysis.analyze(false));
      ctx.registerCommand('spaces.tick', () => analysis.analyze(true));
    },
    async dispose(ctx) {
      await ctx.tryInject(ANALYSIS_MANAGER)?.stop();
    },
  };
}
