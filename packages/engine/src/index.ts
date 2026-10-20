export { Engine, type EngineOptions } from './engine.ts';
export { SessionManager } from './session-manager.ts';
export { PermissionBroker, type BrokerOutcome } from './permission-broker.ts';
export { ClaudeNormalizer } from './adapters/claude/normalizer.ts';
export {
  ClaudeSdkAdapter,
  CLAUDE_MODES,
  type ClaudeProfile,
  CRASH_MESSAGE,
  askBlockFor,
  capabilitiesFrom,
  toEffortLevel,
  toPermissionMode,
  toPermissionModeOr,
  toPermissionResult,
  type ClaudeSdkOptions,
} from './adapters/claude/sdk.ts';
export { toolSummary, toolResultText, baseName } from './adapters/claude/tools.ts';
export type {
  AgentAdapter,
  AgentAdapterFactory,
  AdapterSink,
  AgentStartOptions,
  AgentStartResult,
} from './adapters/types.ts';
export { AsyncQueue } from './async-queue.ts';
export { sanitizedEnv, agentEnv, CLAUDE_ENV_POLICY, SECRET_NAME, type EnvPolicy } from './env.ts';
export {
  builtinRegistry,
  claudeDefinition,
  registryOf,
  withFactories,
  type AgentDefinition,
  type AgentRegistry,
} from './agents/registry.ts';
export { DEEPSEEK, profileDefinition, type ProviderProfile } from './agents/profiles.ts';
export { readWindowsCredential, type CredentialReader } from './secrets/windows-credentials.ts';
export {
  resolveClaudeExecutable,
  toUnpackedPath,
  platformPackageName,
  binaryName,
} from './adapters/claude/executable.ts';
export { ENGINE_VERSION } from './version.ts';
