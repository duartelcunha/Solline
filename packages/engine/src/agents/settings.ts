import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AgentId, EnvKeyName } from '@solline/protocol';

/**
 * O que escolhes para cada agente, em <dados da app>/agent-settings.json. Só nomes de
 * variáveis: os valores ficam no ambiente e só são lidos no arranque de cada sessão.
 */
const AgentSettingsFile = z.object({
  version: z.literal(1),
  agents: z.record(AgentId, z.object({ keys: z.array(EnvKeyName).max(32) }).strict()),
});
type AgentSettingsFile = z.infer<typeof AgentSettingsFile>;

const EMPTY: AgentSettingsFile = { version: 1, agents: {} };

export interface AgentSettings {
  keys(agent: AgentId): Promise<string[]>;
  setKeys(agent: AgentId, keys: readonly string[]): Promise<void>;
}

/** Guardado num ficheiro; um ficheiro estragado conta como vazio (nenhuma chave extra). */
export function fileAgentSettings(dataDir: string): AgentSettings {
  const file = path.join(dataDir, 'agent-settings.json');
  let writing = Promise.resolve();

  /** corrupt: o ficheiro existe mas não se lê (estragado ou de outra versão). */
  async function load(): Promise<{ data: AgentSettingsFile; corrupt: boolean }> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return { data: EMPTY, corrupt: false };
    }
    try {
      const parsed = AgentSettingsFile.safeParse(JSON.parse(text));
      return parsed.success
        ? { data: parsed.data, corrupt: false }
        : { data: EMPTY, corrupt: true };
    } catch {
      return { data: EMPTY, corrupt: true };
    }
  }
  const read = async () => (await load()).data;

  return {
    keys: async (agent) => [...((await read()).agents[agent]?.keys ?? [])],
    setKeys: (agent, keys) => {
      // Um de cada vez, e por um ficheiro temporário: nunca fica meio escrito.
      const next = writing.then(async () => {
        const { data: current, corrupt } = await load();
        // Antes de escrever por cima de um ficheiro que não se leu, fica uma cópia ao lado.
        if (corrupt) await copyFile(file, `${file}.${Date.now()}.bak`);
        const agents = Object.fromEntries(
          Object.entries(current.agents).filter(([id]) => id !== agent),
        );
        if (keys.length > 0) agents[agent] = { keys: [...keys] };
        const data = AgentSettingsFile.parse({ version: 1, agents });
        await mkdir(dataDir, { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        await rename(tmp, file);
      });
      writing = next.catch(() => undefined);
      return next;
    },
  };
}

/** Em memória (testes e motor sem pasta de dados). */
export function memoryAgentSettings(): AgentSettings {
  const keys = new Map<AgentId, string[]>();
  return {
    keys: async (agent) => [...(keys.get(agent) ?? [])],
    setKeys: async (agent, next) => {
      keys.set(agent, [...next]);
    },
  };
}
