import type {
  EngineEvent,
  EngineSnapshot,
  KernelHealthSnapshot,
  ModuleHealth,
  RecoveryOperation,
} from '@solline/protocol';
import type { LoginManager } from '../agents/login.ts';
import type { AgentRegistry } from '../agents/registry.ts';
import type { AgentSettings } from '../agents/settings.ts';
import type { Brain } from '../brain/brain.ts';
import type { CheckpointStore } from '../checkpoints/store.ts';
import type { ConsultManager } from '../consult/manager.ts';
import type { EngineOptions } from '../engine.ts';
import type { Drafter } from '../handoff/drafter.ts';
import { createToken } from '../kernel/kernel.ts';
import type { McpCatalog } from '../mcp/catalog.ts';
import type { UserMcpCatalog } from '../mcp/user-catalog.ts';
import type { MemoryService } from '../memory/manager.ts';
import type { IssueService } from '../pull/issues.ts';
import type { PullService } from '../pull/pull.ts';
import type { Reviewer } from '../quality/reviewer.ts';
import type { ReviewerPicker } from '../quality/routing.ts';
import type { Planner } from '../races/planner.ts';
import type { RaceManager } from '../races/race-manager.ts';
import type { RaceRegistry } from '../races/race-registry.ts';
import type { SplitManager } from '../races/split-manager.ts';
import type { DurableJournal } from '../recovery/journal.ts';
import type { RecoveryRecord } from '../recovery/records.ts';
import type { RulesManager } from '../rules/manager.ts';
import type { SessionManager } from '../session-manager.ts';
import type { SpaceAnalysis } from '../spaces/analysis.ts';
import type { SpaceManager } from '../spaces/manager.ts';
import type { WorktreeManager } from '../worktrees/worktrees.ts';

export interface EngineRuntime {
  options: EngineOptions;
  env: NodeJS.ProcessEnv;
  settings: AgentSettings;
  builtinMcp: McpCatalog;
  checkpoints: CheckpointStore | undefined;
  worktrees: WorktreeManager | undefined;
  planner: Planner | undefined;
  drafter: Drafter | undefined;
  reviewing: {
    manager: { reviewer?: Reviewer; reviewerFor?: ReviewerPicker };
    integration: Reviewer | undefined;
  };
  journal: DurableJournal<RecoveryRecord> | undefined;
  operations: Map<string, RecoveryOperation>;
  recordedSessions: Set<string>;
  drafts: Map<string, AbortController>;
  emit: (event: EngineEvent) => void;
  emitAll: (event: EngineEvent) => void;
  beforeEffect: (command: string, sessionIdOrRace: { sessionId?: string; raceId?: string; text?: string }) => () => void;
  snapshot: () => EngineSnapshot;
  flush: () => Promise<void>;
  shutdown: () => Promise<void>;
  health: () => KernelHealthSnapshot;
  toggleModule: (id: string, enabled: boolean) => Promise<ModuleHealth>;
}

export const ENGINE_RUNTIME = createToken<EngineRuntime>('engine.runtime');
export const AGENT_REGISTRY = createToken<AgentRegistry>('agents.registry');
export const LOGIN_MANAGER = createToken<LoginManager>('agents.logins');
export const USER_MCP = createToken<UserMcpCatalog>('mcp.user');
export const COMBINED_MCP = createToken<McpCatalog>('mcp.combined');
export const RULES_MANAGER = createToken<RulesManager>('rules.manager');
export const MEMORY_SERVICE = createToken<MemoryService>('memory.service');
export const CONSULT_MANAGER = createToken<ConsultManager>('consult.manager');
export const BRAIN_SERVICE = createToken<Brain | undefined>('brain.service');
export const SESSION_MANAGER = createToken<SessionManager>('sessions.manager');
export const RACE_REGISTRY = createToken<RaceRegistry>('races.registry');
export const RACE_MANAGER = createToken<RaceManager>('races.manager');
export const SPLIT_MANAGER = createToken<SplitManager>('splits.manager');
export const SPACES_MANAGER = createToken<SpaceManager>('spaces.manager');
export const ANALYSIS_MANAGER = createToken<SpaceAnalysis>('spaces.analysis');
export const ISSUE_SERVICE = createToken<IssueService>('pull.issues');
export const PULL_SERVICE = createToken<PullService>('pull.service');
