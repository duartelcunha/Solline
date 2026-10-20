import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineEvent } from '@solline/protocol';
import { DEEPSEEK, SessionManager, profileDefinition, registryOf } from '../src/index.ts';
import { reduce, waitFor } from './helpers.ts';
import { realAgents } from './real-agents.ts';

/**
 * Modelos DeepSeek pelo Claude Code, a sério. Só com SOLLINE_AGENTS a incluir claude:deepseek
 * e a chave no Gestor de Credenciais (solline/deepseek) ou em DEEPSEEK_API_KEY.
 * Corre também em cada subida do Agent SDK: o perfil não tem suporte oficial e pode partir.
 */
const skip = !realAgents().has('claude:deepseek');
const T = 180_000;

describe.skipIf(skip)('DeepSeek pelo Claude Code (real)', () => {
  let cwd: string;
  let dataDir: string;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'solline-ds-'));
    dataDir = await mkdtemp(path.join(tmpdir(), 'solline-ds-data-'));
    await writeFile(path.join(cwd, 'notes.txt'), 'The quick alpha fox.\n');
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it(
    'responde, edita com cartão de permissão e mostra tokens sem custo',
    { timeout: T },
    async () => {
      const events: EngineEvent[] = [];
      const definition = profileDefinition(DEEPSEEK, { dataDir, isolated: true });
      const manager = new SessionManager({
        emit: (e) => events.push(e),
        registry: registryOf([definition]),
      });
      const ends = () =>
        events.filter((e) => e.type === 'session.event' && e.delta.type === 'turn.end').length;
      try {
        const { session, capabilities } = await manager.create({
          projectId: 'p',
          agent: 'claude:deepseek',
          cwd,
          trusted: true,
        });
        console.info('[deepseek] modelos', JSON.stringify(capabilities.models));
        await manager.send(
          session.id,
          'Read notes.txt, then use the Edit tool to replace "alpha" with "beta". Reply in one sentence.',
        );
        await waitFor(() => events.some((e) => e.type === 'permission.request'), T);
        const ask = events.find((e) => e.type === 'permission.request');
        if (ask?.type !== 'permission.request') throw new Error('sem pedido');
        expect(ask.request).toMatchObject({ kind: 'permission', alwaysScope: 'session' });
        manager.answer(session.id, ask.request.id, { decision: 'allow-once' });
        await waitFor(() => ends() >= 1, T);

        expect(await readFile(path.join(cwd, 'notes.txt'), 'utf8')).toContain('beta');
        const usage = events.flatMap((e) =>
          e.type === 'session.event' && e.delta.type === 'usage' ? [e.delta.usage] : [],
        );
        console.info('[deepseek] uso', JSON.stringify(usage.at(-1)));
        expect(usage.some((u) => u.tokens)).toBe(true);
        expect(usage.every((u) => !('costUsd' in u))).toBe(true);
        const deltas = events.flatMap((e) => (e.type === 'session.event' ? [e.delta] : []));
        const text = reduce(deltas)
          .flatMap((t) => t.blocks)
          .filter((b) => b.kind === 'text');
        expect(text.length).toBeGreaterThan(0);
      } finally {
        await manager.disposeAll();
      }
    },
  );
});
