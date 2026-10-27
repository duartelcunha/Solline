import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/** O nome do shim ao lado do bundle do motor (out/main). O motor procura-o aí. */
export const BRAIN_SHIM_FILE = 'brain-shim.cjs';

/**
 * Copia o shim MCP da Solline (ficheiro único, sem dependências) para o lado do motor. Corre com
 * o Node do sistema e não de dentro do asar, por isso o electron-builder também o desempacota.
 */
export function brainShimPlugin(source: string): Plugin {
  return {
    name: 'solline-brain-shim',
    buildStart() {
      this.addWatchFile(source);
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: BRAIN_SHIM_FILE, source: readFileSync(source) });
    },
  };
}
