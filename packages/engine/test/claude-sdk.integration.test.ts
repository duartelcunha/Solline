import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter } from '../src/index.ts';
import { recordingSink, reduce, waitFor } from './helpers.ts';

/**
 * Sessão real com o Claude: Haiku, effort low, num projeto temporário e sem as definições
 * do utilizador. Lê um ficheiro, pede permissão para o editar (o teste aceita uma vez),
 * edita e termina com result. Saltar com SOLLINE_SKIP_SDK=1.
 */
const skip = process.env.SOLLINE_SKIP_SDK === '1';

describe.skipIf(skip)('ClaudeSdkAdapter (SDK real)', () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'solline-it-'));
    await writeFile(path.join(cwd, 'notes.txt'), 'The quick alpha fox.\n');
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  });

  it('lê, pede permissão, edita e acaba com custo', { timeout: 240_000 }, async () => {
    const sink = recordingSink();
    const adapter = new ClaudeSdkAdapter({ cwd, mode: 'default', loadSettings: false }, sink);
    try {
      const started = await adapter.start();
      expect(started.capabilities.models.some((m) => m.id === 'haiku')).toBe(true);
      // Os comandos dos botões: modelo e effort mudam antes da primeira mensagem.
      await adapter.setModel('haiku');
      await adapter.setEffort('low');

      const ask = sink.nextAsk();
      await adapter.send(
        'Read notes.txt, then use the Edit tool to replace the word "alpha" with "beta". Reply with one short sentence.',
      );
      const request = await ask;
      expect(request).toMatchObject({ kind: 'permission', toolName: 'Edit' });
      expect(adapter.answerPermission(request.id, { decision: 'allow-once' })).toBe(true);

      await waitFor(() => sink.deltas.some((d) => d.type === 'turn.end'), 200_000);
      await waitFor(() => sink.deltas.some((d) => d.type === 'usage' && d.usage.context), 15_000);

      const turns = reduce(sink.deltas);
      const assistant = turns.find((t) => t.role === 'assistant');
      const tools = assistant?.blocks.filter((b) => b.kind === 'tool') ?? [];
      expect(tools.map((t) => (t.kind === 'tool' ? [t.name, t.state] : []))).toEqual(
        expect.arrayContaining([
          ['Read', 'ok'],
          ['Edit', 'ok'],
        ]),
      );
      const end = sink.deltas.find((d) => d.type === 'turn.end');
      expect(end).toMatchObject({ outcome: 'done' });

      const usage = sink.deltas.filter((d) => d.type === 'usage');
      const cost = usage
        .map((d) => (d.type === 'usage' ? d.usage.costUsd : undefined))
        .find((c) => c != null);
      const context = usage
        .map((d) => (d.type === 'usage' ? d.usage.context : undefined))
        .find(Boolean);
      const settings = sink.deltas.filter((d) => d.type === 'settings');
      console.info(
        '[integração]',
        JSON.stringify({
          cost,
          context,
          settings: settings.map((d) => d.type === 'settings' && d.settings),
        }),
      );
      expect(cost).toBeGreaterThan(0);
      expect(context?.usedTokens).toBeGreaterThan(0);
      expect(settings).toContainEqual({
        type: 'settings',
        settings: expect.objectContaining({ model: expect.stringMatching(/haiku/) }),
      });
      expect(await readFile(path.join(cwd, 'notes.txt'), 'utf8')).toContain('beta');
      expect(sink.states.at(-1)?.state).toBe('idle');
    } finally {
      await adapter.close();
    }
  });
});
