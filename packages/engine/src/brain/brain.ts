import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AgentId } from '@solline/protocol';
import { findNode } from '../mcp/catalog.ts';
import type { McpServerLaunch } from '../adapters/types.ts';
import {
  BRAIN_PIPE_ENV,
  BRAIN_TOKEN_ENV,
  BrainChannel,
  type ChannelSession,
  type ChannelTool,
} from './channel.ts';
import {
  BRAIN_SERVER_NAME,
  type BrainContext,
  type BrainResult,
  type BrainShape,
  type BrainTool,
  type TurnInfo,
} from './tool.ts';
import { contextTool } from './tools/context.ts';

/** Quanto o agente espera por uma ferramenta da Solline (uma consulta a outro agente demora). */
export const BRAIN_TOOL_TIMEOUT_SEC = 900;

/** Como o agente chega às ferramentas: dentro do processo (Claude) ou pelo shim stdio (o resto). */
export type BrainTransport = 'in-process' | 'stdio';

/** A sessão que pede ferramentas. A identidade é dela: os argumentos do agente nunca a mudam. */
export interface BrainSession {
  id: string;
  projectId: string;
  agent: AgentId;
  describe(): { title: string; folder: string; cwd?: string | undefined };
  /** O turno em curso (só o gestor de sessões o sabe). Sem isto, os turnos contam como externos. */
  turn?(): TurnInfo;
  /** Ferramentas que esta sessão não recebe (as de consultar e delegar nas sessões que nasceram de uma). */
  withhold?: readonly string[];
}

export interface BrainToolInfo {
  name: string;
  description: string;
  input: BrainShape;
  readOnly: boolean;
  /**
   * O agente não pede autorização a esta ferramenta: é só de leitura, é inofensiva ou (gated) pede
   * ela própria ao utilizador, num cartão da Solline.
   */
  autoApprove: boolean;
  /** A ferramenta pede ao utilizador num cartão da Solline antes de fazer seja o que for. */
  gated: boolean;
}

/** As ferramentas da Solline atadas a uma sessão, até fecharem ou arrancarem de novo. */
export interface BrainBinding {
  readonly transport: BrainTransport;
  readonly serverName: string;
  readonly tools: readonly BrainToolInfo[];
  /** Só nos agentes por stdio: o shim pronto a arrancar. null: sem Node ou sem shim, sem cérebro. */
  readonly launch: McpServerLaunch | null;
  /** O agente consegue mesmo chamar as ferramentas. */
  readonly available: boolean;
  readonly revoked: boolean;
  call(name: string, args: unknown): Promise<BrainResult>;
  /** Fecha o acesso: o token deixa de valer e as ligações abertas caem. */
  revoke(): void;
}

export interface BrainOptions {
  tools?: readonly BrainTool[];
  /** Caminho absoluto do shim (ficheiro único, sem dependências). Sem ele, só o Claude tem cérebro. */
  shim?: string | undefined;
  /** O Node do sistema que corre o shim (como os servidores do catálogo). */
  node?: () => string | null;
  /** Para testes: o canal local. */
  channel?: BrainChannel;
  warn?: (message: string) => void;
}

/** O shim ao lado do código (desenvolvimento e testes); a app instalada passa o caminho de lá. */
export function sourceShimPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'shim', 'solline-brain-shim.cjs');
}

/** O agente não pede autorização a esta ferramenta (ela é segura por si ou pede ao utilizador). */
function skipsAgentPrompt(tool: BrainTool): boolean {
  return tool.autoApprove || tool.gated;
}

function describeTool(tool: BrainTool): ChannelTool {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(z.object(tool.input).strict());
  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    readOnly: tool.readOnly,
  };
}

/**
 * O servidor MCP da Solline para os agentes ("o cérebro"): um registo de ferramentas e o ponto
 * onde cada chamada ganha a identidade da sessão que a fez. Os dois caminhos (SDK do Claude em
 * processo; shim por stdio e canal local para o resto) acabam na mesma função, call().
 */
export class Brain {
  readonly #tools: readonly BrainTool[];
  readonly #shim: string | undefined;
  readonly #node: () => string | null;
  readonly #channel: BrainChannel;
  readonly #warn: (message: string) => void;
  readonly #warned = new Set<string>();

