import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineEvent } from '@solline/protocol';
import { SessionManager, claudeDefinition, fixedMcpCatalog, registryOf } from '../src/index.ts';
import { reduce, waitFor } from './helpers.ts';
import { realAgents } from './real-agents.ts';

/**
 * Um servidor MCP ligado só a uma sessão real do Claude (Haiku, effort low): a ferramenta
 * chega ao agente, passa por um cartão sem "Permitir sempre" e o resultado volta.
 */
const skip = !realAgents().has('claude');
const T = 180_000;

describe.skipIf(skip)('servidor MCP por sessão no Claude (real)', () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'solline-mcp-'));
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  });

  it('o Claude usa a ferramenta do servidor atrás de um cartão', { timeout: T }, async () => {
    const events: EngineEvent[] = [];
    const manager = new SessionManager({
      emit: (e) => events.push(e),
      registry: registryOf([claudeDefinition({ isolated: true })]),
      mcp: fixedMcpCatalog([
        {
          id: 'echo',
          name: 'echo',
          command: process.execPath,
          args: [path.join(import.meta.dirname, 'fakes', 'echo-mcp.ts')],
          env: {},
          executesCode: true,
        },
      ]),
    });
    try {
      const { session } = await manager.create({
        projectId: 'p',
        agent: 'claude',
        cwd,
        trusted: true,
        model: 'haiku',
        effort: 'low',
        mcpServerIds: ['echo'],
      });
      await manager.send(
        session.id,
        'Call the echo tool from the echo MCP server with text "heron", then reply with exactly what it returned.',
      );
      await waitFor(() => events.some((e) => e.type === 'permission.request'), T);
      const ask = events.find((e) => e.type === 'permission.request');
      if (ask?.type !== 'permission.request') throw new Error('sem pedido');
      expect(ask.request).toMatchObject({
        kind: 'permission',
        toolName: 'mcp__echo__echo',
        canAlwaysAllow: false,
      });
      manager.answer(session.id, ask.request.id, { decision: 'allow-once' });
      await waitFor(
        () => events.some((e) => e.type === 'session.event' && e.delta.type === 'turn.end'),
        T,
      );
      const deltas = events.flatMap((e) => (e.type === 'session.event' ? [e.delta] : []));
      const tool = reduce(deltas)
        .flatMap((t) => t.blocks)
        .find((b) => b.kind === 'tool' && b.name === 'mcp__echo__echo');
      expect(tool).toMatchObject({ state: 'ok', output: expect.stringContaining('echo: heron') });
    } finally {
      await manager.disposeAll();
    }
  });
});
