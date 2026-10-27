import path from 'node:path';
import {
  claudeDrafter,
  claudePlanner,
  claudeReviewer,
  resolveClaudeExecutable,
  toUnpackedPath,
  type EngineOptions,
} from '@solline/engine';

/** Production factory. The separate QA build replaces this module at compile time only. */
export function engineOptions(): EngineOptions {
  const packaged = process.env.SOLLINE_PACKAGED === '1';
  const claudeExecutable = resolveClaudeExecutable({ packaged });
  // O shim da Solline fica ao lado deste bundle (out/main); na app instalada, fora do asar.
  const shim = path.join(__dirname, 'brain-shim.cjs');
  return {
    claudeExecutable,
    brain: { shim: packaged ? toUnpackedPath(shim) : shim },
    dataDir: process.env.SOLLINE_DATA_DIR,
    packaged,
    isolated: process.env.SOLLINE_ISOLATED === '1',
    ...(process.env.SOLLINE_REVIEWER === '1'
      ? { reviewer: claudeReviewer({ claudeExecutable }) }
      : {}),
    ...(process.env.SOLLINE_PLANNER === '1'
      ? { planner: claudePlanner({ claudeExecutable }) }
      : {}),
    ...(process.env.SOLLINE_DRAFTER === '1'
      ? { drafter: claudeDrafter({ claudeExecutable }) }
      : {}),
    ...(process.env.SOLLINE_CHECKS === '1' ? { checks: {} } : {}),
  };
}
