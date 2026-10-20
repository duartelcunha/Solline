import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineEvent } from '@solline/protocol';
import { SessionManager, codexDefinition, registryOf } from '../src/index.ts';
import { reduce, waitFor } from './helpers.ts';
import { realAgents } from './real-agents.ts';

/**
 * O Codex a sério, com o login que já tem nesta máquina. Só com SOLLINE_AGENTS a incluir codex:
 * gasta quota do plano do ChatGPT. Uma pergunta curta, effort baixo.
 */
const skip = !realAgents().has('codex');
const T = 240_000;

describe.skipIf(skip)('Codex pelo app-server (real)', () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'solline-codex-'));
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  });

  it('responde com streaming, tokens e contexto, sem custo', { timeout: T }, async () => {
    const events: EngineEvent[] = [];
    const manager = new SessionManager({
      emit: (e) => events.push(e),
      registry: registryOf([codexDefinition()]),
    });
    try {
      const { session, capabilities } = await manager.create({
        projectId: 'p',
        agent: 'codex',
        cwd,
        trusted: true,
        effort: 'low',
      });
      expect(capabilities.models.length).toBeGreaterThan(0);
      expect(capabilities.features.cost).toBe(false);
      await manager.send(session.id, 'Reply with exactly one word: ok');
      await waitFor(
        () => events.some((e) => e.type === 'session.event' && e.delta.type === 'turn.end'),
        T,
      );
      const deltas = events.flatMap((e) => (e.type === 'session.event' ? [e.delta] : []));
      const text = reduce(deltas)
        .flatMap((t) => t.blocks)
        .filter((b) => b.kind === 'text')
        .map((b) => (b.kind === 'text' ? b.text : ''))
        .join(' ');
      expect(text.toLowerCase()).toContain('ok');
      expect(deltas.some((d) => d.type === 'block.append')).toBe(true);
      expect(deltas.some((d) => d.type === 'usage' && d.usage.tokens)).toBe(true);
      expect(deltas.find((d) => d.type === 'turn.end')).toMatchObject({ outcome: 'done' });
    } finally {
      await manager.disposeAll();
    }
  });
});
