import {
  claudePlanner,
  claudeReviewer,
  resolveClaudeExecutable,
  type EngineOptions,
} from '@solline/engine';

/** Production factory. The separate QA build replaces this module at compile time only. */
export function engineOptions(): EngineOptions {
  const claudeExecutable = resolveClaudeExecutable({
    packaged: process.env.SOLLINE_PACKAGED === '1',
  });
  return {
    claudeExecutable,
    dataDir: process.env.SOLLINE_DATA_DIR,
    packaged: process.env.SOLLINE_PACKAGED === '1',
    isolated: process.env.SOLLINE_ISOLATED === '1',
    ...(process.env.SOLLINE_REVIEWER === '1'
      ? { reviewer: claudeReviewer({ claudeExecutable }) }
      : {}),
    ...(process.env.SOLLINE_PLANNER === '1'
      ? { planner: claudePlanner({ claudeExecutable }) }
      : {}),
    ...(process.env.SOLLINE_CHECKS === '1' ? { checks: {} } : {}),
  };
}