  constructor(options: BrainOptions = {}) {
    this.#tools = options.tools ?? [contextTool];
    const names = new Set<string>();
    for (const tool of this.#tools) {
      if (names.has(tool.name)) throw new Error(`Ferramenta repetida: ${tool.name}`);
      names.add(tool.name);
    }
    this.#shim = options.shim;
    this.#node = options.node ?? (() => findNode());
    this.#channel = options.channel ?? new BrainChannel();
    this.#warn = options.warn ?? ((message) => console.warn(`[brain] ${message}`));
  }

  /** Os nomes das ferramentas só de leitura (o resto pede sempre autorização). */
  get readOnlyTools(): readonly string[] {
    return this.#tools.filter((t) => t.readOnly).map((t) => t.name);
  }

  /**
   * Os nomes das ferramentas a que o agente não pede autorização: as só de leitura, as inofensivas
   * e as que pedem elas próprias ao utilizador (gated, senão eram dois pedidos para a mesma coisa).
   */
  get autoApprovedTools(): readonly string[] {
    return this.#tools.filter(skipsAgentPrompt).map((t) => t.name);
  }

  async bind(session: BrainSession, transport: BrainTransport): Promise<BrainBinding> {
    const context: BrainContext = {
      sessionId: session.id,
      projectId: session.projectId,
      agent: session.agent,
      session: () => session.describe(),
      turn: () => session.turn?.() ?? { id: undefined, external: true },
    };
    let revoked = false;
    const withheld = new Set(session.withhold ?? []);
    const tools = this.#tools.filter((t) => !withheld.has(t.name));
    const available = new Map(tools.map((t) => [t.name, t]));
    const call = async (name: string, args: unknown): Promise<BrainResult> => {
      if (revoked) return { text: 'Esta sessão da Solline já fechou.', isError: true };
      const tool = available.get(name);
      if (!tool) return { text: `Ferramenta desconhecida: ${name}`, isError: true };
      return tool.run(context, args);
    };
    const infos: BrainToolInfo[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input: t.input,
      readOnly: t.readOnly,
      autoApprove: skipsAgentPrompt(t),
      gated: t.gated,
    }));
    let issued: { token: string; revoke: () => void } | undefined;
    let launch: McpServerLaunch | null = null;
    if (transport === 'stdio') {
      const resolved = await this.#stdioLaunch();
      if (resolved) {
        const channelSession: ChannelSession = {
          tools: () => tools.map(describeTool),
          call,
        };
        issued = this.#channel.issue(channelSession);
        launch = {
          name: BRAIN_SERVER_NAME,
          command: resolved.node,
          args: [resolved.shim],
          env: { [BRAIN_PIPE_ENV]: resolved.address, [BRAIN_TOKEN_ENV]: issued.token },
          executesCode: false,
          autoApprove: tools.filter(skipsAgentPrompt).map((t) => t.name),
          // Perguntar a outro agente pode demorar minutos; o Codex corta as ferramentas MCP aos 60 s.
          toolTimeoutSec: BRAIN_TOOL_TIMEOUT_SEC,
        };
      }
    }
    return {
      transport,
      serverName: BRAIN_SERVER_NAME,
      tools: infos,
      launch,
      available: transport === 'in-process' || launch !== null,
      get revoked() {
        return revoked;
      },
      call,
      revoke: () => {
        revoked = true;
        issued?.revoke();
      },
    };
  }

  /** Sem Node de sistema, sem shim ou sem canal, o cérebro não existe para estes agentes (avisa uma vez). */
  async #stdioLaunch(): Promise<{ node: string; shim: string; address: string } | null> {
    const node = this.#node();
    if (!node) return this.#unavailable('falta o Node.js no PATH para correr o shim');
    const shim = this.#shim;
    if (!shim || !existsSync(shim)) {
      return this.#unavailable('o shim da Solline não está onde a app o espera');
    }
    try {
      return { node, shim, address: await this.#channel.listen() };
    } catch (error) {
      return this.#unavailable(`o canal local não abriu (${String(error)})`);
    }
  }

  #unavailable(reason: string): null {
    if (!this.#warned.has(reason)) {
      this.#warned.add(reason);
      this.#warn(`sem ferramentas da Solline para o Codex e os agentes ACP: ${reason}`);
    }
    return null;
  }

  async dispose(): Promise<void> {
    await this.#channel.close();
  }
}
