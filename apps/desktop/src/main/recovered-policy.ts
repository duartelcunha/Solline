import { commandSchemas, type CommandName, type EngineSnapshot } from '@solline/protocol';
import type { EngineHost } from './engine-host.ts';
import type { ProjectLookup } from './session-policy.ts';

// Inspection must remain possible even when the project was removed or its policy changed.
const INSPECTION = new Set<CommandName>([
  'engine.snapshot',
  'engine.ping',
  'engine.health',
  'session.taskState',
  'agents.list',
  'agents.keyCandidates',
  'mcp.list',
  // O catálogo e a pesquisa no registo só leem.
  'mcp.catalog',
  'mcp.search',
  'projects.list',
  'worktrees.list',
  'race.get',
  'review.timeline',
  'review.diff',
  'quality.get',
  'checks.get',
  'ledger.get',
  // Só lê as regras guardadas (mesmo de um projeto que entretanto saiu).
  'rules.list',
  // Só desiste de um rascunho a escrever: não toca em nada.
  'handoff.cancelDraft',
  // Pura: confere um plano, não toca em nada.
  'split.review',
]);
const GLOBAL = new Set<CommandName>([
  'engine.flush',
  'engine.shutdown',
  'agents.login',
  'agents.loginCancel',
  'agents.setKeys',
  'projects.add',
  // O catálogo de servidores MCP é global: não pertence a um projeto.
  'mcp.probe',
]);

/** Refresh main-owned policy before effects; a recovered journal is never its authority. */
export async function reconcilePolicy(
  engine: Pick<EngineHost, 'request'>,
  projects: ProjectLookup,
  command: CommandName,
  payload: unknown,
): Promise<void> {
  const input = commandSchemas[command].payload.parse(payload ?? {});
  // These commands resolve their project/task scope in the engine after a main-owned sync.
  // As memórias, como os espaços, resolvem o âmbito no motor depois de o main sincronizar os projetos.
  if (command.startsWith('spaces.') || command.startsWith('memory.')) return;
  if (INSPECTION.has(command) || GLOBAL.has(command)) return;

  const projectIds = new Set<string>();
  let snapshot: EngineSnapshot | undefined;
  const state = async () => (snapshot ??= await engine.request('engine.snapshot'));
  if ('projectId' in input && typeof input.projectId === 'string') projectIds.add(input.projectId);
  if ('sessionId' in input && typeof input.sessionId === 'string') {
    const saved = (await state()).sessions.find((item) => item.session.id === input.sessionId);
    if (!saved) throw new Error('A sessão já não está disponível.');
    projectIds.add(saved.session.projectId);
  }
  if ('raceId' in input && typeof input.raceId === 'string') {
    const current = await state();
    const race = current.races.find((item) => item.id === input.raceId);
    if (!race) throw new Error('A corrida já não está disponível.');
    projectIds.add(race.projectId);
    for (const lane of race.lanes) {
      const saved = current.sessions.find((item) => item.session.id === lane.sessionId);
      if (!saved) throw new Error('Uma sessão da corrida já não está disponível.');
      projectIds.add(saved.session.projectId);
    }
  }
  if ((command === 'worktrees.bring' || command === 'worktrees.discard') && 'id' in input) {
    const { orphans } = await engine.request('worktrees.list');
    const orphan = orphans.find((item) => item.id === input.id);
    if (!orphan) throw new Error('A worktree já não está disponível.');
    projectIds.add(orphan.projectId);
  }
  // New effect commands must explicitly identify their scope or join the global allowlist.
  if (projectIds.size === 0) throw new Error('Não foi possível confirmar o projeto desta ação.');

  for (const projectId of projectIds) {
    const project = await projects.get(projectId);
    await engine.request('projects.trustChanged', {
      projectId,
      trusted: project?.trusted ?? false,
    });
    if (!project)
      throw new Error('O projeto desta ação já não está disponível. O histórico foi preservado.');

    const checks = project.checks ?? null;
    const views = (await state()).sessions.filter((item) => item.session.projectId === projectId);
    const differs = views.some(
      ({ checks: current }) =>
        current &&
        (current.detected !== (checks === null) ||
          (checks !== null && JSON.stringify(current.specs) !== JSON.stringify(checks))),
    );
    // configure() clears running results: only changed policy warrants that side effect.
    if (differs) await engine.request('projects.checksChanged', { projectId, checks });
    await engine.request('projects.setupChanged', { projectId, setup: project.setup ?? null });
  }
}
